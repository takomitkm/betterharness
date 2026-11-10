//! 内置插件示范（计划书 §3）：把旧 TS 实现的附件卡片功能——替代文本、压缩/原图开关、
//! 前移/后移——按 cordis 形态注册为「命令 + 槽位贡献 + 候选来源」，而不是插件自己渲染 UI。
//!
//! 这是「细组件 + 组合」的样板：宿主在卡片上提供 `attachment.card.tools` / `.body`
//! 挂载点，PluginSlot 按 Slots 服务的贡献渲染；用户操作触发 Commands 服务的命令，
//! 命令调 composer-reorder 等细组件完成实际工作。改 composer-composition 的分层清单
//! （Profile + Bundle + Patch）即可重排/禁用/替换这些工具，无需重编译主程序。

use composer_plugin_api::{
    CandidateDto, CommandHandler, CommandId, CompletionSource, FiberId, Loader, SlotId,
    TriggerKind, ViewContribution,
};
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

/// @ 文件候选来源（≈ DSH ui-input-trigger 的来源注册）：demo 实现为静态清单，
/// 真实宿主接文件系统/上传列表；查询是透明字符串，代次守卫在 composer-completion。
pub fn file_completion_source() -> CompletionSource {
    CompletionSource {
        name: "attachment-files".into(),
        triggers: vec![TriggerKind::Reference],
        fetch: Arc::new(|query| {
            let known = ["报告.docx", "截图.png", "数据.csv", "方案.pdf"];
            known
                .iter()
                .filter(|name| name.contains(query))
                .map(|name| CandidateDto {
                    label: (*name).into(),
                    insert_text: (*name).into(),
                })
                .collect()
        }),
    }
}

/// 附件工具插件（cordis Fiber 形态）：挂载进 Loader，注册命令、槽位贡献与候选来源。
/// 全部注册都是可逆副作用——经组合清单卸载时统一回收。
pub struct AttachmentToolsPlugin;

impl AttachmentToolsPlugin {
    pub const ID: &'static str = "attachment-tools";
}

impl composer_plugin_api::Mountable for AttachmentToolsPlugin {
    fn id(&self) -> &'static str {
        Self::ID
    }

    fn mount(&self, loader: &mut Loader) -> Result<FiberId, String> {
        loader.mount(composer_plugin_api::fiber(Self::ID), |scope| {
            scope.commands().register("attachment.alt.set", Arc::new(SetAltText))?;
            scope.commands().register("attachment.send-as-file.toggle", Arc::new(ToggleSendAsFile))?;
            scope.commands().register("attachment.move.backward", Arc::new(MoveAttachment { direction: -1 }))?;
            scope.commands().register("attachment.move.forward", Arc::new(MoveAttachment { direction: 1 }))?;

            scope.slots().register_view(Self::ID, ViewContribution {
                slot: SlotId(SLOT_CARD_TOOLS.into()),
                component: "toggle-button".into(),
                label: "压缩/原图".into(),
                action: Some(CommandId("attachment.send-as-file.toggle".into())),
                props: json!({ "pressedKey": "sendAsFile", "pressedLabel": "原图", "idleLabel": "压缩" }),
                order: 10,
                plugin: String::new(),
            });
            scope.slots().register_view(Self::ID, ViewContribution {
                slot: SlotId(SLOT_CARD_TOOLS.into()),
                component: "button".into(),
                label: "前移".into(),
                action: Some(CommandId("attachment.move.backward".into())),
                props: json!({ "disabledWhen": "at-first" }),
                order: 20,
                plugin: String::new(),
            });
            scope.slots().register_view(Self::ID, ViewContribution {
                slot: SlotId(SLOT_CARD_TOOLS.into()),
                component: "button".into(),
                label: "后移".into(),
                action: Some(CommandId("attachment.move.forward".into())),
                props: json!({ "disabledWhen": "at-last" }),
                order: 30,
                plugin: String::new(),
            });
            scope.slots().register_view(Self::ID, ViewContribution {
                slot: SlotId(SLOT_CARD_BODY.into()),
                component: "text-input".into(),
                label: "替代文本".into(),
                action: Some(CommandId("attachment.alt.set".into())),
                props: json!({ "placeholder": "替代文本", "ariaKey": "alt" }),
                order: 10,
                plugin: String::new(),
            });

            // 候选来源（≈ registerSource）：菜单消费来源服务，来源可来自任何插件。
            scope.completion_sources().register(file_completion_source());
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_plugin_api::{Commands, Slots};
    use serde_json::json;

    fn mounted() -> Loader {
        let mut loader = Loader::new();
        composer_plugin_api::Mountable::mount(&AttachmentToolsPlugin, &mut loader).unwrap();
        loader
    }

    /// 插件注册：命令与两类 slot 的贡献都在，顺序按 order。
    #[test]
    fn registers_commands_and_ui_contributions() {
        let loader = mounted();
        let commands = loader.context().get::<Commands>().unwrap();
        assert_eq!(commands.ids().len(), 4);
        let slots = loader.context().get::<Slots>().unwrap();
        let tools = slots.slot_views(SLOT_CARD_TOOLS);
        assert_eq!(
            tools
                .iter()
                .map(|view| view.label.as_str())
                .collect::<Vec<_>>(),
            vec!["压缩/原图", "前移", "后移"],
            "order 10/20/30 决定渲染顺序"
        );
        assert_eq!(slots.slot_views(SLOT_CARD_BODY).len(), 1);
        for view in slots.views() {
            assert_eq!(view.plugin, "attachment-tools", "槽位服务登记贡献来源");
        }
    }

    /// alt 命令：产出元数据补丁；过长显式报错。
    #[test]
    fn set_alt_command_produces_metadata_patch() {
        let loader = mounted();
        let handler = loader
            .context()
            .get::<Commands>()
            .unwrap()
            .handler("attachment.alt.set")
            .unwrap();
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
        let loader = mounted();
        let handler = loader
            .context()
            .get::<Commands>()
            .unwrap()
            .handler("attachment.send-as-file.toggle")
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
        let loader = mounted();
        let order = json!([
            { "nodeId": "n0", "assetId": "f0" },
            { "nodeId": "n1", "assetId": "f1" },
            { "nodeId": "n2", "assetId": "f2" }
        ]);
        let forward = loader
            .context()
            .get::<Commands>()
            .unwrap()
            .handler("attachment.move.forward")
            .unwrap();
        let span = forward
            .invoke(&json!({ "assetId": "f0", "order": order }))
            .unwrap();
        assert_eq!(
            span,
            json!({ "assetId": "f0", "removeFrom": 0, "insertAt": 1 })
        );
        let backward = loader
            .context()
            .get::<Commands>()
            .unwrap()
            .handler("attachment.move.backward")
            .unwrap();
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

    /// 候选来源已注册并被菜单消费。
    #[test]
    fn completion_source_registered() {
        let loader = mounted();
        let sources = loader
            .context()
            .get::<composer_plugin_api::CompletionSources>()
            .unwrap();
        let reference = sources.for_trigger(TriggerKind::Reference);
        assert_eq!(reference.len(), 1);
        assert_eq!(
            (reference[0].fetch)("截图").len(),
            1,
            "fetch 是字段闭包，直接调用"
        );
        assert_eq!((reference[0].fetch)("截图")[0].label, "截图.png");
    }
}
