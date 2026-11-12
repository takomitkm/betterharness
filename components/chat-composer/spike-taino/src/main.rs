//! E0 spike（pure-rust-editor-survey.md §三）：taino-edit 当 composer 的 Pure Rust Editor。
//!
//! 判据：Enter 仲裁接 composer-keynav（KD 契约）、失效模式 4（组合中 Enter 不提交）、
//! KD03 宽限窗、FM01（提交后编辑器清空）。CDP 冒烟走 spike_state() 钩子 + DOM 文本。
//!
//! ImeTracker = island keynav.ts 同款语义的 Rust 最小版（KD10）。

use composer_keynav::{decide_enter, EnterDecisionInput, VerdictKind};
use dioxus::prelude::*;
use futures_util::StreamExt;
use std::cell::RefCell;
use std::rc::Rc;
use taino_edit_dioxus::{EditorState, Keymap, KeymapProp, SchemaBuilder, TainoEditor, ViewPlugins};
use wasm_bindgen::prelude::wasm_bindgen;

/// ImeTracker 最小版：compositionstart/end 喂入，快照交给 decide_enter（KD03）。
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

fn now_ms() -> u64 {
    // wasm32-unknown-unknown 无 SystemTime（time not implemented panic 实录）——
    // 宿主注入时钟的 Clock 纪律在 spike 里直接用 js_sys::Date::now。
    js_sys::Date::now() as u64
}

fn main() {
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));
    dioxus::launch(app);
}

#[derive(Clone, Debug)]
enum SpikeEvent {
    Submit,
}

// 台账镜像：CDP 冒烟的验收面（submissions 列表）。
thread_local! {
    static SPIKE_MIRROR: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

#[wasm_bindgen]
pub fn spike_state() -> String {
    SPIKE_MIRROR.with(|cell| {
        let subs: Vec<String> = cell
            .borrow()
            .iter()
            .map(|(status, text)| format!("{{\"status\":\"{status}\",\"text\":\"{text}\"}}"))
            .collect();
        format!("[{}]", subs.join(","))
    })
}

fn app() -> Element {
    // Schema：composer 只需要 paragraph + text（多行即 text 内 \n，无 rich marks）。
    let base = SchemaBuilder::new()
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
    let exts: [&'static dyn taino_edit_extensions::Extension; 1] = [&taino_edit_extensions::Paragraph];
    let schema = taino_edit_extensions::build_schema_with(base, &exts, "doc").expect("schema builds");

    // 空起始文档：doc(block+) 至少一个块 → 一个空段落。
    let empty_para = schema
        .node("paragraph", Default::default(), vec![], vec![])
        .expect("empty paragraph");
    let doc = schema
        .node("doc", Default::default(), vec![empty_para], vec![])
        .expect("doc node");

    let mut editor: Signal<EditorState> = use_signal(|| EditorState::new(doc, schema.clone()));
    let schema_clear = schema.clone();

    // ImeTracker：组合事件在 TainoEditor 内部消化，宿主用根级监听拿状态（island 同款）。
    let ime = use_hook(|| Rc::new(RefCell::new(ImeTracker::default())));

    // 回环台账：Submit → accepted 记录 + FM01 清编辑器（协程单消费者）。
    let mut submissions: Signal<Vec<(String, String)>> = use_signal(Vec::new);

    let mut editor_loop = editor.clone();
    let mut submissions_loop = submissions.clone();
    let events = use_coroutine(
        move |mut rx: UnboundedReceiver<SpikeEvent>| async move {
            while let Some(ev) = rx.next().await {
                match ev {
                    SpikeEvent::Submit => {
                        let text = web_sys::window()
                            .and_then(|w| w.document())
                            .and_then(|d| {
                                d.query_selector("[contenteditable=\"true\"]").ok().flatten()
                            })
                            .and_then(|el| el.text_content())
                            .unwrap_or_default();
                        SPIKE_MIRROR.with(|cell| {
                            cell.borrow_mut().push(("accepted".into(), text.clone()))
                        });
                        submissions_loop.push(("accepted".into(), text));
                        // Schema 就存在 EditorState 里，无需跨协程捕获非 Copy 类型
                        let schema = editor_loop.peek().schema().clone();
                        let empty_para = schema
                            .node("paragraph", Default::default(), vec![], vec![])
                            .expect("empty paragraph");
                        let empty = schema
                            .node("doc", Default::default(), vec![empty_para], vec![])
                            .expect("empty doc");
                        editor_loop.set(EditorState::new(empty, schema));
                    }
                }
            }
    });

    // Enter 仲裁命令：composer-keynav 裁决 → Submit 发协程（Box<dyn Fn> 里不能拿
    // &mut——状态变更全在协程，composer-host 同款架构）。
    let keymap = {
        let ime = ime.clone();
        let mut tx = events.clone();
        KeymapProp::new(Keymap::new(
            false,
            vec![(
                "Enter",
                Box::new(move |_state, _dispatch| {
                    let now = now_ms();
                    let snapshot = { let guard = ime.borrow(); (guard.composing, guard.composing_until_ms) };
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
                        has_menu: false,
                        can_submit: true, // 演示恒可提交；空草稿由宿主守卫
                    });
                    if matches!(verdict.kind, VerdictKind::Submit) {
                        tx.send(SpikeEvent::Submit);
                    }
                    true
                }),
            )],
        ))
    };

    let ime_start = ime.clone();
    let ime_end = ime.clone();

    rsx! {
        div { class: "panel",
            h1 { "spike: taino-edit + composer-keynav" }
            div {
                oncompositionstart: move |_| ime_start.borrow_mut().start(),
                oncompositionend: move |_| ime_end.borrow_mut().end(now_ms()),
                TainoEditor { state: editor, keymap, plugins: ViewPlugins::new(vec![]) }
            }
            p { class: "status",
                if submissions.read().is_empty() {
                    "Enter 发送"
                } else {
                    "已提交 {submissions.read().len()} 条"
                }
            }
            ol { class: "outbox",
                for (status, text) in submissions.read().iter() {
                    li { class: "record", strong { "{status}" } span { class: "text", "{text}" } }
                }
            }
        }
    }
}
