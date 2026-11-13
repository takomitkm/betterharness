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
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use taino_edit_dioxus::{EditorState, TainoEditor, ViewPlugins};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::{wasm_bindgen, Closure, JsValue};
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
        events.send(AppEvent::Runtime(Event::Edit { snapshot: Snapshot::text("autoplay hello") }));
        events.send(AppEvent::Runtime(Event::Submit));
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

#[cfg(target_arch = "wasm32")]
mod idb;

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

// ── taino 编辑器（web 专有，E1：Pure Rust Editor 替换面，D014） ─────────────

/// ImeTracker：island keynav.ts 同款语义的 Rust 最小版（KD10/KD03）。
#[derive(Default)]
struct ImeTracker {
    composing: bool,
    composing_until_ms: u64,
}

impl ImeTracker {
    fn start(&mut self) {
        self.composing = true;
    }
    fn end(&mut self, now_ms: u64) {
        self.composing = false;
        self.composing_until_ms = now_ms + 10; // KD03：10ms 宽限窗
    }
}

/// doc 多段落按 \n 连接（Node::text_content 不加块分隔——E1 实录）。
fn doc_plain_text(doc: &taino_edit_dioxus::Node) -> String {
    let mut parts = Vec::new();
    for i in 0..doc.child_count() {
        parts.push(doc.child(i).text_content());
    }
    parts.join("\n")
}

/// 用纯文本重建 doc 内容切片（段落按 \n 切；空行 = 空段落；全空 = 单空段落）。
#[cfg(target_arch = "wasm32")]
fn text_slice(
    schema: &taino_edit_dioxus::Schema,
    text: &str,
) -> taino_edit_dioxus::Slice {
    let paras: Vec<_> = text
        .split('\n')
        .map(|line| {
            let children: Vec<_> = if line.is_empty() {
                Vec::new()
            } else {
                vec![schema.text(line, vec![]).expect("text node")]
            };
            schema
                .node("paragraph", Default::default(), children, vec![])
                .expect("paragraph")
        })
        .collect();
    if paras.is_empty() {
        let para = schema
            .node("paragraph", Default::default(), vec![], vec![])
            .expect("paragraph");
        taino_edit_dioxus::Slice::new(taino_edit_core::Fragment::from_nodes(vec![para]), 0, 0)
    } else {
        taino_edit_dioxus::Slice::new(taino_edit_core::Fragment::from_nodes(paras), 0, 0)
    }
}

/// 扩展名 → MIME（demo 面够用的白名单；未知走 octet-stream）。
#[cfg(target_arch = "wasm32")]
fn mime_from_ext(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
    .into()
}

/// JS 定时器 sleep（wasm 无 std::time 睡眠；E3d 超时触发用）。
#[cfg(target_arch = "wasm32")]
async fn js_sleep(ms: u64) {
    wasm_bindgen_futures::JsFuture::from(js_sys::Promise::new(&mut |resolve, _reject| {
        window_set_timeout(resolve, ms as i32);
    }))
    .await
    .ok();
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = setTimeout)]
    fn window_set_timeout(handler: js_sys::Function, ms: i32);
}

/// 当前文档内容尺寸（事务替换的 to 端点）。
#[cfg(target_arch = "wasm32")]
fn doc_content_size(editor: &Signal<EditorState>) -> usize {
    let doc = editor.peek().doc().clone();
    (0..doc.child_count()).map(|i| doc.child(i).node_size()).sum()
}

/// 回环执行器：Deliver 立即接纳（回执 scope 必须与配置一致——配错身份时 FM15
/// 纪律正确兜底转 uncertain，D004 实录）。persist 为内存面：演示台账存活于
/// 镜像 signal；真持久化见 Phase 5 的 React WASM 线（IDB + BM07 CAS）。
/// E3c：回环执行器 + IDB 持久化镜像（fire-and-forget；scope 键、整本 state JSON）。
/// E3d：场景化交付（URL ?scenario=）——accept（默认）/reject/uncertain（丢 ack），
/// 超时真触发（ScheduleTimeout 到点回 AttemptTimeout）。
struct LoopbackExecutor {
    scope: String,
    scenario: String,
    /// 协程句柄槽：use_coroutine 返回后回填（鸡生蛋——executor 在协程内构造）。
    events_slot: Rc<std::cell::RefCell<Option<Coroutine<AppEvent>>>>,
}

