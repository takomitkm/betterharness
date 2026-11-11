//! chat-composer 的 Dioxus web 演示面板（计划书 §8）。
//!
//! 接线的是 composer-core 台账的真实状态：草稿编辑、可靠提交（交接 + 后继空草稿）、
//! queue/steer 轮次推进（结束本轮后派发下一条）、逐条取回、拒绝重试。Enter/IME 仲裁
//! 走 composer-keynav 的 decide_enter——组合中的 Enter 交给输入法，绝不误发。
//!
//! 演示的传输是**本地回环**：handoff 后立刻 begin_next，主机侧无条件接纳（回执
//! turn = turn-{消息id}）。真实 HTTP/IndexedDB 适配属于平台适配层，随后接入。
//! 持久化同样待接：当前状态仅存活于页面内存。
//!
//! 构建：`cargo check --target wasm32-unknown-unknown`；运行需要 dx/trunk 打包
//! （下一步接入 CI）。

use composer_core::ids::{
    AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, Receipt, ScopeId, Status, TurnId,
};
use composer_core::state::ScopeState;
use composer_keynav::{decide_enter, EnterDecisionInput};
use dioxus::prelude::*;
use wasm_bindgen::prelude::{wasm_bindgen, Closure};
use wasm_bindgen::JsCast;
use Modifiers as KeyModifiers;

// 台账镜像（PoC 测试钩子 __composerView 的数据源）：每次渲染随 signal 刷新。
thread_local! {
    static LEDGER_MIRROR: std::cell::RefCell<Option<ScopeState>> = const { std::cell::RefCell::new(None) };
}

/// PoC 测试钩子：当前台账 JSON（A+ 计划 §十八「获取 Editor State」之外的台账面）。
#[wasm_bindgen]
pub fn composer_view_json() -> String {
    LEDGER_MIRROR.with(|cell| {
        cell.borrow().as_ref().map(|state| serde_json::to_string(state).expect("ledger serializes")).unwrap_or_else(|| "{}".into())
    })
}

/// 全局 eval：island 清空等 JS 侧动作（web-sys 的 Window::eval 需额外 feature，直接绑全局函数最省）。
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = eval)]
    fn global_eval(code: &str);
}

fn main() {
    dioxus::launch(app);
}

type Engine = Signal<ScopeState>;

/// 状态标签，对齐 archive/ts ChatComposer 的 statusLabels。
fn status_label(status: Status) -> &'static str {
    match status {
        Status::Queued => "已保存，等待投递",
        Status::Sending => "正在提交",
        Status::Accepted => "已接纳",
        Status::Rejected => "明确未发送",
        Status::Uncertain => "送达待确认，未自动重发",
        Status::Cancelled => "已取回编辑",
    }
}

/// 循环回环主机：立刻接纳并给出轮次回执（真实宿主换成 HTTP 传输）。
fn admit_locally(state: &mut ScopeState, id: &MessageId, attempt: &AttemptId) {
    let turn = TurnId::new(format!("turn-{id}"));
    let _ = state.settle(
        id,
        Some(attempt),
        DeliveryResult::Accepted {
            receipt: Receipt {
                id: id.clone(),
                scope: ScopeId::new("demo/main"),
                turn,
            },
        },
    );
}

/// 可靠提交：交接进 outbox → 派发 → 回环接纳。交接与后继空草稿是同一次状态变更
/// （引擎守卫拒绝空草稿与重复 ID，与 archive/ts 语义一致）。
/// 返回是否成功交接（失败 = 空草稿/重复 ID，island 文本保持不动）。
fn do_submit(mut state: Engine, mut counter: Signal<u64>, mut admitting: Signal<bool>) -> bool {
    if admitting() {
        return false;
    }
    counter.set(counter() + 1);
    let message = MessageId::new(format!("m{}", counter()));
    let generation = GenerationId::new(format!("gen-{}", counter()));
    let mut next = state.read().clone();
    if next
        .handoff(message, generation, Delivery::Start, counter())
        .is_err()
    {
        return false;
    }
    admitting.set(true);
    state.set(next);
    let mut dispatched = state.read().clone();
    let attempt = AttemptId::new(format!("a{}", counter()));
    if let Some((id, attempt, _delivery, _turn)) = dispatched.begin_next(attempt) {
        admit_locally(&mut dispatched, &id, &attempt);
    }
    state.set(dispatched);
    admitting.set(false);
    true
}

