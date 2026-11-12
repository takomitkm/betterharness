//! chat-composer 的 Dioxus 演示面板（A+ Phase 4 直调 + Phase 6 Desktop 双平台）。
//!
//! 架构（PRODUCT-LINE-PLAN §7.2）：UI 事件以强类型 [`Event`] 进 ComposerHost
//! （composer-host crate：Effect 执行 + 结果回灌，排空至不动点）→ composer-runtime
//! → composer-core。不再有 do_submit 直调 ScopeState 的第二套业务逻辑。
//!
//! 演示传输 = 回环 EffectExecutor（Deliver 立即接纳，turn-{id} 回执）；persist 为
//! 内存面（IndexedDB 真持久化在 Phase 5 的 React WASM 线，BM07 CAS 已实证）。
//!
//! Host 住在 use_coroutine 的事件循环里：单消费者天然串行（§7.5 纪律——组件重建
//! 不会新建业务 Runtime）；UI 只读镜像 signal、发事件。
//!
//! 平台（dx 约定，PRODUCT-LINE-PLAN Phase 6）：
//! - web：`cargo build --target wasm32-unknown-unknown`（default features），
//!   island 挂载 + PoC 测试钩子（composer_view_json / __composerView）；
//! - desktop：`cargo build --no-default-features --features desktop`，
//!   Native Core + 系统 WebView2 运行；textarea 自动聚焦，`BH_DEMO_TRACE=<path>`
//!   把每次排空后的台账写文件（桌面冒烟的验收面）。
//!
//! Enter/IME 仲裁走 composer-keynav 的 decide_enter——组合中的 Enter 交给输入法。

use composer_core::ids::{
    AttemptId, Delivery, DeliveryResult, GenerationId, MessageId, Receipt, ScopeId, Status, TurnId,
};
use composer_core::state::{ScopeState, Snapshot};
use composer_host::{ComposerHost, EffectExecutor};
use composer_keynav::{decide_enter, EnterDecisionInput};
use composer_runtime::{Clock, Event, IdGen, RuntimeConfig};
use dioxus::prelude::*;
use futures_util::StreamExt;
use Modifiers as KeyModifiers;

// web（wasm32）专有 interop：desktop 原生构建不编译这些依赖（见 Cargo.toml target 门控）。
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::{wasm_bindgen, Closure};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

// ── 平台面：web（wasm32）专有 ──────────────────────────────────────────────

/// PoC 测试钩子：当前台账 JSON（A+ 计划 §十八「获取 Editor State」之外的台账面）。
/// 台账镜像随渲染刷新；web 的 E2E 断言走 __composerView().state.<字段>。
#[cfg(target_arch = "wasm32")]
thread_local! {
    static LEDGER_MIRROR: std::cell::RefCell<Option<ScopeState>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn composer_view_json() -> String {
    LEDGER_MIRROR.with(|cell| {
        cell.borrow().as_ref().map(|state| serde_json::to_string(state).expect("ledger serializes")).unwrap_or_else(|| "{}".into())
    })
}

/// 全局 eval：island 清空等 JS 侧动作（web-sys 的 Window::eval 需额外 feature，直接绑全局函数最省）。
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = eval)]
    fn global_eval(code: &str);
}

// ── 平台面：desktop 专有 ──────────────────────────────────────────────────