impl EffectExecutor for LoopbackExecutor {
    fn persist(&mut self, state: &ScopeState) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            let json = serde_json::to_string(state).expect("ledger serializes");
            idb::request_put(&self.scope.clone(), &json);
        }
        let _ = (state, &self.scope);
        true
    }

    fn deliver(
        &mut self,
        id: &MessageId,
        _attempt: &AttemptId,
        _delivery: Delivery,
        _turn: Option<&TurnId>,
    ) -> DeliveryResult {
        // 回执 scope 必须与 RuntimeConfig.scope 一致（FM15）：写死 demo/main 会在
        // URL scope 隔离（E3c）下配错身份 → 全部转 uncertain。
        match self.scenario.as_str() {
            "reject" => {
                return DeliveryResult::Rejected {
                    reason: "回环拒绝（场景注入）".into(),
                };
            }
            "uncertain" => {
                return DeliveryResult::Uncertain {
                    reason: "回环丢 ack（场景注入）".into(),
                };
            }
            _ => {}
        }
        DeliveryResult::Accepted {
            receipt: Receipt {
                id: id.clone(),
                scope: ScopeId::new(self.scope.clone()),
                turn: TurnId::new(format!("turn-{id}")),
            },
        }
    }

    fn schedule_timeout(&mut self, id: &MessageId, attempt: &AttemptId, deadline_ms: u64) {
        // 超时真触发：到点（或立即，若已过期）回 AttemptTimeout——FM04 链的 E2E 面。
        let Some(events) = self.events_slot.borrow().clone() else {
            return;
        };
        let id = id.clone();
        let attempt = attempt.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let now = PlatformClock.now_ms();
            let wait = deadline_ms.saturating_sub(now);
            js_sleep(wait).await;
            events.send(AppEvent::Runtime(Event::AttemptTimeout { id, attempt }));
        });
    }

    fn cancel_timeout(&mut self, _id: &MessageId, _attempt: &AttemptId) {}
}

// ── 候选菜单（E3a：composer-completion + taino 线，TS CandidateMenu 契约同构） ──

/// 应用层事件：Runtime 事件 + 菜单键事件（菜单开着时键路由归菜单）。
#[derive(Clone, Debug)]
enum AppEvent {
    Runtime(Event),
    Menu(MenuAction),
    /// E3b：附件入库（已过 intake 守卫的 FileMeta；字节留 JS 侧，meta 进台账面）。
    Attach(composer_intake::FileMeta),
    /// E3b：按 AssetId 移除附件。
    Detach(String),
    /// E3b：附件重排（composer-reorder 语义：asset 移动到目标下标）。
    MoveAsset { asset_id: String, target_index: f64 },
    /// E3d：运行时切换交付场景（宿主可切传输行为；E2E retry 判据用）。
    SetScenario(String),
}

/// 菜单开着时的键动作（KD has_menu 契约的 E2E 面）。
#[derive(Clone, Copy, Debug)]
enum MenuAction {
    Up,
    Down,
    Accept,
    /// 鼠标点击某项 = 定位该项并接受（TS CandidateMenu onPick 契约）。
    Pick(usize),
    Dismiss,
    /// E3b+：鼠标悬停定位高亮（TS CandidateMenu onHighlight 同款）。
    Hover(usize),
}

/// 菜单 UI 视图（session 状态的只读投影）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct MenuView {
    items: Vec<String>,
    highlight: usize,
}

/// 演示候选源（TS demo 同款）：@ 文件引用、/ 命令回显。生产宿主在此接真实检索。
fn demo_provider(
    kind: composer_completion::TriggerKind,
    query: &str,
) -> Vec<composer_completion::Candidate> {
    use composer_completion::{Candidate, TriggerKind};
    let source: &[(&str, &str)] = match kind {
        TriggerKind::Reference => &[
            ("field-report.md", "@field-report.md"),
            ("final-notes.md", "@final-notes.md"),
            ("s1-alpha.md", "@s1-alpha.md"),
            ("s2-beta.md", "@s2-beta.md"),
            ("服务器架构.png", "@服务器架构.png"),
        ],
        TriggerKind::Slash => &[
            ("/help 帮助", "/帮助"),
            ("/clear 清理上下文", "/清理上下文"),
        ],
    };
    let needle = query.to_lowercase();
    source
        .iter()
        .filter(|(label, insert)| {
            label.to_lowercase().contains(&needle) || insert.to_lowercase().contains(&needle)
        })
        .map(|(label, insert)| Candidate {
            label: (*label).into(),
            insert_text: (*insert).into(),
        })
        .collect()
}

/// session 状态 → 菜单 UI 投影 + menu_open 旗标同步。
#[cfg(target_arch = "wasm32")]
fn sync_menu_view(
    session: &composer_completion::CompletionSession,
    menu_view: &mut Signal<Option<MenuView>>,
    menu_open: &Rc<Cell<bool>>,
) {
    menu_open.set(session.is_open());
    *menu_view.write() = if session.is_open() && !session.is_pending() {
        Some(MenuView {
            items: session
                .candidates()
                .iter()
                .map(|c| c.label.clone())
                .collect(),
            highlight: session.highlight_index().max(0) as usize,
        })
    } else {
        None
    };
}

