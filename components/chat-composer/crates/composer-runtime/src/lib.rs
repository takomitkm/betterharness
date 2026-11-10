//! composer-runtime：引擎的事件/效果协议（计划书 §4 Composition Runtime 的执行侧）。
//!
//! **Durable/Live 边界（DSH 模式 C）**：状态只活在 `ScopeState`（Session Events 的载体，
//! 每次变更出 [`Effect::Persist`]）；事件总线级别的瞬时协作不属于本 crate。
//! 平台适配层（app-web / 原生宿主）只做两件事——把用户/平台事件喂给 [`Runtime::step`]，
//! 按顺序执行返回的 [`Effect`]（落盘、派发、定时器），再把结果以事件喂回。
//!
//! 对比来源（每条纪律都标注学谁的、对应哪条已验证行为）：
//! - **archive/ts core.ts（自家最强持久化）**：交接与后继空草稿同一次持久化（FM01）；
//!   迟到结果不擦新草稿（FM02）；异常即 unknown 不自动重发（FM03）；超时只释放自己的
//!   attempt（FM04）；unknown 阻塞队列且禁 retry/restore/remove（FM05/09/21）；CAS 冲突
//!   暂停且保留本地输入（FM14）；回执落盘失败留在本地等 flush 且绝不重发（FM23/24）；
//!   终态才可删（FM21）；
//! - **DSH（fcc0ad4）**：admitting 窗口 = 本地落盘只读、网络等待可编辑（FM07，DSH
//!   SubmitMachine 的 accept-on-host-admission 边界）；busyEnter 用户可配 queue/steer、
//!   加速键取反（submission-policy.ts 的 resolveSubmitMode）；
//! - **Telegram**：断网自动补发是 at-least-once——**不采纳**，unknown 纪律优先；
//! - **SillyTavern**：排队靠第三方扩展——这里内建（轮次推进 FM12/13）。

use composer_core::ids::{
    AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, Status, TurnId,
};
use composer_core::state::{ScopeState, Snapshot};

/// 用户可配置的忙时投递偏好（DSH busyEnter 语义）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusyEnter {
    Queue,
    Steer,
}

/// 平台时钟：宿主注入，引擎不取系统时间。
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// 身份生成（消息/attempt/generation）。宿主可用 UUID 或计数器。
pub trait IdGen {
    fn next_id(&mut self) -> String;
}

/// 宿主喂给引擎的事件（Live 侧入口；状态变更只经这里）。
#[derive(Clone, Debug)]
pub enum Event {
    /// 编辑当前草稿（admitting 窗口内被拒——本地落盘的短暂只读）。
    Edit {
        snapshot: Snapshot,
    },
    /// 提交当前草稿（busy 模式决定 start/steer/none）。
    Submit,
    SetBusyMode(BusyEnter),
    /// [`Effect::Persist`] 的结果：ok=false 即 CAS 冲突或写失败。
    Persisted {
        ok: bool,
    },
    /// 传输结果（错误已在平台侧转成 [`DeliveryResult::Uncertain`]）。
    DeliverResult {
        id: MessageId,
        attempt: AttemptId,
        result: DeliveryResult,
    },
    /// [`Effect::ScheduleTimeout`] 到期。
    AttemptTimeout {
        id: MessageId,
        attempt: AttemptId,
    },
    /// [`Effect::Lookup`] 的结果。
    LookupResult {
        id: MessageId,
        result: DeliveryResult,
    },
    BeginTurn(TurnId),
    EndTurn(TurnId),
    /// 把 queued/rejected 的完整快照取回空草稿（逐条取回 + ArrowUp 同源）。
    Restore {
        id: MessageId,
    },
    Retry {
        id: MessageId,
    },
    Remove {
        id: MessageId,
    },
    /// 重试本地落盘：先补齐草稿，再逐条重放未落盘的回执（绝不重发）。
    Flush,
    /// 解除 CAS 冲突暂停。
    Resume,
    Close,
}

