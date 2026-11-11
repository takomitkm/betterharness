//! ComposerHost 原生测试：适配器排空语义 + Executor 契约（mock 回环）。
//! 业务场景与 app-web island E2E（24/24）一一同源：改 UI 不得改这些结果。

use composer_core::ids::{
    AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, Receipt, ScopeId, Status, TurnId,
};
use composer_core::state::{ScopeState, Snapshot};
use composer_host::{ComposerHost, EffectExecutor};
use composer_runtime::{Event, RuntimeConfig};
use std::cell::RefCell;
use std::rc::Rc;

/// 可控时钟。
#[derive(Clone)]
struct TestClock(Rc<RefCell<u64>>);

impl TestClock {
    fn new() -> Self {
        TestClock(Rc::new(RefCell::new(1000)))
    }
    #[allow(dead_code)]
    fn advance(&self, ms: u64) {
        *self.0.borrow_mut() += ms;
    }
}

impl composer_runtime::Clock for TestClock {
    fn now_ms(&self) -> u64 {
        *self.0.borrow()
    }
}

/// 计数身份。
struct TestIds(u64);

impl TestIds {
    fn new() -> Self {
        TestIds(0)
    }
}

impl composer_runtime::IdGen for TestIds {
    fn next_id(&mut self) -> String {
        self.0 += 1;
        format!("id-{}", self.0)
    }
}

/// 回环执行器：deliver 立刻按场景结算（与 app-web 回环同形）；persist/超时可切。
struct LoopbackExecutor {
    /// deliver 场景：accept（默认）/ reject / uncertain（模拟丢 ack）。
    scenario: &'static str,
    /// persist 场景：true（默认）/ false（CAS 冲突，FM14）。
    persist_ok: bool,
    persists: Vec<ScopeState>,
    scheduled: Vec<(String, String, u64)>,
    cancelled: Vec<(String, String)>,
}

impl LoopbackExecutor {
    fn new() -> Self {
        LoopbackExecutor { scenario: "accept", persist_ok: true, persists: Vec::new(), scheduled: Vec::new(), cancelled: Vec::new() }
    }
    fn with_scenario(scenario: &'static str) -> Self {
        LoopbackExecutor { scenario, ..Self::new() }
    }
}

impl EffectExecutor for LoopbackExecutor {
    fn persist(&mut self, state: &ScopeState) -> bool {
        self.persists.push(state.clone());
        self.persist_ok
    }
    fn deliver(
        &mut self,
        id: &MessageId,
        _attempt: &AttemptId,
        _delivery: Delivery,
        _turn: Option<&TurnId>,
    ) -> DeliveryResult {
        match self.scenario {
            "reject" => DeliveryResult::Rejected {
                reason: "回环拒绝".into(),
            },
            "uncertain" => DeliveryResult::Uncertain {
                reason: "回环丢 ack".into(),
            },
            _ => DeliveryResult::Accepted {
                receipt: Receipt {
                    id: id.clone(),
                    scope: ScopeId::new("test/main"),
                    turn: TurnId::new(format!("turn-{id}")),
                },
            },
        }
    }
    fn schedule_timeout(&mut self, id: &MessageId, attempt: &AttemptId, deadline_ms: u64) {
        self.scheduled.push((id.to_string(), attempt.to_string(), deadline_ms));
    }
    fn cancel_timeout(&mut self, id: &MessageId, attempt: &AttemptId) {
        self.cancelled.push((id.to_string(), attempt.to_string()));
    }
}

type Host = ComposerHost<LoopbackExecutor, TestClock, TestIds>;

fn fresh_host(executor: LoopbackExecutor) -> Host {
    let config = RuntimeConfig {
        scope: ScopeId::new("test/main"),
        send_timeout_ms: 1500,
    };
    ComposerHost::new(
        config,
        ScopeState::new(ScopeId::new("test/main"), GenerationId::new("gen-0")),
        executor,
        TestClock::new(),
        TestIds::new(),
    )
}

fn edit(host: &mut Host, text: &str) {
    host.dispatch(Event::Edit { snapshot: Snapshot::text(text) });
}

/// 1（E2E 4a-4c 镜像）：edit → submit → 排空后 Accepted + 草稿清空 + 文本正确 + 超时已排程。
#[test]
fn submit_accepted_and_draft_cleared() {
    let executor = LoopbackExecutor::new();
    let mut host = fresh_host(executor);
    edit(&mut host, "你好 Bridge");
    host.dispatch(Event::Submit);
    let state = host.state();
    assert_eq!(state.submissions.len(), 1);
    assert_eq!(state.submissions[0].status, Status::Accepted);
    assert_eq!(state.submissions[0].snapshot.text, "你好 Bridge");
    assert!(state.draft.snapshot.is_empty(), "FM01：交接与后继空草稿是同一次状态变更");
    assert!(state.active_turn.is_some(), "接纳后轮次活跃");
    assert!(host.last_dispatch_handed_off(), "交接发生（island 清空依据）");
}

/// 2（E2E 6a/6b/6d 镜像）：轮次活跃期间第二条入队，end_turn 后派发接纳。
#[test]
fn submit_queued_while_turn_active_then_end_turn() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "第一条");
    host.dispatch(Event::Submit);
    edit(&mut host, "第二条");
    host.dispatch(Event::Submit);
    let state = host.state();
    assert_eq!(state.submissions.len(), 2);
    assert_eq!(state.submissions[1].status, Status::Queued, "FM11：忙时排队");

    let turn = state.active_turn.clone().expect("轮次活跃");
    host.dispatch(Event::EndTurn(turn));
    assert_eq!(host.state().submissions[1].status, Status::Accepted, "FM12：end_turn 派发队首");
}

