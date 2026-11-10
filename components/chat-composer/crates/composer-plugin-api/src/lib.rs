//! 插件贡献协议（计划书 §3）：插件不直接操纵 UI，而是贡献 UI 描述与行为。
//!
//! 本 crate 与 UI 框架无关——Dioxus/GPUI/Slint 都能实现同一个 Registry 消费契约。
//! 两类贡献：
//! - 命令（[`CommandContribution`]）：行为入口，宿主把按钮/快捷键接到命令上；
//! - 视图（[`ViewContribution`]）：UI 描述（slot + 组件名 + props），PluginSlot 按
//!   注册信息构造真正的界面元素。
//!
//! 外部 WASM 插件（Component Model / WIT / Wasmtime）是下一步；届时同一协议由 WIT
//! 接口描述，本 crate 的类型保持为宿主侧的权威形状。

use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

/// UI 贡献的挂载点。宿主在固定位置提供 slot（如 "attachment.card.tools"），
/// 插件把视图描述贡献到 slot 上，由宿主的 PluginSlot 渲染。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SlotId(pub String);

/// 命令标识。命令实现可以来自任何插件；宿主按 id 解析。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CommandId(pub String);

/// 命令实现：payload 进、结果出，都是 JSON。宿主负责 JSON 与内部类型的换算。
pub trait CommandHandler: Send + Sync {
    fn invoke(&self, payload: &Value) -> Result<Value, String>;
}

/// UI 描述：把「组件名 + 属性」交给宿主的 PluginSlot，而不是插件自己渲染。
#[derive(Clone, Debug, PartialEq)]
pub struct ViewContribution {
    pub slot: SlotId,
    /// 组件名由宿主解析（如 "button" / "text-input"）；复杂组件另立 UI 扩展接口。
    pub component: String,
    pub label: String,
    /// 点击后触发的命令 id（可选）。
    pub action: Option<CommandId>,
    /// 传给组件的其余属性（JSON 对象）。
    pub props: Value,
    /// 同 slot 内的排序权重，小者在前；同权重按注册顺序。
    pub order: i32,
    /// 贡献来源插件（注册时由 registry 填写）。
    pub plugin: String,
}

/// 插件最小契约：报名字 + 贡献。内置插件编译期链接，外部插件（WASM）经同一协议接入。
pub trait Plugin: Send + Sync {
    fn id(&self) -> &'static str;
    fn register(&self, registry: &mut Registry);
}

/// 组件注册表：命令与视图贡献的聚合点。宿主构造一次，插件的 register 向它写入。
#[derive(Default)]
pub struct Registry {
    commands: BTreeMap<String, Arc<dyn CommandHandler>>,
    views: Vec<ViewContribution>,
    plugins: Vec<String>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册命令实现；同名重复注册视为错误（插件间冲突要显式，不静默覆盖）。
    pub fn register_command(
        &mut self,
        id: &str,
        handler: Arc<dyn CommandHandler>,
    ) -> Result<(), String> {
        if self.commands.contains_key(id) {
            return Err(format!("command already registered: {id}"));
        }
        self.commands.insert(id.to_string(), handler);
        Ok(())
    }

    /// 注册一条 UI 贡献；plugin 字段由 registry 依据当前注册中的插件自动填写。
    pub fn register_view(&mut self, plugin: &str, contribution: ViewContribution) {
        let mut contribution = contribution;
        contribution.plugin = plugin.to_string();
        self.views.push(contribution);
    }

    /// 记录已注册插件（用于清单核对与依赖解析）。
    pub fn note_plugin(&mut self, id: &str) {
        self.plugins.push(id.to_string());
    }

    pub fn command(&self, id: &str) -> Option<Arc<dyn CommandHandler>> {
        self.commands.get(id).cloned()
    }

    /// 某 slot 的全部视图贡献，按 (order, 注册顺序) 稳定排序。
    pub fn slot_views(&self, slot: &str) -> Vec<ViewContribution> {
        let mut views: Vec<ViewContribution> = self
            .views
            .iter()
            .filter(|view| view.slot.0 == slot)
            .cloned()
            .collect();
        views.sort_by_key(|view| view.order);
        views
    }

    pub fn views(&self) -> &[ViewContribution] {
        &self.views
    }

    pub fn plugins(&self) -> &[String] {
        &self.plugins
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct Echo;
    impl CommandHandler for Echo {
        fn invoke(&self, payload: &Value) -> Result<Value, String> {
            Ok(json!({ "echo": payload.clone() }))
        }
    }

    struct Counter(Mutex<u32>);
    impl CommandHandler for Counter {
        fn invoke(&self, _payload: &Value) -> Result<Value, String> {
            let mut count = self.0.lock().unwrap();
            *count += 1;
            Ok(json!({ "count": *count }))
        }
    }

    #[test]
    fn commands_register_and_resolve_without_silent_overwrite() {
        let mut registry = Registry::new();
        registry.register_command("copy", Arc::new(Echo)).unwrap();
        assert!(
            registry.register_command("copy", Arc::new(Echo)).is_err(),
            "同名重复注册必须显式报错"
        );
        let handler = registry.command("copy").unwrap();
        let result = handler.invoke(&json!({"id": "m1"})).unwrap();
        assert_eq!(result, json!({"echo": {"id": "m1"}}));
    }

    #[test]
    fn stateful_handlers_keep_state_across_invocations() {
        let mut registry = Registry::new();
        registry
            .register_command("tick", Arc::new(Counter(Mutex::new(0))))
            .unwrap();
        let handler = registry.command("tick").unwrap();
        handler.invoke(&json!(null)).unwrap();
        let second = handler.invoke(&json!(null)).unwrap();
        assert_eq!(second, json!({"count": 2}));
    }

    #[test]
    fn slot_views_are_stable_sorted_by_order_then_registration() {
        let mut registry = Registry::new();
        registry.note_plugin("p2");
        registry.register_view(
            "p2",
            ViewContribution {
                slot: SlotId("attachment.card.tools".into()),
                component: "button".into(),
                label: "后移".into(),
                action: None,
                props: json!({}),
                order: 20,
                plugin: String::new(),
            },
        );
        registry.register_view(
            "p2",
            ViewContribution {
                slot: SlotId("attachment.card.tools".into()),
                component: "toggle-button".into(),
                label: "原图".into(),
                action: None,
                props: json!({}),
                order: 10,
                plugin: String::new(),
            },
        );
        let views = registry.slot_views("attachment.card.tools");
        assert_eq!(
            views
                .iter()
                .map(|view| view.label.as_str())
                .collect::<Vec<_>>(),
            vec!["原图", "后移"]
        );
        assert!(registry.slot_views("other.slot").is_empty());
    }
}