/// 引擎要求平台执行的动作（Durable 侧出口）。顺序即契约：`Persist` 先于同批 `Deliver`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// 把整个 scope 原子落盘（CAS：revision 相符才写）。完成后必须回 `Persisted`。
    Persist(Box<ScopeState>),
    /// 派发一次投递。结果（无论成败）回 `DeliverResult`；平台不许自行重试。
    Deliver {
        id: MessageId,
        attempt: AttemptId,
        delivery: Delivery,
        turn: Option<TurnId>,
    },
    /// 到期回 `AttemptTimeout`。
    ScheduleTimeout {
        id: MessageId,
        attempt: AttemptId,
        deadline_ms: u64,
    },
    /// 取消该 attempt 的超时（结果先到时）。
    CancelTimeout { id: MessageId, attempt: AttemptId },
    /// 查询一条 unknown 的送达状态。结果回 `LookupResult`。
    Lookup { id: MessageId },
    /// 关闭时取消全部查询（FM18：不等待不合作的查询）。
    CancelAllLookups,
}

#[derive(Clone, Debug)]
struct PendingReceipt {
    attempt: Option<AttemptId>,
    result: DeliveryResult,
}

/// 引擎不可变配置。
#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub scope: composer_core::ids::ScopeId,
    pub send_timeout_ms: u64,
}

/// 引擎运行时：持久状态 + 进程内瞬时状态。
pub struct Runtime {
    state: ScopeState,
    config: RuntimeConfig,
    busy_mode: BusyEnter,
    /// 本地落盘窗口（FM07）：短暂只读，网络等待期照常可编辑。
    admitting: bool,
    /// CAS 冲突/写失败后的暂停（FM14）。
    paused: bool,
    closed: bool,
    /// 在途投递（同时只有一条：unknown/sending 阻塞队列）。
    inflight: Option<(MessageId, AttemptId)>,
    /// 回执已到但尚未可靠落盘（FM23）：flush 重放，绝不重发。
    pending_receipts: Vec<(MessageId, PendingReceipt)>,
}

impl Runtime {
    /// 从已持久化的状态恢复（FM09）：中断在 sending 的消息转为 unknown——
    /// 可能已送达，绝自动重发；更新的草稿原样保留。
    pub fn restore_from_persisted(config: RuntimeConfig, mut state: ScopeState) -> Self {
        for record in &mut state.submissions {
            if record.status == Status::Sending {
                record.status = Status::Uncertain;
                record.reason = Some("进程中断，送达待确认".into());
                record.attempt = None;
            }
        }
        Runtime {
            state,
            config,
            busy_mode: BusyEnter::Queue,
            admitting: false,
            paused: false,
            closed: false,
            inflight: None,
            pending_receipts: Vec::new(),
        }
    }

    pub fn state(&self) -> &ScopeState {
        &self.state
    }

