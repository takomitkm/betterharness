//! Composer Bridge 协议（PRODUCT-LINE-PLAN Phase 2）——Rust 侧权威 DTO 与 Bridge 内核。
//!
//! 设计决定见 docs/goal-log/decisions/D002-bridge-protocol-design.md。要点：
//! - **协议不是内部类型的直通**：DTO 独立定义（serde JSON 形状 = TS 生成类型的契约），
//!   内部 ↔ DTO 映射集中在本 crate，Web（wasm-bindgen）与 Desktop（Tauri IPC）共用；
//! - **revision 每次快照发射必增**（保守正确：UI 只忽略过期快照，不误丢）；
//! - **Effect 引用配对**：除 Cancel* 外每个 Effect 带 ref_id，ack 幂等——重复/未知引用
//!   显式报错，成功回执从 pending 摘除后映射回 runtime 事件；
//! - **UI 事件面收窄**：dispatch 只收用户可发的事件（Edit/Submit/轮次/Restore/Retry/
//!   Remove/Flush/Resume/Close）；回执类事件（Persisted/DeliverResult/AttemptTimeout/
//!   LookupResult）只能经 ackEffect 进入——杜绝 UI 伪造投递结果。

use composer_core::ids::{AttemptId, Delivery, DeliveryResult, MessageId, TurnId};
use composer_core::state::{ScopeState, Snapshot};
use composer_runtime::{BusyEnter, Clock, Effect, Event, IdGen, Runtime, RuntimeConfig};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// 协议版本：DTO 形状变化必须递增，宿主按此兼容。
pub const PROTOCOL_VERSION: u32 = 1;

// ————— DTO —————

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BusyEnterDto {
    Queue,
    Steer,
}

impl From<BusyEnter> for BusyEnterDto {
    fn from(value: BusyEnter) -> Self {
        match value {
            BusyEnter::Queue => BusyEnterDto::Queue,
            BusyEnter::Steer => BusyEnterDto::Steer,
        }
    }
}

impl From<BusyEnterDto> for BusyEnter {
    fn from(value: BusyEnterDto) -> Self {
        match value {
            BusyEnterDto::Queue => BusyEnter::Queue,
            BusyEnterDto::Steer => BusyEnter::Steer,
        }
    }
}

/// 完整业务快照（v1 全量；PRODUCT-LINE-PLAN §5.5：除非性能数据证明，不上增量）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotDto {
    pub protocol_version: u32,
    /// Bridge 级单调递增：每次快照发射 +1（见 D002）。
    pub revision: u64,
    pub admitting: bool,
    pub paused: bool,
    pub closed: bool,
    pub busy_mode: BusyEnterDto,
    pub pending_receipt_count: usize,
    pub state: ScopeState,
}

/// UI 可发的事件（窄面；回执类事件只能经 ack）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ComposerEventDto {
    /// 编辑草稿正文（v1 仅文本；有序文档/附件身份走后续扩展，见 D002 边界）。
    Edit {
        text: String,
    },
    Submit,
    SetBusyMode {
        mode: BusyEnterDto,
    },
    BeginTurn {
        turn_id: String,
    },
    EndTurn {
        turn_id: String,
    },
    Restore {
        id: String,
    },
    Retry {
        id: String,
    },
    Remove {
        id: String,
    },
    Flush,
    Resume,
    Close,
}

/// Effect 的协议形状（内部 Effect 的镜像；字段语义见 composer-runtime）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EffectDto {
    Persist {
        state: ScopeState,
    },
    Deliver {
        id: String,
        attempt: String,
        delivery: Delivery,
        turn: Option<String>,
    },
    ScheduleTimeout {
        id: String,
        attempt: String,
        deadline_ms: u64,
    },
    CancelTimeout {
        id: String,
        attempt: String,
    },
    Lookup {
        id: String,
    },
    CancelAllLookups,
}

/// Effect 回执（宿主 → Core）。Cancel* 不需要回执（fire-and-forget）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum EffectOutcomeDto {
    /// Persist 结果：ok=false 即 CAS 冲突或写失败（FM14）。
    Persisted { ok: bool },
    /// Deliver 结果：错误已在宿主侧转成 Uncertain，Core 不见裸异常（FM03）。
    Delivered { result: DeliveryResult },
    /// ScheduleTimeout 到期。
    TimedOut,
    /// Lookup 结果。
    LookupReturned { result: DeliveryResult },
}

