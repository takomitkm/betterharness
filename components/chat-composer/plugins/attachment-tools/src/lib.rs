//! 内置插件示范（计划书 §3）：把旧 TS 实现的附件卡片功能——替代文本、压缩/原图开关、
//! 前移/后移——作为「命令 + UI 贡献」注册，而不是插件自己渲染 UI。
//!
//! 这是「细组件 + 组合」的样板：宿主（Dioxus/GPUI/任何框架）读取 slot 贡献渲染卡片，
//! 用户操作触发命令，命令调用本 crate 与 composer-reorder 的纯逻辑完成实际工作。
//! 改 composer-composition 的 TOML 清单即可重排/禁用这些工具，无需重编译主程序。

use composer_plugin_api::{CommandHandler, CommandId, Plugin, Registry, SlotId, ViewContribution};
use serde_json::json;
use std::sync::Arc;

/// 每张附件卡片的工具区贡献 slot（宿主在卡片上提供该挂载点）。
pub const SLOT_CARD_TOOLS: &str = "attachment.card.tools";
/// 卡片主体的贡献 slot（替代文本输入等）。
pub const SLOT_CARD_BODY: &str = "attachment.card.body";

/// alt 替代文本命令：校验并产出元数据补丁（无障碍，随快照持久化并进入发送载荷）。
pub struct SetAltText;
impl CommandHandler for SetAltText {
    fn invoke(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let asset_id = payload
            .get("assetId")
            .and_then(|value| value.as_str())
            .ok_or("缺少 assetId")?;
        let alt = payload
            .get("alt")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if alt.chars().count() > 2000 {
            return Err("替代文本过长".into());
        }
        Ok(json!({ "assetId": asset_id, "patch": { "alt": alt } }))
    }
}

/// 压缩/原图切换命令：翻转 sendAsFile 标志（组件只存标志，编码由宿主发送管线消费）。
pub struct ToggleSendAsFile;
impl CommandHandler for ToggleSendAsFile {
    fn invoke(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let asset_id = payload
            .get("assetId")
            .and_then(|value| value.as_str())
            .ok_or("缺少 assetId")?;
        let current = payload
            .get("sendAsFile")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        Ok(json!({ "assetId": asset_id, "patch": { "sendAsFile": !current } }))
    }
}