/// 结束当前轮次：轮次结束后派发下一条排队消息（FIFO，B08 语义）。
fn do_end_turn(mut state: Engine, mut counter: Signal<u64>) {
    let mut next = state.read().clone();
    if let Some(turn) = next.active_turn.clone() {
        next.end_turn(&turn);
        counter.set(counter() + 1);
        let attempt = AttemptId::new(format!("a-end-{}", counter()));
        if let Some((id, attempt, _delivery, _turn)) = next.begin_next(attempt) {
            admit_locally(&mut next, &id, &attempt);
        }
        state.set(next);
    }
}

/// 逐条取回（queued/rejected → 取回编辑）：要求当前草稿为空，引擎守卫保证不覆盖输入。
fn do_recall(mut state: Engine, counter: Signal<u64>, id: String) {
    let mut next = state.read().clone();
    let generation = GenerationId::new(format!("gen-r-{}", counter()));
    let _ = next.restore(&MessageId::new(&id), generation);
    state.set(next);
}

/// 拒绝原样重试（保留原消息身份）。
fn do_retry(mut state: Engine, id: String) {
    let mut next = state.read().clone();
    let _ = next.retry(&MessageId::new(&id));
    state.set(next);
}

fn app() -> Element {
    // 台账是唯一事实：UI 只读状态、发事件。
    let mut state: Engine =
        use_signal(|| ScopeState::new(ScopeId::new("demo/main"), GenerationId::new("gen-0")));
    let counter = use_signal(|| 0u64);
    // 在途提交窗口：交接到接纳之间输入框只读（admitting 语义）。
    let admitting = use_signal(|| false);
    // 编辑器模式：?editor=lexical 走 Lexical Island（A+ Phase 1 挂载 PoC），默认 textarea。
    let editor_mode_lexical = web_sys::window()
        .map(|window| window.location().search().unwrap_or_default().contains("editor=lexical"))
        .unwrap_or(false);

    // 台账镜像随渲染刷新（composer_view_json 测试钩子的数据面；read 同时订阅渲染）。
    LEDGER_MIRROR.with(|cell| {
        *cell.borrow_mut() = Some(state.read().clone());
    });

    // island 事件桥：JS Island 发 CustomEvent('bh-island-event')，这里监听并驱动台账。
    // 闭包 forget 存活整个应用生命周期（PoC 无 close 路径；FM18 语义属 Runtime）。
    use_effect(move || {
        let mut state = state.clone();
        let counter = counter.clone();
        let admitting = admitting.clone();
        let closure = Closure::<dyn FnMut(web_sys::CustomEvent)>::new(move |event: web_sys::CustomEvent| {
            let detail = event.detail().as_string().unwrap_or_default();
            // island 事件 JSON：{type: "submit-request"} / {type: "document-changed", text}。
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&detail) else {
                return;
            };
            match payload.get("type").and_then(|value| value.as_str()) {
                Some("submit-request") => {
                    if do_submit(state.clone(), counter.clone(), admitting.clone()) {
                        // 交接成功 → island 文本随草稿清空（交接与清空是同一次状态变更的 UI 面）。
                        global_eval("window.__islandController && window.__islandController.clear()");
                    }
                }
                Some("document-changed") => {
                    // island 文本 → Rust Core 草稿：island 是编辑态唯一事实，document-changed
                    // 事件不带文本，宿主在事件出口处取 getPlainText 一起传回（Phase 3 集成核心面）。
                    if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                        let mut next = state.read().clone();
                        next.edit(composer_core::state::Snapshot::text(text));
                        state.set(next);
                    }
                }
                _ => {}
            }
        });
        let window = web_sys::window().expect("no window");
        window
            .add_event_listener_with_callback("bh-island-event", closure.as_ref().unchecked_ref())
            .unwrap();
        closure.forget(); // 应用生命周期存续
    });

    let draft_text = state.read().draft.snapshot.text.clone();
    let draft_empty = !state.read().draft.snapshot.has_content();
    let turn_running = state.read().active_turn.is_some();

    let records: Vec<(String, Status, String)> = state
        .read()
        .submissions
        .iter()
        .map(|record| {
            (
                record.id.to_string(),
                record.status,
                record.snapshot.text.clone(),
            )
        })
        .collect();

    rsx! {
        div { class: "panel",
            h1 { "chat-composer · Rust 面板" }
            if editor_mode_lexical {
                // Lexical Island 容器：Dioxus 只拥有容器，内部 DOM 归 Lexical（计划 §4.4）。
                div {
                    id: "lexical-island-container",
                    class: "editor",
                    onmounted: move |_| {
                        // island.js（vanilla bundle）已先行加载：window.createController 存在。
                        spawn(async move {
                            let _ = document::eval(
                                "window.__islandMount = () => { window.__islandController = window.createController({ container: document.getElementById('lexical-island-container'), placeholder: '写下一条消息…（Enter 发送）', canSubmit: () => true, onEvent: (event) => { const enriched = event.type === 'document-changed' ? Object.assign({}, event, { text: window.__islandController.getPlainText() }) : event; (window.__islandEvents ??= []).push(enriched); window.dispatchEvent(new CustomEvent('bh-island-event', { detail: JSON.stringify(enriched) })); } }); }; window.__islandRemount = () => { if (window.__islandController) window.__islandController.destroy(); window.__islandMount(); }; window.__islandMount();",
                            ).await;
                        });
                    },
                }
            } else {
                textarea {
                class: "editor",
                placeholder: "写下一条消息…（Enter 发送，Shift+Enter 换行）",
                value: "{draft_text}",
                readonly: admitting(),
                oninput: move |event| {
                    let mut next = state.read().clone();
                    next.edit(composer_core::state::Snapshot::text(event.value()));
                    state.set(next);
                },
                onkeydown: move |event| {
                    let data = event.data();
                    if data.key() != Key::Enter {
                        return; // KD08：非 Enter 键不归本模块。
                    }
                    let decision = decide_enter(&EnterDecisionInput {
                        key: "Enter".into(),
                        shift_key: data.modifiers().contains(KeyModifiers::SHIFT),
                        alt_key: data.modifiers().contains(KeyModifiers::ALT),
                        ctrl_key: data.modifiers().contains(KeyModifiers::CONTROL),
                        meta_key: data.modifiers().contains(KeyModifiers::META),
                        is_composing: data.is_composing(),
                        repeat: false, // dioxus 0.7 KeyboardData 未暴露 repeat；连发守卫由 KD06（keynav 原生测试）与引擎守卫兜底
                        // 演示无真实时钟：组合结束的 10ms 宽限窗需要宿主注入 Date.now()，
                        // 随平台适配层接入（KD03 在 keynav crate 已原生测试覆盖）。
                        ..Default::default()
                    });
                    match decision.kind {
                        composer_keynav::VerdictKind::Submit => {
                            do_submit(state, counter, admitting);
                        }
                        composer_keynav::VerdictKind::Newline => {
                            // 换行交给浏览器默认行为：不 preventDefault，textarea 自行插入。
                        }
                        _ => event.prevent_default(),
                    }
                },
            }
            }
            div { class: "actions",
                button { class: "primary", onclick: move |_| { do_submit(state, counter, admitting); }, disabled: draft_empty || admitting(), "发送" }
                button { "data-testid": "end-turn", onclick: move |_| { do_end_turn(state, counter); }, disabled: !turn_running, "结束本轮" }
            }
            p { class: "status",
                if admitting() {
                    "正在可靠保存消息…"
                } else if turn_running {
                    "本轮运行中，新消息排队，结束本轮后派发"
                } else {
                    "Enter 发送 · Shift+Enter 换行"
                }
            }
            ol { class: "outbox",
                for (id, status, text) in records {
                    RecordRow { key: "{id}", state, counter, id, status, text }
                }
            }
        }
    }
}

/// 单条提交记录行：id 作为 prop 进入组件，各按钮闭包各自克隆，互不争用。
#[component]
fn RecordRow(
    mut state: Engine,
    counter: Signal<u64>,
    id: String,
    status: Status,
    text: String,
) -> Element {
    // 每个按钮闭包各自持有一份 id 克隆（move 闭包不能共享同一绑定）。
    let recall_id = id.clone();
    let retry_id = id.clone();
    rsx! {
        li { class: "record",
            strong { {status_label(status)} }
            span { class: "text", "{text}" }
            if matches!(status, Status::Queued | Status::Rejected) {
                button { onclick: move |_| do_recall(state, counter, recall_id.clone()), "取回编辑" }
            }
            if matches!(status, Status::Rejected) {
                button { onclick: move |_| do_retry(state, retry_id.clone()), "原样重试" }
            }
        }
    }
}
