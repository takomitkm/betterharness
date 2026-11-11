//! Composer Host Adapter（A+ Phase 4，PRODUCT-LINE-PLAN §7.2）。
//!
//! Dioxus 与 Core 同处一个 Rust 应用时不再经过 JS/JSON 桥：UI 事件直接以
//! [`Event`] 强类型进 [`ComposerHost`]，效果以 [`Effect`] 强类型出，交由宿主
//! 实现的 [`EffectExecutor`] 执行，结果回灌排空至不动点。
//!
//! 协议纪律（§7.1）：事件含义/顺序、Snapshot、revision、Effect 处理、幂等、
//! CAS 全部沿用 composer-runtime——本 crate 只做调用适配，不新增业务语义。
//!
//! Executor 当前为同步形状（演示回环 / 原生测试）。真实 HTTP 传输接入时由
//! 平台适配层用串行任务队列包裹（与 WasmEngine 的 enqueue 同款语义），
//! Runtime 侧的 inflight/超时/幂等逻辑不感知执行延迟。

use composer_core::ids::{AttemptId, Delivery, DeliveryResult, MessageId, TurnId};
use composer_core::state::ScopeState;
use composer_runtime::{Clock, Effect, Event, IdGen, Runtime, RuntimeConfig};

/// 宿主效果执行器：Runtime 只发动作，执行与重试纪律全在宿主侧（不许自行重试）。
pub trait EffectExecutor {
    /// 把整个 scope 原子落盘（CAS：实现方对照 revision）。false = 冲突/失败 → FM14 暂停。
    fn persist(&mut self, state: &ScopeState) -> bool;
    /// 派发一次投递。无论成败都回 [`DeliveryResult`]（错误在平台侧转 Uncertain）。
    fn deliver(
        &mut self,
        id: &MessageId,
        attempt: &AttemptId,
        delivery: Delivery,
        turn: Option<&TurnId>,
    ) -> DeliveryResult;
    /// 到期须向宿主回 [`Event::AttemptTimeout`]（演示实现可只记账）。
    fn schedule_timeout(&mut self, id: &MessageId, attempt: &AttemptId, deadline_ms: u64);
    /// 结果先到时取消超时。
    fn cancel_timeout(&mut self, id: &MessageId, attempt: &AttemptId);
}

/// 排空守卫：协议链一次交互的级联上限（对齐 WasmEngine pump 的 64）。
const DRAIN_GUARD: usize = 64;

/// UI 无关的 Composer 宿主：单事件循环内驱动（串行；Dioxus 用 use_coroutine 承载）。
pub struct ComposerHost<E: EffectExecutor, C: Clock, I: IdGen> {
    runtime: Runtime,
    executor: E,
    clock: C,
    ids: I,
    /// 最近一次 dispatch 是否发生了新的交接（island 清空文本的依据）。
    last_dispatch_handed_off: bool,
}

impl<E: EffectExecutor, C: Clock, I: IdGen> ComposerHost<E, C, I> {
    /// 新建宿主。`state` 传全新台账或从持久化恢复的台账（FM09）。
    pub fn new(config: RuntimeConfig, state: ScopeState, executor: E, clock: C, ids: I) -> Self {
        ComposerHost {
            runtime: Runtime::restore_from_persisted(config, state),
            executor,
            clock,
            ids,
            last_dispatch_handed_off: false,
        }
    }

    /// 当前台账（只读镜像的数据源）。
    pub fn state(&self) -> &ScopeState {
        self.runtime.state()
    }

    pub fn is_admitting(&self) -> bool {
        self.runtime.is_admitting()
    }

    pub fn is_paused(&self) -> bool {
        self.runtime.is_paused()
    }

    pub fn is_closed(&self) -> bool {
        self.runtime.is_closed()
    }

    /// 最近一次 dispatch 是否发生了新的交接（UI 据此清 island 文本）。
    pub fn last_dispatch_handed_off(&self) -> bool {
        self.last_dispatch_handed_off
    }

    /// 执行器访问（测试切场景/宿主换传输用）。
    pub fn executor_mut(&mut self) -> &mut E {
        &mut self.executor
    }

    /// 事件进 → 效果出 → 执行 → 结果回灌，排空至不动点。串行调用（单事件循环）。
    pub fn dispatch(&mut self, event: Event) -> &ScopeState {
        self.last_dispatch_handed_off = false;
        let submissions_before = self.state().submissions.len();
        let mut pending = self.runtime.step(event, &self.clock, &mut self.ids);
        for _round in 0..DRAIN_GUARD {
            let effects = std::mem::take(&mut pending);
            if effects.is_empty() {
                break;
            }
            let mut follow_ups: Vec<Event> = Vec::new();
            for effect in effects {
                match effect {
                    Effect::Persist(state) => {
                        let ok = self.executor.persist(&state);
                        follow_ups.push(Event::Persisted { ok });
                    }
                    Effect::Deliver { id, attempt, delivery, turn } => {
                        let result =
                            self.executor
                                .deliver(&id, &attempt, delivery, turn.as_ref());
                        self.executor.cancel_timeout(&id, &attempt);
                        follow_ups.push(Event::DeliverResult { id, attempt, result });
                    }
                    Effect::ScheduleTimeout { id, attempt, deadline_ms } => {
                        self.executor.schedule_timeout(&id, &attempt, deadline_ms);
                    }
                    Effect::CancelTimeout { id, attempt } => {
                        self.executor.cancel_timeout(&id, &attempt);
                    }
                    Effect::Lookup { id } => {
                        // 演示回环无真实传输：unknown 即权威答案（宿主可查证后回 LookupResult）。
                        follow_ups.push(Event::LookupResult {
                            id,
                            result: DeliveryResult::Uncertain {
                                reason: "回环演示无查询通道".into(),
                            },
                        });
                    }
                    Effect::CancelAllLookups => {}
                }
            }
            for follow_up in follow_ups {
                pending.extend(self.runtime.step(follow_up, &self.clock, &mut self.ids));
            }
        }
        if self.state().submissions.len() > submissions_before {
            self.last_dispatch_handed_off = true;
        }
        self.state()
    }
}
