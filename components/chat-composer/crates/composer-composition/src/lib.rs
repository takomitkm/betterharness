//! 组合引擎（Composition Engine）：**Profile + Bundle + Patch 分层组合**
//! （计划书 §2B，DSH 模式 B）——用户在不修改上游源码的情况下重新决定系统由什么组成。
//!
//! 层叠顺序（后层经稳定 ID 覆盖前层）：
//!
//! ```text
//! Base Profile → Bundle A → Bundle B → Profile Patch → User Patch → CLI Override（运行时入参）
//! ```
//!
//! TOML 形状：
//!
//! ```toml
//! [[bundles]]
//! id = "base"
//! plugins = ["attachment-tools"]
//!
//! [[patches]]
//! id = "user"
//! replace = { storage = "storage-sqlite" }   # 稳定 ID 替换实现
//! disable = ["extra-tools:pin"]              # 禁用贡献（保留装载，随时恢复）
//!
//! [patches.slots."attachment.card.tools"]
//! order = ["extra-tools:pin", "attachment-tools:mode"]
//! ```
//!
//! - `replace`：装载解析时把插件 id X 替换为 Y（换 Provider 不改 Consumer）；
//! - `disable`：剔除已注册贡献（cordis.patch.yml 语义：禁用保留装载，随时恢复）；
//! - 缺失/失败的组件**显式报错**（DSH：失败 bundle 留列表报错）。

use composer_plugin_api::{FiberId, Loader, Mountable, Slots, ViewContribution};
use serde::Deserialize;
use std::collections::BTreeMap;

/// 一个装载组：有序组件列表。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Bundle {
    pub id: String,
    pub plugins: Vec<String>,
}

/// 一个补丁层：稳定 ID 替换 + 贡献禁用 + 槽位顺序覆盖。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Patch {
    pub id: String,
    /// 稳定 ID 替换：装载解析时把组件 X 替换为 Y（换 Provider 不改 Consumer）。
    pub replace: BTreeMap<String, String>,
    /// 禁用的贡献："组件:component"。
    pub disable: Vec<String>,
    /// 槽位顺序覆盖。
    pub slots: BTreeMap<String, Vec<String>>,
}

/// 分层组合档案：Bundle 序列 + Patch 序列。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Profile {
    pub bundles: Vec<Bundle>,
    pub patches: Vec<Patch>,
}

#[derive(Deserialize)]
struct ProfileToml {
    #[serde(default)]
    bundles: Vec<BundleToml>,
    #[serde(default)]
    patches: Vec<PatchToml>,
}

#[derive(Deserialize)]
struct BundleToml {
    id: String,
    #[serde(default)]
    plugins: Vec<String>,
}

#[derive(Deserialize)]
struct SlotOverrideToml {
    #[serde(default)]
    order: Vec<String>,
}

#[derive(Deserialize)]
struct PatchToml {
    id: String,
    #[serde(default)]
    replace: BTreeMap<String, String>,
    #[serde(default)]
    disable: Vec<String>,
    #[serde(default)]
    slots: BTreeMap<String, SlotOverrideToml>,
}

impl Profile {
    pub fn parse(text: &str) -> Result<Profile, String> {
        let parsed: ProfileToml =
            toml::from_str(text).map_err(|error| format!("清单解析失败: {error}"))?;
        let mut seen_bundle = Vec::new();
        for bundle in &parsed.bundles {
            if bundle.id.is_empty() {
                return Err("bundle id 不能为空".into());
            }
            if seen_bundle.contains(&bundle.id) {
                return Err(format!("bundle id 重复: {}", bundle.id));
            }
            seen_bundle.push(bundle.id.clone());
        }
        let mut seen_patch = Vec::new();
        for patch in &parsed.patches {
            if patch.id.is_empty() || seen_patch.contains(&patch.id) {
                return Err(format!("patch id 缺失或重复: {}", patch.id));
            }
            seen_patch.push(patch.id.clone());
        }
        Ok(Profile {
            bundles: parsed
                .bundles
                .into_iter()
                .map(|bundle| Bundle {
                    id: bundle.id,
                    plugins: bundle.plugins,
                })
                .collect(),
            patches: parsed
                .patches
                .into_iter()
                .map(|patch| Patch {
                    id: patch.id,
                    replace: patch.replace,
                    disable: patch.disable,
                    slots: patch
                        .slots
                        .into_iter()
                        .map(|(slot, order)| (slot, order.order))
                        .collect(),
                })
                .collect(),
        })
    }

