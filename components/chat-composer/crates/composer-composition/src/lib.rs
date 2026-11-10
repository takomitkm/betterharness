//! 组合引擎（Composition Engine）：解析声明式清单（TOML，计划书 §4 的「组件重组」层），
//! 把多个插件的 UI 贡献合并成槽位计划。
//!
//! 三层自定义的「组件重组」就在这里：改一份 TOML 清单即可重排/禁用槽位贡献，
//! 无需重新编译主程序。业务插件（Rust→WASM）与深度原生扩展（crate）见计划书 §2。
//!
//! 清单形状：
//!
//! ```toml
//! load = ["attachment-tools", "extra-tools"]
//!
//! [slots."attachment.card.tools"]
//! order = ["extra-tools:pin", "attachment-tools:mode"]
//!
//! disabled = ["extra-tools:pin"]
//! ```
//!
//! 合并规则：
//! - `load` 声明要加载的插件（按顺序注册进 registry）；
//! - `[slots]` 的每个槽位给出 "插件:组件" 顺序覆盖；未列出的贡献按注册顺序殿后；
//! - `disabled` 显式剔除贡献。

use composer_plugin_api::{Registry, ViewContribution};
use serde::Deserialize;
use std::collections::BTreeMap;

/// 槽位的顺序覆盖："插件:组件" 的显式顺序。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SlotOverride {
    pub order: Vec<String>,
}

/// 声明式组合清单（TOML）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompositionManifest {
    /// 要加载的插件 id，按顺序注册。
    pub load: Vec<String>,
    /// 槽位顺序覆盖。
    pub slots: BTreeMap<String, SlotOverride>,
    /// 显式禁用的贡献："插件:组件"。
    pub disabled: Vec<String>,
}

#[derive(Deserialize)]
struct ManifestToml {
    #[serde(default)]
    load: Vec<String>,
    #[serde(default)]
    slots: BTreeMap<String, SlotOverrideToml>,
    #[serde(default)]
    disabled: Vec<String>,
}

#[derive(Deserialize)]
struct SlotOverrideToml {
    #[serde(default)]
    order: Vec<String>,
}

impl CompositionManifest {
    pub fn parse(text: &str) -> Result<CompositionManifest, String> {
        let parsed: ManifestToml =
            toml::from_str(text).map_err(|error| format!("清单解析失败: {error}"))?;
        for slot in parsed.slots.keys() {
            if slot.is_empty() {
                return Err("槽位名不能为空".into());
            }
        }
        Ok(CompositionManifest {
            load: parsed.load,
            slots: parsed
                .slots
                .into_iter()
                .map(|(slot, order)| (slot, SlotOverride { order: order.order }))
                .collect(),
            disabled: parsed.disabled,
        })
    }
}

/// 组合产物：slot → 排序后的视图贡献。宿主的 PluginSlot 直接消费它。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompositionPlan {
    pub slots: BTreeMap<String, Vec<ViewContribution>>,
}

/// 每个插件贡献在清单里的 key："插件:组件"。
fn contribution_key(view: &ViewContribution) -> String {
    format!("{}:{}", view.plugin, view.component)
}

/// 依据清单把 registry 里的贡献合并成槽位计划。
pub fn compose(registry: &Registry, manifest: &CompositionManifest) -> CompositionPlan {
    let mut plan = CompositionPlan::default();
    // 收集所有出现过的 slot（稳定顺序 = BTreeMap 键序）。
    let mut slot_ids: Vec<String> = registry
        .views()
        .iter()
        .map(|view| view.slot.0.clone())
        .chain(manifest.slots.keys().cloned())
        .collect();
    slot_ids.sort();
    slot_ids.dedup();
    for slot in slot_ids {
        let mut views: Vec<ViewContribution> = registry.slot_views(&slot);
        // 显式禁用。
        views.retain(|view| !manifest.disabled.contains(&contribution_key(view)));
        // 顺序覆盖：列出的按清单序前置，未列出的按注册序殿后。
        if let Some(order) = manifest.slots.get(&slot) {
            views.sort_by_key(|view| {
                let key = contribution_key(view);
                let position = order.order.iter().position(|entry| entry == &key);
                (position.map_or(usize::MAX, |value| value), view.order)
            });
        }
        plan.slots.insert(slot, views);
    }
    plan
}

