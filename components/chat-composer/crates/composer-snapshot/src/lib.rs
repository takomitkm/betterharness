//! 有序文档与附件身份的纯校验，零 DOM 依赖。
//! 语义移植自 archive/ts/snapshots.ts 的纯部分；职责切分：
//! - 本 crate：深度/有限性（validate_json）、文档头（format/version）、文档附件节点身份
//!   （NodeId 唯一非空、AssetId 存在）、节点摘除（document_without_attachment）；
//! - 平台适配层：Blob 字节持有与 structured-clone 校验（浏览器概念，不进本 crate）；
//!   JS 对象的原型检查与环检测在 JsValue→Value 换算时完成（serde_json::Value 本身
//!   无环、无原型概念）。
//!
//! 附件条目（Blob）与文档节点是同一内容的两面：文档附件节点的 assetId 必须能在
//! 附件条目里找到；反向不成立——未被文档引用的附件合法（rail-only）。

use serde_json::Value;

/// serde_json Map 的键序不保证插入序，这里只依赖数组保序——文档顺序由 children 数组驱动。
const ATTACHMENT_NODE_TYPE: &str = "composer-attachment";
const MAX_JSON_DEPTH: usize = 128;

/// 元数据 JSON 的深度/有限性校验（对齐 archive/ts 的 validateJson 纯部分）。
/// 循环与原型检查属于 JsValue→Value 换算层；本函数只保证「有限深度 + 有限数值」。
pub fn validate_json(value: &Value) -> Result<(), &'static str> {
    validate_json_depth(value, 0)
}