/// 桌面冒烟验收面：`BH_DEMO_TRACE=<path>` 时把每次排空后的台账原子写文件。
/// （JSON 单行；冒烟脚本断言 submissions[0].status = accepted + 草稿清空。）
#[cfg(feature = "desktop")]
fn trace_state(state: &ScopeState) {
    if let Ok(path) = std::env::var("BH_DEMO_TRACE") {
        if let Ok(json) = serde_json::to_string(state) {
            let tmp = format!("{path}.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

/// 桌面自驱（SendKeys 不可用时的兜底）：与 UI 事件完全同形（typed Event 进协程）。
/// Edit → Submit 连发即可：单消费者 channel 保序，Submit 必然看到已填草稿。
/// 键盘路径（keydown → decide_enter → Event::Submit）以 SendKeys 冒烟为准。
#[cfg(feature = "desktop")]
fn autoplay(events: &Coroutine<Event>) {
    if std::env::var("BH_DEMO_AUTOPLAY").is_ok() {
        events.send(Event::Edit { snapshot: Snapshot::text("autoplay hello") });
        events.send(Event::Submit);
    }
}

// ── 平台时钟/身份 ─────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
struct PlatformClock;

#[cfg(target_arch = "wasm32")]
impl Clock for PlatformClock {
    fn now_ms(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct PlatformClock;

#[cfg(not(target_arch = "wasm32"))]
impl Clock for PlatformClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as u64
    }
}

/// 身份生成：时间戳前缀 + 计数器（单页演示不碰撞）。
struct PlatformIds(u64);

impl IdGen for PlatformIds {
    fn next_id(&mut self) -> String {
        self.0 += 1;
        format!("w-{:x}-{}", PlatformClock.now_ms(), self.0)
    }
}

fn main() {
    // 桌面冒烟的启动标记：区分「进程没活」与「事件没进协程」。固定路径版不依赖
    // 环境变量（决定性实验：它不出现 = main 根本没跑）；cwd 版判绝对路径写失败。
    #[cfg(feature = "desktop")]
    {
        let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
        let _ = std::fs::write("boot-cwd.txt", format!("boot cwd={cwd}"));
        let _ = std::fs::write("D:\\yzd\\composer-rust-3\\smoke\\boot-always.txt", format!("boot cwd={cwd}"));
        if let Ok(path) = std::env::var("BH_DEMO_TRACE") {
            let _ = std::fs::write(format!("{path}.boot"), format!("boot cwd={cwd}"));
        }
    }
    dioxus::launch(app);
}

/// 回环执行器：Deliver 立即接纳（回执 scope 必须与配置一致——配错身份时 FM15
/// 纪律正确兜底转 uncertain，D004 实录）。persist 为内存面：演示台账存活于
/// 镜像 signal；真持久化见 Phase 5 的 React WASM 线（IDB + BM07 CAS）。
struct LoopbackExecutor;

impl EffectExecutor for LoopbackExecutor {
    fn persist(&mut self, _state: &ScopeState) -> bool {
        true
    }

    fn deliver(
        &mut self,
        id: &MessageId,
        _attempt: &AttemptId,
        _delivery: Delivery,
        _turn: Option<&TurnId>,
    ) -> DeliveryResult {
        DeliveryResult::Accepted {
            receipt: Receipt {
                id: id.clone(),
                scope: ScopeId::new("demo/main"),
                turn: TurnId::new(format!("turn-{id}")),
            },
        }
    }

    fn schedule_timeout(&mut self, _id: &MessageId, _attempt: &AttemptId, _deadline_ms: u64) {}

    fn cancel_timeout(&mut self, _id: &MessageId, _attempt: &AttemptId) {}
}

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

fn app() -> Element {
    // 台账镜像：协程在每次排空后整本刷新。UI 只读它 + 发事件（§7.5：不在 UI 复制
    // 一份拥有独立写入权的业务台账）。
    let mut ledger: Signal<ScopeState> =
        use_signal(|| ScopeState::new(ScopeId::new("demo/main"), GenerationId::new("gen-0")));
    // 在途提交窗口（Runtime 的 admitting 瞬时态镜像）：交接到落盘之间输入框只读。
    let mut admitting = use_signal(|| false);
    // 编辑器模式：web 由 ?editor=lexical 切 island（A+ Phase 1 挂载 PoC）；
    // desktop 暂走 textarea（island 资产装载属 Phase 7 收尾）。
    #[cfg(target_arch = "wasm32")]
    let editor_mode_lexical = web_sys::window()
        .map(|window| window.location().search().unwrap_or_default().contains("editor=lexical"))
        .unwrap_or(false);
    #[cfg(not(target_arch = "wasm32"))]
    let editor_mode_lexical = false;

    // 台账镜像随渲染刷新（web 测试钩子 composer_view_json 的数据面；read 同时订阅渲染）。
    #[cfg(target_arch = "wasm32")]
    LEDGER_MIRROR.with(|cell| {
        *cell.borrow_mut() = Some(ledger.read().clone());
    });
    #[cfg(not(target_arch = "wasm32"))]
    let _ = &ledger;

    // Composer 宿主事件循环：Host 唯一所有者。事件 → 排空 → 镜像刷新。
    let events = use_coroutine(move |mut rx: UnboundedReceiver<Event>| async move {
        let mut host = ComposerHost::new(
            RuntimeConfig {
                scope: ScopeId::new("demo/main"),
                send_timeout_ms: 1500,
            },
            ScopeState::new(ScopeId::new("demo/main"), GenerationId::new("gen-0")),
            LoopbackExecutor,
            PlatformClock,
            PlatformIds(0),
        );
        while let Some(event) = rx.next().await {
            let was_submit = matches!(event, Event::Submit);
            host.dispatch(event);
            ledger.set(host.state().clone());
            admitting.set(host.is_admitting());
            #[cfg(feature = "desktop")]
            trace_state(host.state());
            #[cfg(target_arch = "wasm32")]
            if was_submit && host.last_dispatch_handed_off() {
                // 交接成功 → island 文本随草稿清空（交接与清空是同一次状态变更的 UI 面）。
                global_eval("window.__islandController && window.__islandController.clear()");
            }
            #[cfg(not(target_arch = "wasm32"))]
            let _ = was_submit;
        }
    });

    // island 事件桥（web 专有）：JS Island CustomEvent → 强类型 Event 进协程（Phase 4 直调面）。
    // JSON 形状沿用 D009：{type: "submit-request"} / {type: "document-changed", text}。
    #[cfg(target_arch = "wasm32")]
    use_effect(move || {
        let tx = events.clone();
        let closure = Closure::<dyn FnMut(web_sys::CustomEvent)>::new(move |event: web_sys::CustomEvent| {
            let detail = event.detail().as_string().unwrap_or_default();
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&detail) else {
                return;
            };
            match payload.get("type").and_then(|value| value.as_str()) {
                Some("submit-request") => tx.send(Event::Submit),
                Some("document-changed") => {
                    if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                        tx.send(Event::Edit { snapshot: Snapshot::text(text) });
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

    // 桌面自驱兜底（BH_DEMO_AUTOPLAY=1）：use_effect 无 reactive 依赖 → 只跑一次。
    // 不能放渲染体——autoplay 改状态 → 重渲染 → 再 autoplay = 无限循环（冒烟实录）。
    #[cfg(feature = "desktop")]
    use_effect(move || {
        autoplay(&events);
    });

    let draft_text = ledger.read().draft.snapshot.text.clone();
    let draft_empty = !ledger.read().draft.snapshot.has_content();
    let turn_running = ledger.read().active_turn.is_some();

    let records: Vec<(String, Status, String)> = ledger
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
                // 挂载后聚焦 + Enter DOM 护栏（D012 遗留项修复）：desktop 上 Dioxus 事件
                // 走 IPC，Rust handler 的 prevent_default 追不上浏览器默认换行——护栏在
                // JS 同步层 preventDefault（与 island 的 hand-to-ime DOM 护栏同构，D009）。
                // document 级 capture 委托：一次安装、对元素重建免疫（元素级监听在
                // onmounted eval 里曾静默失效——CDP 实录 guard:false）。Shift+Enter 与
                // IME 组合中的 Enter 不拦（换行/输入法语义归浏览器）。
                onmounted: move |_| {
                    spawn(async move {
                        let _ = document::eval(
                            "if (!window.__bhEnterGuard) { window.__bhEnterGuard = true; document.addEventListener('keydown', (e) => { const ta = e.target; if (ta && ta.tagName === 'TEXTAREA' && ta.classList && ta.classList.contains('editor') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) e.preventDefault(); }, true); } const ta0 = document.querySelector('textarea.editor'); if (ta0) ta0.focus();",
                        ).await;
                    });
                },
                oninput: move |event| {
                    events.send(Event::Edit { snapshot: Snapshot::text(event.value()) });
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
                        repeat: false, // dioxus 0.7 KeyboardData 未暴露 repeat；连发守卫由 KD06（keynav 原生测试）与 Runtime 的 inflight 兜底
                        // 演示恒可提交：空草稿由 Runtime 的 FD06 守卫兜底。Default 的
                        // can_submit=false 曾让 textarea 的 Enter 恒 noop（CDP 冒烟实录）。
                        can_submit: true,
                        // 组合结束的 10ms 宽限窗（KD03）在 keynav crate 原生测试覆盖；
                        // 浏览器侧组合状态由 island 的 ImeTracker 承担。
                        ..Default::default()
                    });
                    match decision.kind {
                        composer_keynav::VerdictKind::Submit => events.send(Event::Submit),
                        composer_keynav::VerdictKind::Newline => {
                            // 换行交给浏览器默认行为：不 preventDefault，textarea 自行插入。
                        }
                        _ => event.prevent_default(),
                    }
                },
            }
            }
            div { class: "actions",
                button { class: "primary", onclick: move |_| events.send(Event::Submit), disabled: draft_empty || admitting(), "发送" }
                button {
                    "data-testid": "end-turn",
                    onclick: move |_| {
                        if let Some(turn) = ledger.read().active_turn.clone() {
                            events.send(Event::EndTurn(turn));
                        }
                    },
                    disabled: !turn_running,
                    "结束本轮"
                }
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
                    RecordRow { key: "{id}", events: events.clone(), id, status, text }
                }
            }
        }
    }
}

/// 单条提交记录行：id 作为 prop 进入组件，事件走协程（Phase 4：UI 不碰台账写面）。
#[component]
fn RecordRow(events: Coroutine<Event>, id: String, status: Status, text: String) -> Element {
    let recall_id = id.clone();
    let retry_id = id.clone();
    rsx! {
        li { class: "record",
            strong { {status_label(status)} }
            span { class: "text", "{text}" }
            if matches!(status, Status::Queued | Status::Rejected | Status::Cancelled) {
                button { onclick: move |_| events.send(Event::Restore { id: MessageId::new(&recall_id) }), "取回编辑" }
            }
            if matches!(status, Status::Rejected) {
                button { onclick: move |_| events.send(Event::Retry { id: MessageId::new(&retry_id) }), "原样重试" }
            }
        }
    }
}