    /// 装载解析：按层叠顺序把 replace 应用到全部 bundle 的组件列表。
    pub fn effective_load(&self) -> Vec<String> {
        let mut load = Vec::new();
        for bundle in &self.bundles {
            for plugin in &bundle.plugins {
                let resolved = self
                    .patches
                    .iter()
                    .find_map(|patch| patch.replace.get(plugin).cloned())
                    .unwrap_or_else(|| plugin.clone());
                load.push(resolved);
            }
        }
        load
    }
}

/// 组合产物：slot → 排序后的视图贡献。宿主的 PluginSlot 直接消费它。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompositionPlan {
    pub slots: BTreeMap<String, Vec<ViewContribution>>,
}

/// 每个贡献在补丁里的 key："组件:component"。
fn contribution_key(view: &ViewContribution) -> String {
    format!("{}:{}", view.plugin, view.component)
}

/// 按分层档案装载组件（Loader 的 Fiber 装载）+ 返回已装载清单。
/// 返回 (组件 id, FiberId)——宿主可用于后续 retire/替换。
pub fn apply_profile(
    loader: &mut Loader,
    profile: &Profile,
    lookup: &dyn Fn(&str) -> Option<Box<dyn Mountable>>,
) -> Result<Vec<(String, FiberId)>, String> {
    let mut mounted = Vec::new();
    for plugin in profile.effective_load() {
        let Some(component) = lookup(&plugin) else {
            return Err(format!("清单要求装载的组件不存在: {plugin}"));
        };
        let fiber_id = component
            .mount(loader)
            .map_err(|error| format!("组件 {plugin} 装载失败: {error}"))?;
        mounted.push((plugin, fiber_id));
    }
    Ok(mounted)
}