fn validate_json_depth(value: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > MAX_JSON_DEPTH {
        return Err("Document metadata is too deeply nested");
    }
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(number) => {
            if number.as_f64().is_some_and(|value| value.is_finite()) {
                Ok(())
            } else {
                Err("Document metadata must be finite, acyclic JSON")
            }
        }
        Value::Array(children) => {
            for child in children {
                validate_json_depth(child, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(entries) => {
            for (_, child) in entries {
                // undefined 属性值对齐 JSON.stringify 语义：换算层已把 undefined 丢弃，
                // 这里看到的都是实际存在的值。
                validate_json_depth(child, depth + 1)?;
            }
            Ok(())
        }
    }
}

/// 文档附件节点引用（文档顺序，跨所有段落深度优先）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentNodeRef {
    pub node_id: String,
    pub asset_id: String,
}

fn attachment_of(value: &Value) -> Option<AttachmentNodeRef> {
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != ATTACHMENT_NODE_TYPE {
        return None;
    }
    // nodeId/assetId 缺失或非字符串时记为空串：节点仍被收集，由 validate_document
    // 报「身份不可用」（对齐 archive/ts：先收集、后校验）。
    let node_id = object
        .get("nodeId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let asset_id = object
        .get("assetId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    Some(AttachmentNodeRef { node_id, asset_id })
}

fn walk_attachment_nodes(value: &Value, found: &mut Vec<AttachmentNodeRef>) {
    match value {
        Value::Array(children) => {
            for child in children {
                walk_attachment_nodes(child, found);
            }
        }
        Value::Object(object) => {
            if let Some(node) = attachment_of(value) {
                found.push(node);
            }
            for (_, child) in object {
                walk_attachment_nodes(child, found);
            }
        }
        _ => {}
    }
}

/// 按文档顺序枚举全部附件节点（深度优先，与编辑器序列化 JSON 的遍历顺序一致）。
pub fn document_attachment_nodes(value: &Value) -> Vec<AttachmentNodeRef> {
    let mut found = Vec::new();
    walk_attachment_nodes(value, &mut found);
    found
}

fn is_attachment_for(value: &Value, asset_id: &str) -> bool {
    attachment_of(value).is_some_and(|node| node.asset_id == asset_id)
}

/// 从文档 JSON 中摘除引用指定 assetId 的附件节点：数组子项按过滤移除，对象属性位置置
/// null，其余结构与顺序原样保留。供「移除附件」把条目与其文档节点作为同一次变更撤下。
pub fn document_without_attachment(value: &Value, asset_id: &str) -> Value {
    match value {
        Value::Array(children) => Value::Array(
            children
                .iter()
                .filter(|child| !is_attachment_for(child, asset_id))
                .map(|child| document_without_attachment(child, asset_id))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, child)| {
                    let next = if is_attachment_for(child, asset_id) {
                        Value::Null
                    } else {
                        document_without_attachment(child, asset_id)
                    };
                    (key.clone(), next)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 文档头校验：format 非空、version 是 ≥1 的安全整数。
pub fn validate_document_meta(format: &str, version: f64) -> Result<(), &'static str> {
    if format.is_empty() {
        return Err("Invalid document format/version");
    }
    let safe_integer = version.fract() == 0.0 && version.abs() <= 9_007_199_254_740_991.0;
    if !safe_integer || version < 1.0 {
        return Err("Invalid document format/version");
    }
    Ok(())
}

/// 有序文档身份校验：每个附件节点必须有稳定唯一的 NodeId 与存在的 AssetId。
/// 反向不成立：未被文档引用的附件合法（rail-only）。
pub fn validate_document(value: &Value, assets: &[String]) -> Result<(), &'static str> {
    let nodes = document_attachment_nodes(value);
    let mut node_ids = std::collections::BTreeSet::new();
    for node in &nodes {
        if node.node_id.is_empty() {
            return Err("Document attachment nodes require a stable NodeId");
        }
        if !node_ids.insert(node.node_id.as_str()) {
            return Err("Duplicate document NodeId");
        }
        if node.asset_id.is_empty() {
            return Err("Document attachment nodes require an AssetId");
        }
    }
    for node in &nodes {
        if !assets.iter().any(|asset| asset == &node.asset_id) {
            return Err("Document attachment node references a missing asset");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// FM19：超深（>128 层）元数据被拒绝，不摧毁现有草稿。
    #[test]
    fn fm19_overly_deep_metadata_is_rejected() {
        let mut value = json!(1);
        for _ in 0..130 {
            value = json!([value]);
        }
        assert_eq!(
            validate_json(&value),
            Err("Document metadata is too deeply nested")
        );
        assert_eq!(
            validate_json(&json!({"a": {"b": [1, "x", null, true]}})),
            Ok(())
        );
    }

    /// FD01：引用存在的有序文档通过校验，并按文档顺序枚举节点。
    #[test]
    fn fd01_valid_document_orders_text_with_attachment_nodes() {
        let document = json!({
            "children": [
                {"children": [
                    {"type": "text", "text": "A"},
                    {"type": "composer-attachment", "nodeId": "n1", "assetId": "f1"},
                    {"type": "text", "text": "B"}
                ]},
                {"children": [
                    {"type": "composer-attachment", "nodeId": "n2", "assetId": "f2"}
                ]}
            ]
        });
        let nodes = document_attachment_nodes(&document);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].node_id, "n1");
        assert_eq!(nodes[1].asset_id, "f2");
        assert_eq!(
            validate_document(&document, &["f1".into(), "f2".into()]),
            Ok(())
        );
    }

    /// FD02：文档引用悬空 AssetId 被拒绝。
    #[test]
    fn fd02_orphan_asset_reference_is_rejected() {
        let document = json!({"children": [{"type": "composer-attachment", "nodeId": "n1", "assetId": "ghost"}]});
        assert_eq!(
            validate_document(&document, &[]),
            Err("Document attachment node references a missing asset")
        );
    }

    /// FD03：NodeId 重复即使 AssetId 都存在也被拒绝。
    #[test]
    fn fd03_duplicate_node_ids_are_rejected() {
        let document = json!({"children": [
            {"type": "composer-attachment", "nodeId": "n1", "assetId": "f1"},
            {"type": "composer-attachment", "nodeId": "n1", "assetId": "f2"}
        ]});
        assert_eq!(
            validate_document(&document, &["f1".into(), "f2".into()]),
            Err("Duplicate document NodeId")
        );
    }

    /// FD04：无可用 NodeId / AssetId 的附件节点被拒绝。
    #[test]
    fn fd04_nodes_without_usable_identity_are_rejected() {
        let missing_node_id =
            json!({"children": [{"type": "composer-attachment", "assetId": "f1"}]});
        assert_eq!(
            validate_document(&missing_node_id, &["f1".into()]),
            Err("Document attachment nodes require a stable NodeId")
        );
        let empty_node_id =
            json!({"children": [{"type": "composer-attachment", "nodeId": "", "assetId": "f1"}]});
        assert_eq!(
            validate_document(&empty_node_id, &["f1".into()]),
            Err("Document attachment nodes require a stable NodeId")
        );
        let missing_asset = json!({"children": [{"type": "composer-attachment", "nodeId": "n1"}]});
        assert_eq!(
            validate_document(&missing_asset, &[]),
            Err("Document attachment nodes require an AssetId")
        );
    }

    /// FD07：rail-only 附件合法；document_without_attachment 只摘除匹配节点。
    #[test]
    fn fd07_rail_only_assets_are_legal_and_stripping_is_precise() {
        // 未被文档引用的附件不参与文档校验。
        let document =
            json!({"children": [{"type": "composer-attachment", "nodeId": "n1", "assetId": "f1"}]});
        assert_eq!(
            validate_document(&document, &["f1".into(), "rail-only".into()]),
            Ok(())
        );
        // 摘除：数组过滤 + 对象位置置 null，其余结构原样。
        let value = json!({"children": [
            {"type": "text"},
            {"type": "composer-attachment", "nodeId": "n1", "assetId": "f1"},
            {"children": [{"type": "composer-attachment", "nodeId": "n2", "assetId": "f2"}]}
        ]});
        let stripped = document_without_attachment(&value, "f1");
        assert_eq!(
            stripped,
            json!({"children": [
                {"type": "text"},
                {"children": [{"type": "composer-attachment", "nodeId": "n2", "assetId": "f2"}]}
            ]})
        );
    }

    /// 文档头：format 非空、version ≥1 安全整数。
    #[test]
    fn document_meta_checks_format_and_version() {
        assert_eq!(validate_document_meta("lexical", 1.0), Ok(()));
        assert_eq!(
            validate_document_meta("", 1.0),
            Err("Invalid document format/version")
        );
        assert_eq!(
            validate_document_meta("lexical", 0.0),
            Err("Invalid document format/version")
        );
        assert_eq!(
            validate_document_meta("lexical", 1.5),
            Err("Invalid document format/version")
        );
    }
}