/// 按清单把插件注册进 registry 的帮助器：清单里列出但缺失的插件 id 必须显式报错。
pub fn install_plugins(
    registry: &mut Registry,
    manifest: &CompositionManifest,
    lookup: &dyn Fn(&str) -> Option<Box<dyn composer_plugin_api::Plugin>>,
) -> Result<(), String> {
    for id in &manifest.load {
        let Some(plugin) = lookup(id) else {
            return Err(format!("清单要求加载的插件不存在: {id}"));
        };
        plugin.register(registry);
        registry.note_plugin(plugin.id());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_plugin_api::{CommandId, Plugin, Registry, SlotId};
    use serde_json::json;

    const MANIFEST: &str = r#"
# 组件重组层：改这里即可重排附件卡片工具，无需重编译
load = ["attachment-tools", "extra-tools"]

[slots."attachment.card.tools"]
order = ["extra-tools:pin", "attachment-tools:mode"]

disabled = []
"#;

    struct StubPlugin {
        id: &'static str,
    }
    impl Plugin for StubPlugin {
        fn id(&self) -> &'static str {
            self.id
        }
        fn register(&self, registry: &mut Registry) {
            let (slot, component, order) = match self.id {
                "attachment-tools" => ("attachment.card.tools", "mode", 10),
                _ => ("attachment.card.tools", "pin", 50),
            };
            registry.register_view(
                self.id(),
                ViewContribution {
                    slot: SlotId(slot.into()),
                    component: component.into(),
                    label: component.into(),
                    action: Some(CommandId("noop".into())),
                    props: json!({}),
                    order,
                    plugin: String::new(),
                },
            );
        }
    }

    fn lookup(id: &str) -> Option<Box<dyn Plugin>> {
        match id {
            "attachment-tools" => Some(Box::new(StubPlugin {
                id: "attachment-tools",
            })),
            "extra-tools" => Some(Box::new(StubPlugin { id: "extra-tools" })),
            _ => None,
        }
    }

    /// 清单解析：load/slots/disabled 全部落地；坏清单显式报错。
    #[test]
    fn manifest_parse_and_errors() {
        let manifest = CompositionManifest::parse(MANIFEST).unwrap();
        assert_eq!(
            manifest.load,
            vec!["attachment-tools".to_string(), "extra-tools".to_string()]
        );
        assert_eq!(
            manifest.slots["attachment.card.tools"].order,
            vec![
                "extra-tools:pin".to_string(),
                "attachment-tools:mode".to_string()
            ]
        );
        assert!(CompositionManifest::parse("load = 3").is_err());
    }

    /// 组合：清单顺序覆盖注册顺序；缺失插件显式报错。
    #[test]
    fn compose_applies_slot_overrides_and_registration_order() {
        let mut registry = Registry::new();
        let manifest = CompositionManifest::parse(MANIFEST).unwrap();
        install_plugins(&mut registry, &manifest, &lookup).unwrap();
        let plan = compose(&registry, &manifest);
        let views = &plan.slots["attachment.card.tools"];
        assert_eq!(
            views
                .iter()
                .map(|view| contribution_key(view))
                .collect::<Vec<_>>(),
            vec!["extra-tools:pin", "attachment-tools:mode"],
            "清单覆盖顺序生效"
        );
        // 未列出的贡献按注册顺序殿后。
        let mut registry = Registry::new();
        install_plugins(&mut registry, &manifest, &lookup).unwrap();
        let plan = compose(&registry, &CompositionManifest::default());
        let views = &plan.slots["attachment.card.tools"];
        assert_eq!(
            views
                .iter()
                .map(|view| contribution_key(view))
                .collect::<Vec<_>>(),
            vec!["attachment-tools:mode", "extra-tools:pin"],
            "默认按注册顺序"
        );
        let missing = CompositionManifest {
            load: vec!["ghost".into()],
            ..Default::default()
        };
        assert!(
            install_plugins(&mut Registry::new(), &missing, &|_| None).is_err(),
            "缺失插件显式报错"
        );
    }

    /// disabled 显式剔除贡献。
    #[test]
    fn disabled_contributions_are_removed_from_the_plan() {
        let mut registry = Registry::new();
        let manifest = CompositionManifest::parse(MANIFEST).unwrap();
        install_plugins(&mut registry, &manifest, &lookup).unwrap();
        let manifest = CompositionManifest {
            disabled: vec!["extra-tools:pin".into()],
            ..manifest
        };
        let plan = compose(&registry, &manifest);
        let views = &plan.slots["attachment.card.tools"];
        assert_eq!(
            views
                .iter()
                .map(|view| contribution_key(view))
                .collect::<Vec<_>>(),
            vec!["attachment-tools:mode"]
        );
    }
}