/// 合并槽位贡献：按层叠补丁依次应用 disable 与槽位顺序覆盖（后层覆盖前层）。
pub fn compose(slots: &Slots, profile: &Profile) -> CompositionPlan {
    let mut plan = CompositionPlan::default();
    let mut slot_ids: Vec<String> = slots
        .views()
        .iter()
        .map(|view| view.slot.0.clone())
        .chain(
            profile
                .patches
                .iter()
                .flat_map(|patch| patch.slots.keys().cloned()),
        )
        .collect();
    slot_ids.sort();
    slot_ids.dedup();
    for slot in slot_ids {
        let mut views: Vec<ViewContribution> = slots.slot_views(&slot);
        for patch in &profile.patches {
            views.retain(|view| !patch.disable.contains(&contribution_key(view)));
            if let Some(order) = patch.slots.get(&slot) {
                views.sort_by_key(|view| {
                    let key = contribution_key(view);
                    let position = order.iter().position(|entry| entry == &key);
                    (position.map_or(usize::MAX, |value| value), view.order)
                });
            }
        }
        plan.slots.insert(slot, views);
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use composer_plugin_api::{CommandId, SlotId};
    use serde_json::json;

    const PROFILE: &str = r#"
# 分层组合：Base Profile → Bundle → Patch（改这里即重组，无需重编译）
[[bundles]]
id = "base"
plugins = ["attachment-tools"]

[[bundles]]
id = "extras"
plugins = ["extra-tools", "storage"]

[[patches]]
id = "user"
replace = { storage = "storage-sqlite" }
disable = ["extra-tools:pin"]

[patches.slots."attachment.card.tools"]
order = ["extra-tools:pin", "attachment-tools:mode"]
"#;

    struct StubPlugin {
        id: &'static str,
    }
    impl Mountable for StubPlugin {
        fn id(&self) -> &'static str {
            self.id
        }
        fn mount(&self, loader: &mut Loader) -> Result<FiberId, String> {
            // self.id 是 &'static str，但经 &self 引用链借出会逃逸：提前拷出值。
            let plugin_id: &'static str = self.id;
            let (slot, component, order) = match self.id {
                "attachment-tools" => ("attachment.card.tools", "mode", 10),
                "extra-tools" => ("attachment.card.tools", "pin", 50),
                _ => ("attachment.card.tools", "other", 90),
            };
            loader.mount(composer_plugin_api::fiber(plugin_id), move |scope| {
                scope.slots().register_view(
                    plugin_id,
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
                Ok(())
            })
        }
    }

    fn lookup(id: &str) -> Option<Box<dyn Mountable>> {
        match id {
            "attachment-tools" => Some(Box::new(StubPlugin {
                id: "attachment-tools",
            })),
            "extra-tools" => Some(Box::new(StubPlugin { id: "extra-tools" })),
            // 无补丁分支（patches: vec![]）不替换，原始 id storage 也要能装载。
            "storage" => Some(Box::new(StubPlugin { id: "storage" })),
            "storage-sqlite" => Some(Box::new(StubPlugin {
                id: "storage-sqlite",
            })),
            _ => None,
        }
    }

    /// 清单解析：bundles/patches 落地；id 缺失或重复显式报错。
    #[test]
    fn profile_parse_and_errors() {
        let profile = Profile::parse(PROFILE).unwrap();
        assert_eq!(profile.bundles.len(), 2);
        assert_eq!(profile.patches.len(), 1);
        assert_eq!(
            profile.patches[0].replace.get("storage").unwrap(),
            "storage-sqlite"
        );
        assert!(
            Profile::parse("[[bundles]]\nplugins = []").is_err(),
            "bundle id 缺失"
        );
        assert!(
            Profile::parse("[[patches]]\nid = \"x\"\n[[patches]]\nid = \"x\"").is_err(),
            "patch id 重复"
        );
    }

    /// 稳定 ID 替换：装载解析把 storage 换成 storage-sqlite（换 Provider 不改 Consumer）。
    #[test]
    fn patch_replace_resolves_plugin_ids() {
        let profile = Profile::parse(PROFILE).unwrap();
        assert_eq!(
            profile.effective_load(),
            vec![
                "attachment-tools".to_string(),
                "extra-tools".to_string(),
                "storage-sqlite".to_string()
            ]
        );
    }

    /// 装载 + 组合：顺序覆盖、disable 剔除、缺失组件显式报错。
    #[test]
    fn apply_profile_and_compose() {
        let profile = Profile::parse(PROFILE).unwrap();
        let mut loader = Loader::new();
        let mounted = apply_profile(&mut loader, &profile, &lookup).unwrap();
        assert_eq!(mounted.len(), 3);
        let slots = loader.context().get::<Slots>().unwrap();
        let plan = compose(&slots, &profile);
        let views = &plan.slots["attachment.card.tools"];
        assert_eq!(
            views
                .iter()
                .map(|view| contribution_key(view))
                .collect::<Vec<_>>(),
            vec!["attachment-tools:mode", "storage-sqlite:other"],
            "补丁 disable 剔除 extra-tools:pin；其余按注册顺序"
        );
        // 默认顺序（无补丁）= 注册顺序。
        let plain = Profile {
            patches: vec![],
            ..profile.clone()
        };
        let mut loader = Loader::new();
        apply_profile(&mut loader, &plain, &lookup).unwrap();
        let slots = loader.context().get::<Slots>().unwrap();
        let plan = compose(&slots, &plain);
        let views = &plan.slots["attachment.card.tools"];
        assert_eq!(
            views
                .iter()
                .map(|view| contribution_key(view))
                .collect::<Vec<_>>(),
            vec!["attachment-tools:mode", "extra-tools:pin", "storage:other"],
            "默认按注册顺序"
        );
        let missing = Profile {
            bundles: vec![Bundle {
                id: "b".into(),
                plugins: vec!["ghost".into()],
            }],
            ..Default::default()
        };
        let error = apply_profile(&mut Loader::new(), &missing, &lookup).unwrap_err();
        assert!(error.contains("ghost"), "缺失组件显式报错");
    }
}