/// DOM 选区 → 编辑器全文字符偏移（触发检测的 caret 用 char 下标；E3a）。
#[cfg(target_arch = "wasm32")]
fn dom_caret_char_offset() -> Option<usize> {
    let window = web_sys::window()?;
    let sel = window.get_selection().ok().flatten()?;
    let range = sel.get_range_at(0).ok()?;
    let root: web_sys::Element = window
        .document()?
        .query_selector("[contenteditable=\"true\"]")
        .ok()
        .flatten()?;
    let anchor = range.start_container().ok()?;
    let offset = range.start_offset().ok()? as usize;

    // 深度优先累计 anchor 之前的字符数（文本节点计自身长度；到 anchor 停）。
    fn walk(node: &web_sys::Node, anchor: &web_sys::Node, offset: usize, acc: &mut usize, found: &mut bool) {
        if *found {
            return;
        }
        if JsValue::from(node) == JsValue::from(anchor) {
            *acc += offset;
            *found = true;
            return;
        }
        if let Some(text) = node.dyn_ref::<web_sys::Text>() {
            *acc += text.data().chars().count();
            return;
        }
        let list = node.child_nodes();
        for i in 0..list.length() {
            if let Some(child) = list.get(i) {
                walk(&child, anchor, offset, acc, found);
            }
        }
    }

    let mut acc = 0;
    let mut found = false;
    walk(root.unchecked_ref(), &anchor, offset, &mut acc, &mut found);
    if found { Some(acc) } else { None }
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

/// E3b 附件资产镜像（host-owned 字节的 meta 面；字节留 JS/文件系统，从不进台账）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct AssetMeta {
    id: String,
    name: String,
    media_type: String,
    bytes: u64,
}