/// 带引用的 Effect：宿主执行完必须 ack（Cancel* 除外——不产生引用）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectRefDto {
    pub ref_id: u64,
    pub effect: EffectDto,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DispatchResultDto {
    pub snapshot: SnapshotDto,
    pub effects: Vec<EffectRefDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckError {
    /// 引用不存在（从未发出 / 已回执）。
    UnknownRef,
    /// 回执与该 Effect 类型不匹配。
    OutcomeMismatch,
}

// ————— Bridge 内核 —————

/// 内部 Effect 的克隆载体（Effect 含 ScopeState，可克隆）。
type PendingEffect = Effect;

struct FnClock(Mutex<Box<dyn Fn() -> u64 + Send>>);
impl Clock for FnClock {
    fn now_ms(&self) -> u64 {
        (self.0.lock().unwrap())()
    }
}

struct FnIds(Mutex<Box<dyn FnMut() -> String + Send>>);
impl IdGen for FnIds {
    fn next_id(&mut self) -> String {
        (self.0.lock().unwrap())()
    }
}

/// Bridge 内核：包住 [`Runtime`]，提供 DTO 面（dispatch/ack/snapshot）。
/// 单实例调用必须串行（PRODUCT-LINE-PLAN §5.3）；本结构不做内部加锁，
/// 并发串行化由宿主桥（wasm 单线程 / Tauri command 队列）保证。
pub struct BridgeCore {
    runtime: Runtime,
    clock: Arc<FnClock>,
    ids: Arc<Mutex<FnIds>>,
    revision: u64,
    next_ref: u64,
    /// ref_id → 原始内部 Effect（ack 时提取 id/attempt 并回填 runtime 事件）。
    pending: BTreeMap<u64, PendingEffect>,
}

impl BridgeCore {
    /// clock：注入时钟（Web 建议 performance.now() 基准，防系统回拨）。
    /// ids：注入身份生成（Web 用 crypto.randomUUID，Desktop 用宿主生成）。
    pub fn new(
        config: RuntimeConfig,
        state: ScopeState,
        clock: Box<dyn Fn() -> u64 + Send>,
        ids: Box<dyn FnMut() -> String + Send>,
    ) -> Self {
        BridgeCore {
            runtime: Runtime::restore_from_persisted(config, state),
            clock: Arc::new(FnClock(Mutex::new(clock))),
            ids: Arc::new(Mutex::new(FnIds(Mutex::new(ids)))),
            revision: 0,
            next_ref: 0,
            pending: BTreeMap::new(),
        }
    }

    /// 当前快照（不推进状态）。
    pub fn snapshot(&self) -> SnapshotDto {
        self.emit_snapshot()
    }

    /// UI 事件入口。
    pub fn dispatch(&mut self, event: ComposerEventDto) -> DispatchResultDto {
        let internal = self.map_event(event);
        self.run(internal)
    }

    /// Effect 回执入口（幂等：重复/未知引用显式报错，不重复提交事务）。
    pub fn ack(
        &mut self,
        ref_id: u64,
        outcome: EffectOutcomeDto,
    ) -> Result<DispatchResultDto, AckError> {
        let effect = self.pending.remove(&ref_id).ok_or(AckError::UnknownRef)?;
        let internal = map_outcome(&effect, outcome).ok_or(AckError::OutcomeMismatch)?;
        Ok(self.run(internal))
    }

    /// 当前未回执的引用数（dispose/诊断用）。
    pub fn pending_effect_count(&self) -> usize {
        self.pending.len()
    }

    // ————— 内部 —————

    fn run(&mut self, event: Event) -> DispatchResultDto {
        let clock = self.clock.clone();
        let ids = self.ids.clone();
        let mut ids_guard = ids.lock().unwrap();
        let effects = self.runtime.step(event, &*clock, &mut *ids_guard);
        drop(ids_guard);
        self.revision += 1; // 每次快照发射必增（D002：保守正确）。
        let refs = effects
            .into_iter()
            .map(|effect| self.assign_ref(effect))
            .collect();
        DispatchResultDto {
            snapshot: self.emit_snapshot(),
            effects: refs,
        }
    }

    fn assign_ref(&mut self, effect: Effect) -> EffectRefDto {
        match effect_needs_ref(&effect) {
            false => EffectRefDto {
                ref_id: 0,
                effect: to_dto(effect),
            },
            true => {
                self.next_ref += 1;
                let ref_id = self.next_ref;
                self.pending.insert(ref_id, effect.clone());
                EffectRefDto {
                    ref_id,
                    effect: to_dto(effect),
                }
            }
        }
    }

    fn emit_snapshot(&self) -> SnapshotDto {
        SnapshotDto {
            protocol_version: PROTOCOL_VERSION,
            revision: self.revision,
            admitting: self.runtime.is_admitting(),
            paused: self.runtime.is_paused(),
            closed: self.runtime.is_closed(),
            busy_mode: self.runtime.busy_mode().into(),
            pending_receipt_count: self.runtime.pending_receipt_count(),
            state: self.runtime.state().clone(),
        }
    }

    fn map_event(&self, event: ComposerEventDto) -> Event {
        match event {
            ComposerEventDto::Edit { text } => Event::Edit {
                snapshot: Snapshot::text(text),
            },
            ComposerEventDto::Submit => Event::Submit,
            ComposerEventDto::SetBusyMode { mode } => Event::SetBusyMode(mode.into()),
            ComposerEventDto::BeginTurn { turn_id } => Event::BeginTurn(TurnId::new(turn_id)),
            ComposerEventDto::EndTurn { turn_id } => Event::EndTurn(TurnId::new(turn_id)),
            ComposerEventDto::Restore { id } => Event::Restore {
                id: MessageId::new(id),
            },
            ComposerEventDto::Retry { id } => Event::Retry {
                id: MessageId::new(id),
            },
            ComposerEventDto::Remove { id } => Event::Remove {
                id: MessageId::new(id),
            },
            ComposerEventDto::Flush => Event::Flush,
            ComposerEventDto::Resume => Event::Resume,
            ComposerEventDto::Close => Event::Close,
        }
    }
}

/// 只有需要宿主回执的 Effect 拿引用；Cancel* 是 fire-and-forget。
fn effect_needs_ref(effect: &Effect) -> bool {
    matches!(
        effect,
        Effect::Persist(_)
            | Effect::Deliver { .. }
            | Effect::ScheduleTimeout { .. }
            | Effect::Lookup { .. }
    )
}

/// 内部 Effect → DTO（内部强类型 id → 字符串）。
fn to_dto(effect: Effect) -> EffectDto {
    match effect {
        Effect::Persist(state) => EffectDto::Persist { state: *state },
        Effect::Deliver {
            id,
            attempt,
            delivery,
            turn,
        } => EffectDto::Deliver {
            id: id.to_string(),
            attempt: attempt.to_string(),
            delivery,
            turn: turn.map(|turn| turn.to_string()),
        },
        Effect::ScheduleTimeout {
            id,
            attempt,
            deadline_ms,
        } => EffectDto::ScheduleTimeout {
            id: id.to_string(),
            attempt: attempt.to_string(),
            deadline_ms,
        },
        Effect::CancelTimeout { id, attempt } => EffectDto::CancelTimeout {
            id: id.to_string(),
            attempt: attempt.to_string(),
        },
        Effect::Lookup { id } => EffectDto::Lookup { id: id.to_string() },
        Effect::CancelAllLookups => EffectDto::CancelAllLookups,
    }
}

/// 回执 + 原始 Effect → runtime 事件。形状不匹配返回 None（OutcomeMismatch）。
fn map_outcome(effect: &Effect, outcome: EffectOutcomeDto) -> Option<Event> {
    match (effect, outcome) {
        (Effect::Persist(_), EffectOutcomeDto::Persisted { ok }) => Some(Event::Persisted { ok }),
        (Effect::Deliver { id, attempt, .. }, EffectOutcomeDto::Delivered { result }) => {
            Some(Event::DeliverResult {
                id: MessageId::new(id.as_str()),
                attempt: AttemptId::new(attempt.as_str()),
                result,
            })
        }
        (Effect::ScheduleTimeout { id, attempt, .. }, EffectOutcomeDto::TimedOut) => {
            Some(Event::AttemptTimeout {
                id: MessageId::new(id.as_str()),
                attempt: AttemptId::new(attempt.as_str()),
            })
        }
        (Effect::Lookup { id }, EffectOutcomeDto::LookupReturned { result }) => {
            Some(Event::LookupResult {
                id: MessageId::new(id.as_str()),
                result,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_core::ids::{Receipt, ScopeId, Status};

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            scope: ScopeId::new("demo/main"),
            send_timeout_ms: 1500,
        }
    }

    fn bridge() -> BridgeCore {
        BridgeCore::new(
            config(),
            ScopeState::new(
                ScopeId::new("demo/main"),
                composer_core::ids::GenerationId::new("gen-0"),
            ),
            Box::new(|| 100),
            Box::new(|| {
                use std::sync::atomic::{AtomicU32, Ordering};
                static N: AtomicU32 = AtomicU32::new(0);
                format!("id-{}", N.fetch_add(1, Ordering::SeqCst))
            }),
        )
    }

    fn accepted(id: &str, turn: &str) -> DeliveryResult {
        DeliveryResult::Accepted {
            receipt: Receipt {
                id: MessageId::new(id),
                scope: ScopeId::new("demo/main"),
                turn: TurnId::new(turn),
            },
        }
    }

    /// BM01：Edit → Persist 引用 → ack(ok)；快照 revision 单调递增。
    #[test]
    fn bm01_edit_persist_ack_revision_monotonic() {
        let mut bridge = bridge();
        let first = bridge.snapshot();
        assert_eq!(first.revision, 0);
        let result = bridge.dispatch(ComposerEventDto::Edit { text: "A".into() });
        assert_eq!(result.snapshot.revision, 1, "每次发射必增");
        assert_eq!(result.effects.len(), 1);
        assert!(matches!(
            result.effects[0].effect,
            EffectDto::Persist { .. }
        ));
        assert_eq!(result.effects[0].ref_id, 1);
        assert_eq!(bridge.pending_effect_count(), 1);
        let second = bridge
            .ack(1, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        assert_eq!(second.snapshot.revision, 2);
        assert_eq!(second.effects.len(), 0, "无 queued 时 pump 不派发");
        assert_eq!(bridge.pending_effect_count(), 0);
        assert!(bridge.snapshot().revision > first.revision);
    }

    /// BM02：提交全链路——Edit→Submit(Persist)→ack→Deliver+ScheduleTimeout→ack
    /// accepted→Persist→ack：状态 Accepted，outbox 可见（首要交付链路的服务器侧）。
    #[test]
    fn bm02_submit_chain_through_refs() {
        let mut bridge = bridge();
        bridge.dispatch(ComposerEventDto::Edit { text: "A".into() });
        bridge
            .ack(1, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        let submit = bridge.dispatch(ComposerEventDto::Submit);
        assert!(submit.snapshot.admitting, "交接窗口只读（FM07）");
        let persist_ref = submit
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Persist { .. }))
            .unwrap();
        let delivered = bridge
            .ack(persist_ref.ref_id, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        // pump 派发：Deliver + ScheduleTimeout 两引用。
        let deliver_ref = delivered
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Deliver { .. }))
            .expect("派发引用");
        let timeout_ref = delivered
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::ScheduleTimeout { .. }))
            .expect("超时引用");
        assert!(delivered.snapshot.revision > submit.snapshot.revision);
        let message_id = match &deliver_ref.effect {
            EffectDto::Deliver { id, .. } => id.clone(),
            _ => unreachable!(),
        };
        // 回执 Deliver：accepted。
        let settled = bridge
            .ack(
                deliver_ref.ref_id,
                EffectOutcomeDto::Delivered {
                    result: accepted(&message_id, "turn-1"),
                },
            )
            .unwrap();
        assert!(
            settled
                .effects
                .iter()
                .any(|effect| matches!(effect.effect, EffectDto::Persist { .. })),
            "回执先落盘（FM23）"
        );
        // 落盘 ack + 超时取消语义：结果已到，宿主应处理 ScheduleTimeout（这里回 TimedOut 前先验证状态）。
        assert_eq!(
            settled.snapshot.state.submissions[0].status,
            Status::Accepted,
            "settle 内存即时生效；Persist = 落盘义务（失败走 pending+flush，FM23）"
        );
        let cleared = bridge
            .ack(
                settled.effects[0].ref_id,
                EffectOutcomeDto::Persisted { ok: true },
            )
            .unwrap();
        assert_eq!(
            cleared.snapshot.state.submissions[0].status,
            Status::Accepted
        );
        assert_eq!(
            cleared.snapshot.state.draft.snapshot.text, "",
            "后继空草稿（FM01）"
        );
        assert_eq!(cleared.snapshot.pending_receipt_count, 0);
        // 未回执的超时引用仍在册（宿主 CancelTimeout 后自行丢弃）。
        assert_eq!(
            bridge.pending_effect_count(),
            1,
            "只剩 ScheduleTimeout 引用"
        );
        let _ = timeout_ref;
    }

    /// BM03：ack 幂等——重复引用 UnknownRef；形状不匹配 OutcomeMismatch。
    #[test]
    fn bm03_ack_is_idempotent_guarded() {
        let mut bridge = bridge();
        bridge.dispatch(ComposerEventDto::Edit { text: "A".into() });
        let err = bridge
            .ack(1, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        let _ = err;
        // 同一引用再 ack：已摘除 → UnknownRef（不重复提交事务）。
        assert_eq!(
            bridge.ack(1, EffectOutcomeDto::Persisted { ok: true }),
            Err(AckError::UnknownRef)
        );
        assert_eq!(
            bridge.ack(99, EffectOutcomeDto::Persisted { ok: true }),
            Err(AckError::UnknownRef)
        );
        // 形状不匹配：Persist 引用回 Delivered。
        bridge.dispatch(ComposerEventDto::Edit { text: "B".into() });
        assert_eq!(
            bridge.ack(
                2,
                EffectOutcomeDto::Delivered {
                    result: accepted("x", "t")
                }
            ),
            Err(AckError::OutcomeMismatch)
        );
    }

    /// BM04：超时路径——ScheduleTimeout ack TimedOut → unknown（FM04），阻塞队列（FM09）。
    #[test]
    fn bm04_timeout_leads_to_uncertain_and_blocks() {
        let mut bridge = bridge();
        bridge.dispatch(ComposerEventDto::Edit { text: "A".into() });
        bridge
            .ack(1, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        let submit = bridge.dispatch(ComposerEventDto::Submit);
        let persist_ref = submit
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Persist { .. }))
            .unwrap();
        let delivered = bridge
            .ack(persist_ref.ref_id, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        let timeout_ref = delivered
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::ScheduleTimeout { .. }))
            .unwrap();
        let attempt = match &timeout_ref.effect {
            EffectDto::ScheduleTimeout { attempt, .. } => attempt.clone(),
            _ => unreachable!(),
        };
        let _ = attempt;
        let timed_out = bridge
            .ack(timeout_ref.ref_id, EffectOutcomeDto::TimedOut)
            .unwrap();
        let persist_ref = timed_out
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Persist { .. }))
            .unwrap();
        let cleared = bridge
            .ack(persist_ref.ref_id, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        assert_eq!(
            cleared.snapshot.state.submissions[0].status,
            Status::Uncertain
        );
        assert!(cleared.snapshot.state.submissions[0]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("超时"));
        // unknown 阻塞：再提交 B 也不派发（FM09）。每次内容变更都有 Persist 引用。
        let edited = bridge.dispatch(ComposerEventDto::Edit { text: "B".into() });
        let persist_b = edited
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Persist { .. }))
            .unwrap();
        bridge
            .ack(persist_b.ref_id, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        let submit_b = bridge.dispatch(ComposerEventDto::Submit);
        let persist_s = submit_b
            .effects
            .iter()
            .find(|effect| matches!(effect.effect, EffectDto::Persist { .. }))
            .unwrap();
        let after = bridge
            .ack(persist_s.ref_id, EffectOutcomeDto::Persisted { ok: true })
            .unwrap();
        assert!(
            after
                .effects
                .iter()
                .all(|effect| !matches!(effect.effect, EffectDto::Deliver { .. })),
            "unknown 阻塞派发"
        );
    }

    /// BM05：DTO JSON 形状稳定（TS 生成类型的契约）——tag 命名与字段形状冻结。
    #[test]
    fn bm05_dto_json_shapes_are_stable() {
        let event = serde_json::to_value(ComposerEventDto::Submit).unwrap();
        assert_eq!(event, serde_json::json!({ "type": "submit" }));
        let event = serde_json::to_value(ComposerEventDto::Edit { text: "hi".into() }).unwrap();
        assert_eq!(event, serde_json::json!({ "type": "edit", "text": "hi" }));
        let outcome = serde_json::to_value(EffectOutcomeDto::Persisted { ok: true }).unwrap();
        assert_eq!(
            outcome,
            serde_json::json!({ "outcome": "persisted", "ok": true })
        );
        let effect = serde_json::to_value(EffectDto::CancelAllLookups).unwrap();
        assert_eq!(effect, serde_json::json!({ "type": "cancel_all_lookups" }));
        let busy = serde_json::to_value(BusyEnterDto::Queue).unwrap();
        assert_eq!(busy, serde_json::json!("queue"));
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    /// BM06：Close 出 CancelAllLookups（无引用，fire-and-forget），closed 后拒绝一切。
    #[test]
    fn bm06_close_emits_unreferenced_cancel() {
        let mut bridge = bridge();
        let result = bridge.dispatch(ComposerEventDto::Close);
        assert!(result
            .effects
            .iter()
            .any(|effect| matches!(effect.effect, EffectDto::CancelAllLookups)));
        assert!(
            result.effects.iter().all(|effect| effect.ref_id == 0),
            "Cancel* 无引用"
        );
        assert_eq!(bridge.pending_effect_count(), 0);
        let after = bridge.dispatch(ComposerEventDto::Edit { text: "X".into() });
        assert!(after.effects.is_empty(), "关闭后一切被拒");
        assert_eq!(after.snapshot.state.draft.snapshot.text, "");
    }
}