/// 前移/后移命令：目标下标换算交给 composer-reorder 的纯数学（移动跨度 + 一步撤销归编辑器）。
pub struct MoveAttachment {
    pub direction: i64,
}
impl CommandHandler for MoveAttachment {
    fn invoke(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let asset_id = payload
            .get("assetId")
            .and_then(|value| value.as_str())
            .ok_or("缺少 assetId")?;
        let nodes = payload
            .get("order")
            .and_then(|value| value.as_array())
            .ok_or("缺少文档附件序列 order")?;
        let entries: Vec<composer_reorder::AttachmentSequenceEntry> = nodes
            .iter()
            .map(|node| composer_reorder::AttachmentSequenceEntry {
                node_id: node
                    .get("nodeId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .into(),
                asset_id: node
                    .get("assetId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .into(),
            })
            .collect();
        let current = entries
            .iter()
            .position(|entry| entry.asset_id == asset_id)
            .ok_or("附件不在有序文档里")?;
        let span = composer_reorder::compute_move_span(
            &entries,
            asset_id,
            (current as i64 + self.direction) as f64,
        )
        .ok_or("已在该方向端点，无需移动")?;
        Ok(
            json!({ "assetId": asset_id, "removeFrom": span.remove_from, "insertAt": span.insert_at }),
        )
    }
}

/// 附件工具插件。注册三组贡献：命令、卡片工具区（压缩/原图 + 前移/后移）、卡片主体（替代文本）。
pub struct AttachmentToolsPlugin;

impl Plugin for AttachmentToolsPlugin {
    fn id(&self) -> &'static str {
        "attachment-tools"
    }

    fn register(&self, registry: &mut Registry) {
        registry
            .register_command("attachment.alt.set", Arc::new(SetAltText))
            .expect("首装不冲突");
        registry
            .register_command("attachment.send-as-file.toggle", Arc::new(ToggleSendAsFile))
            .expect("首装不冲突");
        registry
            .register_command(
                "attachment.move.backward",
                Arc::new(MoveAttachment { direction: -1 }),
            )
            .expect("首装不冲突");
        registry
            .register_command(
                "attachment.move.forward",
                Arc::new(MoveAttachment { direction: 1 }),
            )
            .expect("首装不冲突");

        let tools: SlotId = SlotId(SLOT_CARD_TOOLS.into());
        registry.register_view(self.id(), ViewContribution {
            slot: tools.clone(),
            component: "toggle-button".into(),
            label: "压缩/原图".into(),
            action: Some(CommandId("attachment.send-as-file.toggle".into())),
            props: json!({ "pressedKey": "sendAsFile", "pressedLabel": "原图", "idleLabel": "压缩" }),
            order: 10,
            plugin: String::new(),
        });
        registry.register_view(
            self.id(),
            ViewContribution {
                slot: tools.clone(),
                component: "button".into(),
                label: "前移".into(),
                action: Some(CommandId("attachment.move.backward".into())),
                props: json!({ "disabledWhen": "at-first" }),
                order: 20,
                plugin: String::new(),
            },
        );
        registry.register_view(
            self.id(),
            ViewContribution {
                slot: tools,
                component: "button".into(),
                label: "后移".into(),
                action: Some(CommandId("attachment.move.forward".into())),
                props: json!({ "disabledWhen": "at-last" }),
                order: 30,
                plugin: String::new(),
            },
        );
        registry.register_view(
            self.id(),
            ViewContribution {
                slot: SlotId(SLOT_CARD_BODY.into()),
                component: "text-input".into(),
                label: "替代文本".into(),
                action: Some(CommandId("attachment.alt.set".into())),
                props: json!({ "placeholder": "替代文本", "ariaKey": "alt" }),
                order: 10,
                plugin: String::new(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_plugin_api::Registry;
    use serde_json::json;

    fn registry() -> Registry {
        let mut registry = Registry::new();
        AttachmentToolsPlugin.register(&mut registry);
        registry.note_plugin(AttachmentToolsPlugin.id());
        registry
    }

    /// 插件注册：命令与两类 slot 的贡献都在，顺序按 order。
    #[test]
    fn registers_commands_and_ui_contributions() {
        let registry = registry();
        assert_eq!(registry.plugins(), vec!["attachment-tools"]);
        assert!(registry.command("attachment.alt.set").is_some());
        assert!(registry.command("attachment.send-as-file.toggle").is_some());
        assert!(registry.command("attachment.move.backward").is_some());
        assert!(registry.command("attachment.move.forward").is_some());
        let tools = registry.slot_views(SLOT_CARD_TOOLS);
        assert_eq!(
            tools
                .iter()
                .map(|view| view.label.as_str())
                .collect::<Vec<_>>(),
            vec!["压缩/原图", "前移", "后移"],
            "order 10/20/30 决定渲染顺序"
        );
        assert_eq!(registry.slot_views(SLOT_CARD_BODY).len(), 1);
        for view in registry.views() {
            assert_eq!(view.plugin, "attachment-tools", "registry 填写贡献来源");
        }
    }

    /// alt 命令：产出元数据补丁；过长显式报错。
    #[test]
    fn set_alt_command_produces_metadata_patch() {
        let handler = registry().command("attachment.alt.set").unwrap();
        let patch = handler
            .invoke(&json!({ "assetId": "f1", "alt": "一只猫" }))
            .unwrap();
        assert_eq!(
            patch,
            json!({ "assetId": "f1", "patch": { "alt": "一只猫" } })
        );
        assert!(
            handler.invoke(&json!({ "alt": "" })).is_err(),
            "缺 assetId 显式报错"
        );
        let long = "长".repeat(2001);
        assert!(handler
            .invoke(&json!({ "assetId": "f1", "alt": long }))
            .is_err());
    }

    /// 压缩/原图命令：按当前值翻转。
    #[test]
    fn toggle_command_flips_send_as_file() {
        let handler = registry()
            .command("attachment.send-as-file.toggle")
            .unwrap();
        let off = handler
            .invoke(&json!({ "assetId": "f1", "sendAsFile": false }))
            .unwrap();
        assert_eq!(
            off,
            json!({ "assetId": "f1", "patch": { "sendAsFile": true } })
        );
        let on = handler
            .invoke(&json!({ "assetId": "f1", "sendAsFile": true }))
            .unwrap();
        assert_eq!(
            on,
            json!({ "assetId": "f1", "patch": { "sendAsFile": false } })
        );
    }

    /// 前移/后移命令：经 composer-reorder 算跨度；端点处显式拒绝（UI 据此禁用）。
    #[test]
    fn move_commands_compute_span_via_reorder() {
        let registry = registry();
        let order = json!([
            { "nodeId": "n0", "assetId": "f0" },
            { "nodeId": "n1", "assetId": "f1" },
            { "nodeId": "n2", "assetId": "f2" }
        ]);
        let forward = registry.command("attachment.move.forward").unwrap();
        let span = forward
            .invoke(&json!({ "assetId": "f0", "order": order }))
            .unwrap();
        assert_eq!(
            span,
            json!({ "assetId": "f0", "removeFrom": 0, "insertAt": 1 })
        );
        let backward = registry.command("attachment.move.backward").unwrap();
        assert!(
            backward
                .invoke(&json!({ "assetId": "f0", "order": order }))
                .is_err(),
            "首位的后移应被 UI 禁用并显式拒绝"
        );
        let span = backward
            .invoke(&json!({ "assetId": "f2", "order": order }))
            .unwrap();
        assert_eq!(
            span,
            json!({ "assetId": "f2", "removeFrom": 2, "insertAt": 1 })
        );
    }
}