/// E3b 演示 intake 策略（TS demo 同款量级）。
fn demo_intake_policy() -> composer_intake::IntakePolicy {
    composer_intake::IntakePolicy {
        max_files: Some(8),
        max_bytes_per_file: Some(5 * 1024 * 1024),
        max_bytes_total: Some(20 * 1024 * 1024),
        allowed_media_types: None, // 演示不设类型白名单；E2E 用超限大小/数量打拒绝路径
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
    // 会话 scope（E3c）：URL ?scope= 隔离多会话/多 run（IDB 键 + RuntimeConfig）；
    // 缺省 demo/main。TS demo2-wasm 同款（scope=wasm-e2e-<ts>）。
    #[cfg(target_arch = "wasm32")]
    let session_scope: String = web_sys::window()
        .and_then(|window| window.location().search().ok())
        .and_then(|search| {
            url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes())
                .find(|(k, _)| k == "scope")
                .map(|(_, v)| v.into_owned())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "demo/main".into());
    #[cfg(not(target_arch = "wasm32"))]
    let session_scope: String = "demo/main".into();

    // E3d：交付场景（?scenario=reject/uncertain；缺省 accept）。
    #[cfg(target_arch = "wasm32")]
    let delivery_scenario: String = web_sys::window()
        .and_then(|window| window.location().search().ok())
        .and_then(|search| {
            url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes())
                .find(|(k, _)| k == "scenario")
                .map(|(_, v)| v.into_owned())
        })
        .unwrap_or_else(|| "accept".into());
    #[cfg(not(target_arch = "wasm32"))]
    let delivery_scenario: String = "accept".into();

    // 编辑器模式：?editor=taino 走 Pure Rust Editor（E1，D014）。
    #[cfg(target_arch = "wasm32")]
    let editor_mode_taino = web_sys::window()
        .map(|window| window.location().search().unwrap_or_default().contains("editor=taino"))
        .unwrap_or(false);
    #[cfg(not(target_arch = "wasm32"))]
    let editor_mode_taino = false;

    // taino 编辑器状态（textarea/island 模式下闲置；desktop 上分支不渲染）。
    let mut taino_editor: Signal<taino_edit_dioxus::EditorState> = use_signal(|| {
        let base = taino_edit_dioxus::SchemaBuilder::new()
            .node(
                "doc",
                taino_edit_dioxus::NodeSpec {
                    content: Some("block+".into()),
                    ..Default::default()
                },
            )
            .node(
                "text",
                taino_edit_dioxus::NodeSpec {
                    group: Some("inline".into()),
                    ..Default::default()
                },
            );
        let exts: [&'static dyn taino_edit_extensions::Extension; 1] =
            [&taino_edit_extensions::Paragraph];
        let schema = taino_edit_extensions::build_schema_with(base, &exts, "doc").expect("schema");
        let para = schema
            .node("paragraph", Default::default(), vec![], vec![])
            .expect("empty paragraph");
        let doc = schema
            .node("doc", Default::default(), vec![para], vec![])
            .expect("doc");
        EditorState::new(doc, schema)
    });
    // ImeTracker：组合事件在 taino 内部消化，宿主用根级监听拿状态（island 同款，KD10）。
    let ime = use_hook(|| Rc::new(RefCell::new(ImeTracker::default())));

    // 台账镜像随渲染刷新（web 测试钩子 composer_view_json 的数据面；read 同时订阅渲染）。
    #[cfg(target_arch = "wasm32")]
    LEDGER_MIRROR.with(|cell| {
        *cell.borrow_mut() = Some(ledger.read().clone());
    });
    #[cfg(not(target_arch = "wasm32"))]
    let _ = &ledger;

    // Composer 宿主事件循环：Host 唯一所有者。事件 → 排空 → 镜像刷新。
    // E3a：AppEvent 分层（Runtime 事件 + 菜单键），候选会话进协程（单消费者串行）。
    let mut taino_editor_loop = taino_editor.clone();
    let taino_mode = editor_mode_taino;
    let mut menu_view: Signal<Option<MenuView>> = use_signal(|| None);
    let menu_open: Rc<Cell<bool>> = Rc::new(Cell::new(false));
    // E3b：附件资产镜像（顺序 = rail 顺序；Snapshot.attachment_ids 与之同步）。
    let mut assets: Signal<Vec<AssetMeta>> = use_signal(Vec::new);
    let mut intake_rejections: Signal<Vec<(String, String)>> = use_signal(Vec::new);
    let menu_open_loop = menu_open.clone();
    let menu_view_loop = menu_view.clone();
    let mut assets_loop = assets.clone();
    let mut rejections_loop = intake_rejections.clone();
    let events_slot: Rc<std::cell::RefCell<Option<Coroutine<AppEvent>>>> = Rc::new(std::cell::RefCell::new(None));
    let scope_for_hook = session_scope.clone();
    let events = use_coroutine(move |mut rx: UnboundedReceiver<AppEvent>| {
        // use_coroutine 的闭包是 FnMut：非 Copy 捕获在体内 clone，再进 async move。
        let menu_open_loop = menu_open_loop.clone();
        let mut menu_view_loop = menu_view_loop.clone();
        let session_scope = session_scope.clone();
        let delivery_scenario = delivery_scenario.clone();
        let events_slot_for_exec = events_slot.clone();
        let events_slot_hook = events_slot.clone();
        async move {
        // E3c FM09：先读 IDB——有持久化记录则恢复（sending→uncertain 等 Runtime 语义），
        // 无则全新台账。
        #[cfg(target_arch = "wasm32")]
        let persisted = idb::get(&session_scope).await.and_then(|json| {
            serde_json::from_str::<ScopeState>(&json)
                .map_err(|e| web_sys::console::error_1(&format!("idb restore parse: {e}").into()))
                .ok()
        });
        #[cfg(not(target_arch = "wasm32"))]
        let persisted: Option<ScopeState> = None;
        let scope_state = persisted.unwrap_or_else(|| {
            ScopeState::new(
                ScopeId::new(session_scope.clone()),
                GenerationId::new("gen-0"),
            )
        });
        let mut host = ComposerHost::new(
            RuntimeConfig {
                scope: ScopeId::new(session_scope.clone()),
                send_timeout_ms: 1500,
            },
            scope_state,
            LoopbackExecutor {
                scope: session_scope.clone(),
                scenario: delivery_scenario.clone(),
                events_slot: events_slot_for_exec,
            },
            PlatformClock,
            PlatformIds(0),
        );
        // E3c FM09 配套：恢复的草稿写回 taino 编辑器（否则挂载后的空文本 Edit 会
        // 把恢复的草稿覆盖掉——IDB E2E 判据 3 实录）。
        #[cfg(target_arch = "wasm32")]
        if taino_mode {
            let draft_text = host.state().draft.snapshot.text.clone();
            if !draft_text.is_empty() {
                let schema = taino_editor_loop.peek().schema().clone();
                let doc_slice = text_slice(&schema, &draft_text);
                let size = doc_content_size(&taino_editor_loop);
                let mut tx = taino_editor_loop.peek().tr();
                tx.transform()
                    .replace(0, size, doc_slice, &schema)
                    .expect("restore replace");
                let next = taino_editor_loop.peek().apply(tx);
                taino_editor_loop.set(next);
            }
        }
        let mut session = composer_completion::CompletionSession::new();
        while let Some(ev) = rx.next().await {
            match ev {
                AppEvent::Runtime(event) => {
                    let was_submit = matches!(event, Event::Submit);
                    let was_edit = matches!(event, Event::Edit { .. });
                    // E3b：文本 Edit 携带的 ids 视为空（编辑器只拥有文本）——统一在此
                    // 保留台账现 ids（附件面独立于文本，TS 线同款语义；E2E 4b 实录）。
                    let event = match event {
                        Event::Edit { snapshot } => Event::Edit {
                            snapshot: composer_core::state::Snapshot {
                                attachment_ids: host.state().draft.snapshot.attachment_ids.clone(),
                                ..snapshot
                            },
                        },
                        other => other,
                    };
                    host.dispatch(event);
                    ledger.set(host.state().clone());
                    admitting.set(host.is_admitting());
                    #[cfg(target_arch = "wasm32")]
                    web_sys::console::log_1(&format!(
                        "e3d: after subs={:?} admitting={} paused={}",
                        host.state().submissions.iter().map(|x| x.status).collect::<Vec<_>>(),
                        host.is_admitting(),
                        host.is_paused(),
                    ).into());
                    #[cfg(feature = "desktop")]
                    trace_state(host.state());
                    if was_submit && host.last_dispatch_handed_off() {
                        // FM01：交接成功 → 编辑器文本随草稿清空（交接与清空是同一次状态变更的
                        // UI 面）。taino 重建空文档（undo 栈重置——D014 已知差异）；island 走 JS。
                        if taino_mode {
                            // FM01 事务式清空：保历史与选区映射（重建 EditorState 会让选区
                            // 失联——后续打字反转，E1 实录）。
                            let current = taino_editor_loop.peek().clone();
                            let schema = current.schema().clone();
                            let empty_para = schema
                                .node("paragraph", Default::default(), vec![], vec![])
                                .expect("empty paragraph");
                            let size: usize = (0..current.doc().child_count())
                                .map(|i| current.doc().child(i).node_size())
                                .sum();
                            let mut tx = current.tr();
                            tx.transform()
                                .replace(
                                    0,
                                    size,
                                    taino_edit_dioxus::Slice::new(
                                        taino_edit_core::Fragment::from_nodes(vec![empty_para]),
                                        0,
                                        0,
                                    ),
                                    &schema,
                                )
                                .expect("clear replace");
                            let next = current.apply(tx);
                            taino_editor_loop.set(next);
                        } else {
                            global_eval("window.__islandController && window.__islandController.clear()");
                        }
                    }
                    // E3a 菜单联动：Submit → dismiss（提交关菜单）；Edit → 触发检测 + 候选。
                    #[cfg(target_arch = "wasm32")]
                    if taino_mode {
                        if was_submit {
                            session.dismiss();
                            sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                        } else if was_edit {
                            let text = host.state().draft.snapshot.text.clone();
                            let caret = dom_caret_char_offset().unwrap_or(0);
                            let hit = composer_completion::detect_trigger(&text, caret);
                            let rev = host.state().draft.revision;
                            session.track(hit, rev);
                            if session.is_pending() {
                                if let Some(hit) = session.hit().cloned() {
                                    let candidates = demo_provider(hit.kind, &hit.query);
                                    session.apply_candidates(session.generation(), candidates);
                                }
                            }
                            sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                        }
                    }
                    #[cfg(not(target_arch = "wasm32"))]
                    let _ = (was_submit, was_edit);
                }
                AppEvent::Attach(meta) => {
                    // E3b：intake 守卫（策略）→ meta 进镜像 → Snapshot.attachment_ids 同步。
                    let current_assets: Vec<composer_intake::FileMeta> = assets_loop
                        .read()
                        .iter()
                        .map(|a| composer_intake::FileMeta {
                            name: a.name.clone(),
                            media_type: a.media_type.clone(),
                            bytes: a.bytes,
                        })
                        .collect();
                    let decision = composer_intake::intake_files(
                        &[composer_intake::FileMeta {
                            name: meta.name.clone(),
                            media_type: meta.media_type.clone(),
                            bytes: meta.bytes,
                        }],
                        &demo_intake_policy(),
                        &current_assets,
                    );
                    if let Some(&index) = decision.accepted.first() {
                        let mut next = assets_loop.read().clone();
                        next.push(AssetMeta {
                            id: format!("a-{:x}-{}", PlatformClock.now_ms(), next.len()),
                            name: meta.name.clone(),
                            media_type: meta.media_type.clone(),
                            bytes: meta.bytes,
                        });
                        let _ = index;
                        assets_loop.set(next.clone());
                        rejections_loop.set(Vec::new());
                        let snapshot = composer_core::state::Snapshot {
                            attachment_ids: next.iter().map(|a| a.id.clone()).collect(),
                            ..host.state().draft.snapshot.clone()
                        };
                        host.dispatch(Event::Edit { snapshot });
                        ledger.set(host.state().clone());
                    } else if let Some(rejection) = decision.rejected.first() {
                        rejections_loop.set(vec![(
                            rejection.name.clone(),
                            rejection.reason.as_str().to_string(),
                        )]);
                    }
                }
                AppEvent::Detach(asset_id) => {
                    let mut next = assets_loop.read().clone();
                    next.retain(|a| a.id != asset_id);
                    assets_loop.set(next.clone());
                    let snapshot = composer_core::state::Snapshot {
                        attachment_ids: next.iter().map(|a| a.id.clone()).collect(),
                        ..host.state().draft.snapshot.clone()
                    };
                    host.dispatch(Event::Edit { snapshot });
                    ledger.set(host.state().clone());
                }
                AppEvent::MoveAsset { asset_id, target_index } => {
                    // composer-reorder 纯数学：文档附件序列重排（rail 顺序 = 文档顺序）。
                    let entries: Vec<composer_reorder::AttachmentSequenceEntry> = assets_loop
                        .read()
                        .iter()
                        .map(|a| composer_reorder::AttachmentSequenceEntry {
                            node_id: String::new(),
                            asset_id: a.id.clone(),
                        })
                        .collect();
                    if let Some(span) =
                        composer_reorder::compute_move_span(&entries, &asset_id, target_index)
                    {
                        let seq = composer_reorder::apply_move_span(&entries, span);
                        let ordered: Vec<AssetMeta> = seq
                            .iter()
                            .filter_map(|entry| {
                                assets_loop.read().iter().find(|a| a.id == entry.asset_id).cloned()
                            })
                            .collect();
                        assets_loop.set(ordered.clone());
                        let snapshot = composer_core::state::Snapshot {
                            attachment_ids: ordered.iter().map(|a| a.id.clone()).collect(),
                            ..host.state().draft.snapshot.clone()
                        };
                        host.dispatch(Event::Edit { snapshot });
                        ledger.set(host.state().clone());
                    }
                }
                AppEvent::SetScenario(value) => {
                    #[cfg(target_arch = "wasm32")]
                    web_sys::console::log_1(&format!("e3d: scenario -> {value}").into());
                    host.executor_mut().scenario = value;
                }
                AppEvent::Menu(action) => {
                    #[cfg(target_arch = "wasm32")]
                    if taino_mode {
                        match action {
                            MenuAction::Up => {
                                session.move_highlight(-1);
                                sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                            }
                            MenuAction::Down => {
                                session.move_highlight(1);
                                sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                            }
                            MenuAction::Accept | MenuAction::Pick(_) => {
                                if let MenuAction::Pick(index) = action {
                                    session.set_highlight(index);
                                }
                                if let Some(pick) = session.accept() {
                                    // pick：全文按 [start,end) 替换 → 事务重建内容
                                    let text = host.state().draft.snapshot.text.clone();
                                    let hit = composer_completion::TriggerHit {
                                        kind: pick.kind,
                                        query: pick.query,
                                        start: pick.start,
                                        end: pick.end,
                                    };
                                    let (new_text, _caret) = composer_completion::apply_pick_to_text(
                                        &text,
                                        &hit,
                                        &pick.candidate.insert_text,
                                    );
                                    let schema = taino_editor_loop.peek().schema().clone();
                                    let size = doc_content_size(&taino_editor_loop);
                                    let mut tx = taino_editor_loop.peek().tr();
                                    tx.transform()
                                        .replace(0, size, text_slice(&schema, &new_text), &schema)
                                        .expect("pick replace");
                                    let next = taino_editor_loop.peek().apply(tx);
                                    taino_editor_loop.set(next);
                                }
                                session.dismiss();
                                sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                            }
                            MenuAction::Hover(index) => {
                                session.set_highlight(index);
                                sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                            }
                            MenuAction::Dismiss => {
                                session.dismiss();
                                sync_menu_view(&session, &mut menu_view_loop, &menu_open_loop);
                            }
                        }
                    }
                    #[cfg(not(target_arch = "wasm32"))]
                    let _ = (action, &session);
                }
            }
        }
        }
    });

    // E3d 测试钩子：E2E 注入回执/超时（不可靠网络判据的驱动面）。
    // 注册在 use_coroutine 之后——events 句柄此处已可用（协程内注册曾因槽位时序失效）。
    #[cfg(target_arch = "wasm32")]
    {
        let tx_test = events.clone();
        let scope_test = scope_for_hook.clone();
        let hook = Closure::<dyn FnMut(js_sys::Object)>::new(move |cmd: js_sys::Object| {
            let get = |key: &str| {
                js_sys::Reflect::get(&cmd, &JsValue::from_str(key))
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_default()
            };
            match get("kind").as_str() {
                "lookup" => {
                    let mid = MessageId::new(&get("id"));
                    let result = if get("status") == "rejected" {
                        DeliveryResult::Rejected {
                            reason: "查询回执：宿主明确拒绝".into(),
                        }
                    } else {
                        DeliveryResult::Accepted {
                            receipt: Receipt {
                                id: mid.clone(),
                                scope: ScopeId::new(scope_test.clone()),
                                turn: TurnId::new(format!("turn-{}", get("id"))),
                            },
                        }
                    };
                    tx_test.send(AppEvent::Runtime(Event::LookupResult { id: mid, result }));
                }
                "timeout" => {
                    tx_test.send(AppEvent::Runtime(Event::AttemptTimeout {
                        id: MessageId::new(&get("id")),
                        attempt: AttemptId::new(&get("attempt")),
                    }));
                }
                "scenario" => {
                    tx_test.send(AppEvent::SetScenario(get("value")));
                }
                _ => {}
            }
        });
        let window = web_sys::window().expect("no window");
        let _ = js_sys::Reflect::set(
            window.as_ref(),
            &JsValue::from_str("__composerTest"),
            &hook.as_ref().unchecked_ref(),
        );
        hook.forget();
    }

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
                Some("submit-request") => tx.send(AppEvent::Runtime(Event::Submit)),
                Some("document-changed") => {
                    if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                        tx.send(AppEvent::Runtime(Event::Edit { snapshot: Snapshot::text(text) }));
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

    // taino 文本同步：编辑器模型文档 → Runtime 草稿。编辑态唯一事实在 taino state，
    // 模型变更即草稿变更（E1：替代 island 的 document-changed 桥）。非 taino 模式下
    // taino_editor 永不变更 → effect 只在挂载跑一次 → 不发事件。
    {
        let taino_active = editor_mode_taino;
        use_effect(move || {
            let doc_text = doc_plain_text(taino_editor.read().doc());
            if taino_active {
                events.send(AppEvent::Runtime(Event::Edit { snapshot: Snapshot::text(doc_text) }));
            }
        });
    }

    // taino Enter 仲裁 keymap：composer-keynav 裁决 → Submit 进协程；
    // 组合中/宽限窗内不提交（island 的 DOM 护栏语义同构，D009/D014）。
    // History 的 undo 绑定一并挂上（Mod-z）。
    let taino_keymap = {
        let ime = ime.clone();
        let mut tx = events.clone();
        let menu_open_enter = menu_open.clone();
        let menu_open_up = menu_open.clone();
        let menu_open_down = menu_open.clone();
        let menu_open_esc = menu_open.clone();
        let tx_up = tx.clone();
        let tx_down = tx.clone();
        let tx_esc = tx.clone();
        taino_edit_dioxus::KeymapProp::new(taino_edit_dioxus::Keymap::new(
            false,
            vec![
                (
                    "Enter",
                    Box::new(move |_state, _dispatch| {
                        // E3a：菜单开着 → Enter 接受候选（不提交，KD has_menu 契约）。
                        if menu_open_enter.get() {
                            tx.send(AppEvent::Menu(MenuAction::Accept));
                            return true;
                        }
                        let now = PlatformClock.now_ms();
                        let snapshot = {
                            let guard = ime.borrow();
                            (guard.composing, guard.composing_until_ms)
                        };
                        let verdict = decide_enter(&EnterDecisionInput {
                            key: "Enter".into(),
                            shift_key: false,
                            alt_key: false,
                            ctrl_key: false,
                            meta_key: false,
                            is_composing: snapshot.0,
                            key_code: None,
                            repeat: false,
                            now_ms: now as i64,
                            composing: false,
                            composing_until_ms: snapshot.1 as i64,
                            has_menu: menu_open_enter.get(),
                            can_submit: true, // 演示恒可提交；空草稿由 Runtime FD06 兜底
                        });
                        if matches!(verdict.kind, composer_keynav::VerdictKind::Submit) {
                            tx.send(AppEvent::Runtime(Event::Submit));
                        }
                        true
                    }),
                ),
                (
                    "ArrowUp",
                    Box::new(move |_s, _d| {
                        if menu_open_up.get() {
                            tx_up.send(AppEvent::Menu(MenuAction::Up));
                            true
                        } else {
                            false // 无菜单：光标移动归编辑器
                        }
                    }),
                ),
                (
                    "ArrowDown",
                    Box::new(move |_s, _d| {
                        if menu_open_down.get() {
                            tx_down.send(AppEvent::Menu(MenuAction::Down));
                            true
                        } else {
                            false
                        }
                    }),
                ),
                (
                    "Escape",
                    Box::new(move |_s, _d| {
                        if menu_open_esc.get() {
                            tx_esc.send(AppEvent::Menu(MenuAction::Dismiss));
                            true
                        } else {
                            false
                        }
                    }),
                ),
                (
                    "Backspace",
                    Box::new(|s, d| taino_edit_core::delete_backward(s, d)),
                ),
                (
                    "Delete",
                    Box::new(|s, d| taino_edit_core::delete_forward(s, d)),
                ),
                (
                    "Shift-Enter",
                    Box::new(|s, d| taino_edit_core::split_block(s, d)),
                ),
                ("Mod-z", Box::new(|s, d| taino_edit_extensions::undo_command()(s, d))),
            ],
        ))
    };

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

    // taino 组合监听句柄 + 附件 rail 快照（E3b：避免 rsx 内裸块的语法歧义）。
    let ime_start = ime.clone();
    let ime_end = ime.clone();
    let assets_snapshot = assets.read().clone();
    let rejections_snapshot = intake_rejections.read().clone();
    // E3b rail 卡片数据预构建（rsx for 体禁 let；每卡 owned，闭包各自 move）。
    #[derive(Clone)]
    struct RailCard {
        index: usize,
        name: String,
        size_label: String,
        // 每按钮一个 id 克隆：rsx 闭包按字段 disjoint-capture move，多闭包共享
        // 同一 String 会 E0382（E3b 实录）。
        id_remove: String,
        id_back: String,
        id_forward: String,
        has_prev: bool,
        has_next: bool,
    }
    let rail_cards: Vec<RailCard> = assets_snapshot
        .iter()
        .enumerate()
        .map(|(index, a)| RailCard {
            index,
            name: a.name.clone(),
            size_label: composer_intake::format_bytes(a.bytes as i64),
            id_remove: a.id.clone(),
            id_back: a.id.clone(),
            id_forward: a.id.clone(),
            has_prev: index > 0,
            has_next: index < assets_snapshot.len() - 1,
        })
        .collect();

    rsx! {
        div { class: "panel",
            h1 { "chat-composer · Rust 面板" }
            if editor_mode_taino {
                // taino 编辑器（E1）：Dioxus 组件直挂——无 island.js 容器装载，
                // DOM 所有权归 taino 的 diff/patch 桥（计划 §4.4 同款纪律）。
                // desktop 上 editor_mode_taino 恒 false，本分支不渲染（依赖为编译桩）。
                div {
                    class: "editor",
                    oncompositionstart: move |_| ime_start.borrow_mut().start(),
                    oncompositionend: move |_| ime_end.borrow_mut().end(PlatformClock.now_ms()),
                    TainoEditor {
                        state: taino_editor,
                        keymap: taino_keymap,
                        plugins: taino_edit_dioxus::ViewPlugins::new(vec![]),
                    }
                }
                // E3a 候选菜单（TS CandidateMenu 契约同构：role=listbox + aria）。
                if let Some(view) = menu_view.read().as_ref() {
                    ul {
                        class: "candidate-menu",
                        "role": "listbox",
                        "data-testid": "candidate-menu",
                        for (index, label) in view.items.iter().enumerate() {
                            li {
                                key: "{index}",
                                "role": "option",
                                "aria-selected": "{index == view.highlight}",
                                "data-index": "{index}",
                                class: if index == view.highlight { "candidate highlighted" } else { "candidate" },
                                onmouseenter: move |_| {
                                    let tx = events.clone();
                                    tx.send(AppEvent::Menu(MenuAction::Hover(index)));
                                },
                                onclick: move |_| {
                                    let tx = events.clone();
                                    tx.send(AppEvent::Menu(MenuAction::Pick(index)));
                                },
                                "{label}"
                            }
                        }
                    }
                }
                // E3b 附件 rail（TS AttachmentCards 核心交互：卡片 + 移除 + 前移/后移）。
                // 呈现增强（缩略图/灯箱/rail 翻页/object-URL 纪律）属 TS 线完整面，E3b bounded 排除。
                if !assets_snapshot.is_empty() {
                    div {
                        class: "attachment-rail",
                        "data-testid": "attachment-rail",
                        "role": "list",
                        for card in rail_cards.clone().into_iter() {
                            div {
                                key: "{card.id_remove}",
                                class: "attachment-card",
                                "data-testid": "attachment-card",
                                "data-asset-id": "{card.id_remove}",
                                span { class: "attachment-name", "{card.name}" }
                                span { class: "attachment-meta", "{card.size_label}" }
                                button {
                                    "data-testid": "attachment-remove",
                                    onclick: move |_| events.send(AppEvent::Detach(card.id_remove.clone())),
                                    "移除"
                                }
                                if card.has_prev {
                                    button {
                                        "data-testid": "attachment-move-back",
                                        onclick: move |_| events.send(AppEvent::MoveAsset { asset_id: card.id_back.clone(), target_index: (card.index - 1) as f64 }),
                                        "←"
                                    }
                                }
                                if card.has_next {
                                    button {
                                        "data-testid": "attachment-move-forward",
                                        onclick: move |_| events.send(AppEvent::MoveAsset { asset_id: card.id_forward.clone(), target_index: (card.index + 1) as f64 }),
                                        "→"
                                    }
                                }
                            }
                        }
                    }
                }
                for rejection in rejections_snapshot.iter() {
                    p {
                        key: "{rejection.0}",
                        class: "intake-rejection",
                        "data-testid": "intake-rejection",
                        "「{rejection.0}」未添加：{rejection.1}"
                    }
                }
                input {
                    "type": "file",
                    "data-testid": "attachment-input",
                    multiple: true,
                    onchange: move |event: dioxus::prelude::Event<dioxus::prelude::FormData>| {
                        // FileData：名字 + 异步读字节（字节 host-owned，meta 进台账——D019）。
                        let tx = events.clone();
                        spawn(async move {
                            for file in event.files() {
                                let name = file.name();
                                let bytes_len = file
                                    .read_bytes()
                                    .await
                                    .map(|data| data.len() as u64)
                                    .unwrap_or(0);
                                let _ = tx.send(AppEvent::Attach(composer_intake::FileMeta {
                                    media_type: mime_from_ext(&name),
                                    name,
                                    bytes: bytes_len,
                                }));
                            }
                        });
                    },
                }
            } else if editor_mode_lexical {
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
                    events.send(AppEvent::Runtime(Event::Edit { snapshot: Snapshot::text(event.value()) }));
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
                        composer_keynav::VerdictKind::Submit => events.send(AppEvent::Runtime(Event::Submit)),
                        composer_keynav::VerdictKind::Newline => {
                            // 换行交给浏览器默认行为：不 preventDefault，textarea 自行插入。
                        }
                        _ => event.prevent_default(),
                    }
                },
            }
            }
            div { class: "actions",
                button { class: "primary", onclick: move |_| events.send(AppEvent::Runtime(Event::Submit)), disabled: draft_empty || admitting(), "发送" }
                button {
                    "data-testid": "end-turn",
                    onclick: move |_| {
                        if let Some(turn) = ledger.read().active_turn.clone() {
                            events.send(AppEvent::Runtime(Event::EndTurn(turn)));
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
fn RecordRow(events: Coroutine<AppEvent>, id: String, status: Status, text: String) -> Element {
    let recall_id = id.clone();
    let retry_id = id.clone();
    rsx! {
        li { class: "record",
            strong { {status_label(status)} }
            span { class: "text", "{text}" }
            if matches!(status, Status::Queued | Status::Rejected | Status::Cancelled) {
                button { onclick: move |_| events.send(AppEvent::Runtime(Event::Restore { id: MessageId::new(&recall_id) })), "取回编辑" }
            }
            if matches!(status, Status::Rejected) {
                button { "data-testid": "retry", onclick: move |_| events.send(AppEvent::Runtime(Event::Retry { id: MessageId::new(&retry_id) })), "原样重试" }
            }
        }
    }
}