/// 3（E2E 6c/6e 镜像）：两条排队 FIFO，两次 end_turn 依次派发。
#[test]
fn two_queued_fifo_two_end_turns() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "第一条");
    host.dispatch(Event::Submit);
    edit(&mut host, "第二条");
    host.dispatch(Event::Submit);
    edit(&mut host, "第三条");
    host.dispatch(Event::Submit);
    assert_eq!(host.state().submissions[1].status, Status::Queued);
    assert_eq!(host.state().submissions[2].status, Status::Queued);

    let turn = host.state().active_turn.clone().unwrap();
    host.dispatch(Event::EndTurn(turn));
    assert_eq!(host.state().submissions[1].status, Status::Accepted);
    assert_eq!(host.state().submissions[2].status, Status::Queued, "FIFO：只派发队首");

    let turn = host.state().active_turn.clone().unwrap();
    host.dispatch(Event::EndTurn(turn));
    assert_eq!(host.state().submissions[2].status, Status::Accepted);
}

/// 4：适配器终态不变量——排空后最后一次落盘内容与宿主台账完全一致。
#[test]
fn final_persist_matches_host_state() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "第一版");
    host.dispatch(Event::Submit);
    edit(&mut host, "第二版");
    host.dispatch(Event::Submit);
    let last = host
        .executor_mut()
        .persists
        .last()
        .cloned()
        .expect("有落盘记录");
    assert_eq!(last, *host.state(), "终态落盘一致（排空至不动点）");
    assert_eq!(last.submissions.len(), 2);
    assert!(last.draft.snapshot.is_empty(), "最后动作是 submit：草稿空");
}

/// 5（FM05）：queued 只能取回到空草稿；非空草稿拒绝；取回后记录转 Cancelled。
#[test]
fn restore_queued_only_into_empty_draft() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "第一条");
    host.dispatch(Event::Submit);
    edit(&mut host, "第二条");
    host.dispatch(Event::Submit);
    let queued_id = host.state().submissions[1].id.clone();

    edit(&mut host, "正在输入");
    host.dispatch(Event::Restore { id: queued_id.clone() });
    assert_eq!(host.state().submissions[1].status, Status::Queued, "FM05：不覆盖非空草稿");

    edit(&mut host, "");
    host.dispatch(Event::Restore { id: queued_id.clone() });
    assert_eq!(host.state().draft.snapshot.text, "第二条");
    assert_eq!(host.state().submissions[1].status, Status::Cancelled, "取回 = 记录转 Cancelled");
}

/// 6：rejected 原样重试（保留原身份），重投接纳。
#[test]
fn retry_rejected_resends() {
    let mut host = fresh_host(LoopbackExecutor::with_scenario("reject"));
    edit(&mut host, "会被拒绝");
    host.dispatch(Event::Submit);
    assert_eq!(host.state().submissions[0].status, Status::Rejected);
    let id = host.state().submissions[0].id.clone();

    host.executor_mut().scenario = "accept";
    host.dispatch(Event::Retry { id });
    assert_eq!(host.state().submissions[0].status, Status::Accepted);
}

/// 7（FM04/25 适配层镜像）：丢 ack → uncertain；迟到的超时不降级。
#[test]
fn uncertain_then_late_timeout_ignored() {
    let mut host = fresh_host(LoopbackExecutor::with_scenario("uncertain"));
    edit(&mut host, "丢失确认");
    host.dispatch(Event::Submit);
    let (id, attempt) = {
        let record = &host.state().submissions[0];
        assert_eq!(record.status, Status::Uncertain);
        (record.id.clone(), record.attempt.clone().expect("attempt 在案"))
    };
    host.dispatch(Event::AttemptTimeout { id: id.clone(), attempt });
    assert_eq!(host.state().submissions[0].status, Status::Uncertain, "迟到超时不降级");
}

/// 8（FM14/24 适配层镜像）：persist 失败 → 暂停自动投递；Resume 后队列重新推进。
#[test]
fn persist_failure_pauses_then_resume() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "第一条");
    host.dispatch(Event::Submit);
    assert_eq!(host.state().submissions[0].status, Status::Accepted);

    host.executor_mut().persist_ok = false;
    edit(&mut host, "第二条");
    host.dispatch(Event::Submit);
    let state = host.state();
    assert_eq!(state.submissions[1].status, Status::Queued);
    assert!(host.is_paused(), "FM14：persist 失败暂停自动投递");
    assert!(state.draft.snapshot.is_empty(), "交接已完成（落盘失败不回滚交接）");

    host.executor_mut().persist_ok = true;
    host.dispatch(Event::Resume);
    assert!(!host.is_paused());
    // Resume 后 pump 重新推进队列：FM24。
    let turn = host.state().active_turn.clone().unwrap();
    host.dispatch(Event::EndTurn(turn));
    assert_eq!(host.state().submissions[1].status, Status::Accepted);
}

/// 9（FD06）：空草稿 submit 被拒——不产生任何提交。
#[test]
fn empty_draft_submit_rejected() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "");
    host.dispatch(Event::Submit);
    assert!(host.state().submissions.is_empty());
    assert!(!host.last_dispatch_handed_off());
}

/// 10（FM18）：close 后一切无效。
#[test]
fn close_stops_everything() {
    let mut host = fresh_host(LoopbackExecutor::new());
    edit(&mut host, "未提交");
    host.dispatch(Event::Close);
    assert!(host.is_closed());
    let before = host.state().revision;
    edit(&mut host, "封闭后再输入");
    assert_eq!(host.state().revision, before, "封闭后编辑无效");
}