    pub fn is_admitting(&self) -> bool {
        self.admitting
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn busy_mode(&self) -> BusyEnter {
        self.busy_mode
    }

    /// 尚未可靠落盘的回执数（UI 提示「重试本地保存」）。
    pub fn pending_receipt_count(&self) -> usize {
        self.pending_receipts.len()
    }

    /// 引擎主入口：一个事件进，一批效果出。顺序即契约。
    pub fn step(&mut self, event: Event, clock: &dyn Clock, ids: &mut dyn IdGen) -> Vec<Effect> {
        let mut effects: Vec<Effect> = Vec::new();
        let mut dirty = false;
        match event {
            Event::Edit { snapshot } => {
                // FM07：admitting 窗口只读（本地持久化，绝不是网络或模型回合）。
                if self.closed || self.admitting {
                    return effects;
                }
                self.state.edit(snapshot);
                dirty = true;
            }
            Event::Submit => {
                if self.closed || self.admitting || self.inflight.is_some() {
                    return effects;
                }
                if !self.state.draft.snapshot.has_content() {
                    return effects; // FD06：空草稿在 submit 处被拒。
                }
                if self.state.active_turn.is_some() && self.busy_mode == BusyEnter::Queue {
                    // 忙时排队：消息入队，本轮结束后由 pump 派发（FM11/12）。
                }
                let delivery = match (self.state.active_turn.is_some(), self.busy_mode) {
                    (true, BusyEnter::Steer) => Delivery::Steer,
                    _ => Delivery::Start,
                };
                let message = MessageId::new(ids.next_id());
                let generation = GenerationId::new(ids.next_id());
                let now = clock.now_ms();
                // 交接 + 后继空草稿是同一次状态变更（FM01：一个持久化事务）。
                match self.state.handoff(message, generation, delivery, now) {
                    Err(_) => return effects,
                    Ok(_) => {
                        self.admitting = true;
                        dirty = true;
                    }
                }
            }
            Event::SetBusyMode(mode) => self.busy_mode = mode,
            Event::Persisted { ok } => {
                if !ok {
                    // FM14：CAS 冲突暂停自动投递；本地输入与未落盘回执全部保留（FM23/24）。
                    self.paused = true;
                    self.admitting = false;
                    return effects;
                }
                self.admitting = false;
                // 落盘成功：本批回执解除暂扣（FM23 闭环）。
                self.pending_receipts.clear();
                self.pump(clock, ids, &mut effects, &mut dirty);
            }
            Event::DeliverResult {
                id,
                attempt,
                result,
            } => {
                if self.closed {
                    return effects;
                }
                if self
                    .inflight
                    .as_ref()
                    .is_some_and(|(in_id, in_attempt)| *in_id == id && *in_attempt == attempt)
                {
                    self.inflight = None;
                }
                self.settle(id, Some(attempt), result, &mut effects, &mut dirty);
            }
            Event::AttemptTimeout { id, attempt } => {
                // FM04：超时只结算自己的 attempt；迟到回执保留新草稿。
                if self
                    .inflight
                    .as_ref()
                    .is_some_and(|(in_id, in_attempt)| *in_id == id && *in_attempt == attempt)
                {
                    self.inflight = None;
                }
                let result = DeliveryResult::Uncertain {
                    reason: "确认超时，未自动重发".into(),
                };
                self.settle(id, Some(attempt), result, &mut effects, &mut dirty);
            }
            Event::LookupResult { id, result } => {
                if self.closed {
                    return effects;
                }
                // 用记录当前的 attempt 做身份校验：陈旧查询不得降级新状态（FM25）。
                let attempt = self
                    .state
                    .submissions
                    .iter()
                    .find(|record| record.id == id)
                    .and_then(|record| record.attempt.clone());
                self.settle(id, attempt, result, &mut effects, &mut dirty);
            }
            Event::BeginTurn(turn) => {
                if self.state.begin_turn(turn.clone()) {
                    dirty = true;
                }
            }
            Event::EndTurn(turn) => {
                if self.state.end_turn(&turn) {
                    dirty = true;
                    // FM12：轮次结束后派发下一条排队消息。
                }
            }
            Event::Restore { id } => {
                if self.closed || self.admitting || !self.state.draft.snapshot.is_empty() {
                    return effects; // FM05：取回拒绝覆盖非空草稿（含空白）。
                }
                let generation = GenerationId::new(ids.next_id());
                if self.state.restore(&id, generation).is_ok() {
                    self.admitting = true;
                    dirty = true;
                }
            }
            Event::Retry { id } => {
                if self.closed || self.admitting {
                    return effects;
                }
                if self.state.retry(&id).is_ok() {
                    dirty = true;
                }
            }
            Event::Remove { id } => {
                // FM21：unknown/queued/sending 的载荷继续持有，只有终态可删。
                if self.state.remove(&id).is_ok() {
                    dirty = true;
                }
            }
            Event::Flush => {
                // FM23：重放未落盘回执；不重新派发任何消息。
                let pending = std::mem::take(&mut self.pending_receipts);
                for (id, entry) in pending {
                    self.settle(id, entry.attempt, entry.result, &mut effects, &mut dirty);
                }
                dirty = true;
            }
            Event::Resume => {
                // FM24：恢复后队列从头推进——sending 标记没落盘的会重走持久化 + 派发。
                self.paused = false;
            }
            Event::Close => {
                self.closed = true;
                self.inflight = None;
                effects.push(Effect::CancelAllLookups); // FM18：不等待不合作的查询。
                return effects;
            }
        }
        if dirty {
            // 状态有变更：先落盘（顺序即契约），再在同一批里推进队列产生的派发。
            self.pump(clock, ids, &mut effects, &mut dirty);
            effects.insert(0, Effect::Persist(Box::new(self.state.clone())));
        }
        effects
    }

    /// 队列推进：无阻塞时派发第一条符合条件的 queued（规则本体在 ledger::begin_next）。
    fn pump(
        &mut self,
        clock: &dyn Clock,
        ids: &mut dyn IdGen,
        effects: &mut Vec<Effect>,
        _dirty: &mut bool,
    ) {
        if self.paused || self.closed || self.admitting || self.inflight.is_some() {
            return;
        }
        if self
            .state
            .submissions
            .iter()
            .any(|record| matches!(record.status, Status::Sending | Status::Uncertain))
        {
            return; // unknown/sending 阻塞队列：用户必须先解决（FM05/09）。
        }
        let attempt = AttemptId::new(ids.next_id());
        if let Some((id, attempt, delivery, turn)) = self.state.begin_next(attempt) {
            self.inflight = Some((id.clone(), attempt.clone()));
            let deadline = clock.now_ms() + self.config.send_timeout_ms;
            effects.push(Effect::Deliver {
                id: id.clone(),
                attempt: attempt.clone(),
                delivery,
                turn,
            });
            effects.push(Effect::ScheduleTimeout {
                id,
                attempt,
                deadline_ms: deadline,
            });
        }
    }

    /// 结算一条结果。ledger::settle 保证：迟到 attempt 忽略、终态不可重结算、
    /// rejected 不被 unknown 降级（FM25）、坏回执转 unknown（FM15）。
    /// 这里补回执落盘纪律（FM23）：先暂扣，Persist 成功后由 Persisted 清空。
    fn settle(
        &mut self,
        id: MessageId,
        attempt: Option<AttemptId>,
        result: DeliveryResult,
        effects: &mut Vec<Effect>,
        _dirty: &mut bool,
    ) {
        // 同一条消息的回执已暂扣：以先到者为准（先到回执尚未落盘，后来的旧结果不覆盖）。
        if self
            .pending_receipts
            .iter()
            .any(|(pending_id, _)| *pending_id == id)
        {
            return;
        }
        match self.state.settle(&id, attempt.as_ref(), result.clone()) {
            Err(_) => return, // 陈旧 attempt / 终态重结算 / 已取消：忽略（FM02/04）。
            Ok(_) => {
                self.pending_receipts
                    .push((id, PendingReceipt { attempt, result }));
                effects.push(Effect::Persist(Box::new(self.state.clone())));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_core::ids::{Receipt, ScopeId};
    use std::cell::RefCell;

    // —— 测试脚手架：注入时钟与计数器 ID ——
    struct FixedClock(RefCell<u64>);
    impl Clock for FixedClock {
        fn now_ms(&self) -> u64 {
            *self.0.borrow()
        }
    }
    struct SeqIds(RefCell<u32>);
    impl IdGen for SeqIds {
        fn next_id(&mut self) -> String {
            *self.0.borrow_mut() += 1;
            format!("id-{}", *self.0.borrow())
        }
    }

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            scope: ScopeId::new("demo/main"),
            send_timeout_ms: 1500,
        }
    }

    fn fresh() -> Runtime {
        Runtime::restore_from_persisted(
            config(),
            ScopeState::new(ScopeId::new("demo/main"), GenerationId::new("gen-0")),
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

    fn effect_ids(effects: &[Effect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Deliver { id, .. } => Some(id.to_string()),
                _ => None,
            })
            .collect()
    }

    /// FM01：交接与后继空草稿同一次持久化；UI 在 Persist 前看到 admitting。
    #[test]
    fn fm01_handoff_and_successor_draft_are_one_persist() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(runtime.is_admitting(), "交接窗口内只读");
        let persists = effects
            .iter()
            .filter(|effect| matches!(effect, Effect::Persist(_)))
            .count();
        assert_eq!(persists, 1, "交接与后继空草稿是同一次落盘");
        assert!(runtime.state().draft.snapshot.is_empty(), "后继草稿已就位");
    }

    /// FM02：迟到接纳不擦新草稿 B（B 与 A 同文也不行）。
    #[test]
    fn fm02_late_acceptance_preserves_new_draft() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "admitting 窗口内不派发");
        // 交接后立刻写 B。A 的消息 id 从台账读（交接即入 outbox）。
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id = runtime.state().submissions[0].id.to_string();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("B"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id),
                attempt: AttemptId::new(
                    runtime.state().submissions[0]
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: accepted(&id, "turn-1"),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(runtime.state().draft.snapshot.text, "B", "迟到接纳不擦 B");
        assert_eq!(runtime.state().submissions[0].status, Status::Accepted);
    }

    /// FM03：传输异常即 unknown，不自动重发、不恢复草稿。
    #[test]
    fn fm03_transport_error_is_unknown_no_resend() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(
            effect_ids(&effects).is_empty(),
            "admitting 窗口内不派发（等待本地落盘）"
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: DeliveryResult::Uncertain {
                    reason: "连接重置".into(),
                },
            },
            &clock,
            &mut ids,
        );
        assert_eq!(runtime.state().submissions[0].status, Status::Uncertain);
        // unknown 阻塞队列：下一条不派发。
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("B"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "unknown 阻塞派发");
    }

    /// FM04：超时只结算自己的 attempt；迟到回执保留新草稿。
    #[test]
    fn fm04_timeout_releases_only_its_attempt() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(
            effect_ids(&effects).is_empty(),
            "admitting 窗口内不派发（等待本地落盘）"
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id = runtime.state().submissions.last().unwrap().id.to_string();
        // 超时事件携带别人的 attempt：不得影响在途状态。
        runtime.step(
            Event::AttemptTimeout {
                id: MessageId::new(&id),
                attempt: AttemptId::new("stale"),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(
            runtime.state().submissions[0].status,
            Status::Sending,
            "陈旧超时不结算"
        );
        assert!(runtime.is_admitting() == false);
        // 自己的 attempt 超时 → unknown。
        runtime.step(
            Event::AttemptTimeout {
                id: MessageId::new(&id),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(runtime.state().submissions[0].status, Status::Uncertain);
    }

    /// FM05/09：unknown 禁 retry/restore/remove（载荷必须继续持有）。
    #[test]
    fn fm09_unknown_blocks_retry_restore_remove() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(
            effect_ids(&effects).is_empty(),
            "admitting 窗口内不派发（等待本地落盘）"
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: DeliveryResult::Uncertain {
                    reason: "丢失".into(),
                },
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        // 空 D 草稿 + restore 请求：unknown 不可取回。
        let before = runtime.state().draft.snapshot.text.clone();
        runtime.step(
            Event::Restore {
                id: MessageId::new(&id),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(
            runtime.state().draft.snapshot.text,
            before,
            "unknown 不可取回"
        );
        runtime.step(
            Event::Remove {
                id: MessageId::new(&id),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(runtime.state().submissions.len(), 1, "unknown 不可删");
        runtime.step(
            Event::Retry {
                id: MessageId::new(&id),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(
            runtime.state().submissions[0].status,
            Status::Uncertain,
            "unknown 不可重试"
        );
    }

    /// FM12：轮次推进——queue 模式下 B 排队，end-turn 后派发。
    #[test]
    fn fm12_turn_gate_dispatches_one_queued_per_finished_turn() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "admitting 窗口内不派发");
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id_a = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id_a),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: accepted(&id_a, "turn-1"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        // 轮次运行中提交 B：queue 模式 → 入队不派发。
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("B"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "忙时排队不立即派发");
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        assert_eq!(runtime.state().submissions[1].status, Status::Queued);
        // 结束轮次 → 派发 B：效果里的消息 id 必须是 B，且台账里 B 的 attempt 与之一致。
        let effects = runtime.step(Event::EndTurn(TurnId::new("turn-1")), &clock, &mut ids);
        assert_eq!(
            effect_ids(&effects),
            vec![runtime.state().submissions[1].id.to_string()],
            "派发的是排队中的 B"
        );
        assert_eq!(runtime.state().submissions[1].status, Status::Sending);
    }

    /// FM13：steer 模式直接进当前轮次。
    #[test]
    fn fm13_steer_targets_active_turn() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "admitting 窗口内不派发");
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id_a = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id_a),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: accepted(&id_a, "turn-1"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        runtime.step(Event::SetBusyMode(BusyEnter::Steer), &clock, &mut ids);
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("S"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "admitting 窗口内不派发");
        // 本地落盘完成 → pump 派发，steer 直进当前轮次。
        let effects = runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let delivered = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Deliver { delivery, turn, .. } => {
                    Some((*delivery == Delivery::Steer, turn.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            delivered,
            vec![(true, Some(TurnId::new("turn-1")))],
            "steer 直进当前轮次"
        );
    }

    /// FM14：CAS 冲突 → 暂停 + 保留本地输入；Resume 恢复推进。
    #[test]
    fn fm14_cas_conflict_pauses_and_keeps_local() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Submit, &clock, &mut ids);
        runtime.step(Event::Persisted { ok: false }, &clock, &mut ids);
        assert!(runtime.is_paused(), "CAS 冲突暂停");
        assert_eq!(
            runtime.state().draft.snapshot.text,
            "",
            "交接已发生（内存内），未丢载荷"
        );
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("B"),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(
            runtime.state().draft.snapshot.text,
            "B",
            "暂停期间本地输入保留"
        );
        // 暂停期间不派发。
        let effects = runtime.step(Event::Resume, &clock, &mut ids);
        assert!(
            effect_ids(&effects).is_empty(),
            "无 queued 时 Resume 不派发"
        );
    }

    /// FM23/24：回执落盘失败 → 暂扣 + flush 重放，绝不重发。
    #[test]
    fn fm23_failed_receipt_write_is_retried_locally_without_resend() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(
            effect_ids(&effects).is_empty(),
            "admitting 窗口内不派发（等待本地落盘）"
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: accepted(&id, "turn-1"),
            },
            &clock,
            &mut ids,
        );
        assert_eq!(runtime.pending_receipt_count(), 1, "回执暂扣待落盘");
        // 落盘失败：回执保留。
        runtime.step(Event::Persisted { ok: false }, &clock, &mut ids);
        assert!(runtime.is_paused());
        runtime.step(Event::Resume, &clock, &mut ids);
        // flush：重放回执（DeliverResult 已在引擎内，无需新传输调用）。
        let effects = runtime.step(Event::Flush, &clock, &mut ids);
        assert!(
            effects
                .iter()
                .all(|effect| !matches!(effect, Effect::Deliver { .. })),
            "flush 绝不重发"
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        assert_eq!(runtime.pending_receipt_count(), 0, "落盘成功后清空");
        assert_eq!(runtime.state().submissions[0].status, Status::Accepted);
    }

    /// FM18：close 取消全部查询，不等待。
    #[test]
    fn fm18_close_cancels_lookups() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        let effects = runtime.step(Event::Close, &clock, &mut ids);
        assert!(effects.contains(&Effect::CancelAllLookups));
        assert!(runtime.is_closed());
        // 关闭后一切事件被拒。
        let effects = runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("X"),
            },
            &clock,
            &mut ids,
        );
        assert!(effects.is_empty());
        assert_eq!(runtime.state().draft.snapshot.text, "");
    }

    /// DSH busyEnter 加速键取反语义在 resolve 层；引擎层验证 queue 模式忙时不派发（FM11）。
    #[test]
    fn fm11_busy_queue_keeps_draft_in_outbox() {
        let clock = FixedClock(RefCell::new(100));
        let mut ids = SeqIds(RefCell::new(0));
        let mut runtime = fresh();
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("A"),
            },
            &clock,
            &mut ids,
        );
        let effects = runtime.step(Event::Submit, &clock, &mut ids);
        assert!(effect_ids(&effects).is_empty(), "admitting 窗口内不派发");
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let id_a = runtime.state().submissions.last().unwrap().id.to_string();
        runtime.step(
            Event::DeliverResult {
                id: MessageId::new(&id_a),
                attempt: AttemptId::new(
                    runtime
                        .state()
                        .submissions
                        .last()
                        .unwrap()
                        .attempt
                        .as_ref()
                        .unwrap()
                        .as_str(),
                ),
                result: accepted(&id_a, "turn-1"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        runtime.step(
            Event::Edit {
                snapshot: Snapshot::text("B"),
            },
            &clock,
            &mut ids,
        );
        runtime.step(Event::Submit, &clock, &mut ids);
        runtime.step(Event::Persisted { ok: true }, &clock, &mut ids);
        let record = &runtime.state().submissions[1];
        assert_eq!(record.status, Status::Queued);
        assert_eq!(record.snapshot.text, "B", "完整快照入队（FM11：持久队列）");
    }
}
