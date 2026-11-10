//! 附件节点重排的纯数学，零依赖。
//! 语义移植自 archive/ts/reorder.ts：targetIndex 是「整篇文档附件节点序列」里的下标
//! （0 起）——移动后该节点必须成为其中第 targetIndex 个，与段落内位置解耦。
//! 移动只改文档顺序；附件条目列表、outbox 与预览 URL 一概不动（不变量归 UI 层）。

/// 附件序列条目：只需身份。顺序 = 文档顺序（不是附件列表顺序）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentSequenceEntry {
    pub node_id: String,
    pub asset_id: String,
}

/// 移动跨度：remove_from 是原序列上摘除的下标；insert_at 施加于摘除后的其余序列——
/// 等于其余数量时表示插在最后一个其余附件之后（没有其余附件 = 追加到文档末尾段落）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveSpan {
    pub remove_from: usize,
    pub insert_at: usize,
}

/// 计算移动跨度（纯函数，不做任何编辑器操作）：
/// - 找不到 asset_id → None（无操作）；
/// - target_index 的小数部分被截断后钳制到 [0, 数量-1]；
/// - 钳制后等于当前位置 → None（无操作；含空序列、单附件的任意目标）。
pub fn compute_move_span(
    nodes: &[AttachmentSequenceEntry],
    asset_id: &str,
    target_index: f64,
) -> Option<MoveSpan> {
    let current = nodes.iter().position(|node| node.asset_id == asset_id)?;
    let target = (target_index.trunc() as i64).clamp(0, nodes.len() as i64 - 1) as usize;
    if target == current {
        return None;
    }
    Some(MoveSpan {
        remove_from: current,
        insert_at: target,
    })
}

/// 应用移动跨度：摘除 remove_from 处的节点，插到其余序列的 insert_at 处。
/// 返回新序列（供纯测试与 UI 层复用——真实编辑器操作由平台层在单次编辑事务里执行）。
pub fn apply_move_span(
    nodes: &[AttachmentSequenceEntry],
    span: MoveSpan,
) -> Vec<AttachmentSequenceEntry> {
    let mut next: Vec<AttachmentSequenceEntry> = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        if index == span.remove_from {
            continue;
        }
        if next.len() == span.insert_at {
            next.push(nodes[span.remove_from].clone());
        }
        next.push(node.clone());
    }
    if next.len() == span.insert_at {
        next.push(nodes[span.remove_from].clone());
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(node: &str, asset: &str) -> AttachmentSequenceEntry {
        AttachmentSequenceEntry {
            node_id: node.into(),
            asset_id: asset.into(),
        }
    }

    fn sequence() -> Vec<AttachmentSequenceEntry> {
        vec![entry("n0", "a0"), entry("n1", "a1"), entry("n2", "a2")]
    }

    /// RO01：空序列恒为无操作。
    #[test]
    fn ro01_empty_sequence_is_always_noop() {
        assert_eq!(compute_move_span(&[], "a0", 0.0), None);
    }

    /// RO02：不在序列里的 assetId 是无操作。
    #[test]
    fn ro02_unknown_asset_id_is_noop() {
        assert_eq!(compute_move_span(&sequence(), "missing", 1.0), None);
    }

    /// RO03：单附件不能移动——任意目标钳到自身。
    #[test]
    fn ro03_single_attachment_cannot_move() {
        let nodes = vec![entry("n0", "a0")];
        for target in [-5.0, 0.0, 3.0] {
            assert_eq!(compute_move_span(&nodes, "a0", target), None);
        }
    }

    /// RO04：向后移动 = 原位摘除、插到钳制目标。
    #[test]
    fn ro04_forward_move_removes_and_inserts_at_clamped_target() {
        let span = compute_move_span(&sequence(), "a0", 2.0).unwrap();
        assert_eq!(
            span,
            MoveSpan {
                remove_from: 0,
                insert_at: 2
            }
        );
        let moved = apply_move_span(&sequence(), span);
        assert_eq!(
            moved
                .iter()
                .map(|entry| entry.asset_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a1", "a2", "a0"]
        );
    }

    /// RO05：向前移动 = 摘除后插到其余序列的目标处。
    #[test]
    fn ro05_backward_move_inserts_before_the_remaining_target() {
        let span = compute_move_span(&sequence(), "a2", 0.0).unwrap();
        assert_eq!(
            span,
            MoveSpan {
                remove_from: 2,
                insert_at: 0
            }
        );
        let moved = apply_move_span(&sequence(), span);
        assert_eq!(
            moved
                .iter()
                .map(|entry| entry.asset_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a2", "a0", "a1"]
        );
    }

    /// RO06：钳制后等于当前位置是无操作（含负目标钳到 0）。
    #[test]
    fn ro06_clamped_target_equal_to_current_is_noop() {
        assert_eq!(compute_move_span(&sequence(), "a0", 0.0), None);
        assert_eq!(
            compute_move_span(&sequence(), "a0", -3.0),
            None,
            "负目标钳到 0 = 原位"
        );
        assert_eq!(
            compute_move_span(&sequence(), "a2", 99.0),
            None,
            "越界钳到末位 = 原位"
        );
    }

    /// RO07：负目标钳到开头。
    #[test]
    fn ro07_negative_target_clamps_to_start() {
        let span = compute_move_span(&sequence(), "a1", -1.0).unwrap();
        assert_eq!(
            span,
            MoveSpan {
                remove_from: 1,
                insert_at: 0
            }
        );
    }

    /// RO08：超过末位的目标钳到最后一个附件槽位。
    #[test]
    fn ro08_target_beyond_end_clamps_to_last_slot() {
        let span = compute_move_span(&sequence(), "a0", 9.0).unwrap();
        assert_eq!(
            span,
            MoveSpan {
                remove_from: 0,
                insert_at: 2
            }
        );
    }

    /// RO09：小数目标先截断再钳制。
    #[test]
    fn ro09_fractional_targets_are_truncated_before_clamping() {
        let span = compute_move_span(&sequence(), "a0", 2.9).unwrap();
        assert_eq!(span.insert_at, 2);
        let span = compute_move_span(&sequence(), "a0", 1.5).unwrap();
        assert_eq!(span.insert_at, 1);
    }

    /// RO10：穷举性质——任何可行跨度施加后，被移节点恰好落在钳制目标处，其余相对顺序不变。
    #[test]
    fn ro10_every_feasible_span_places_the_node_exactly_at_the_clamped_target() {
        let nodes = sequence();
        for target in [0.0, 1.0, 2.0, 3.0, -2.0, 1.7] {
            let Some(span) = compute_move_span(&nodes, "a1", target) else {
                continue;
            };
            let clamped = (target.trunc() as i64).clamp(0, nodes.len() as i64 - 1) as usize;
            let moved = apply_move_span(&nodes, span);
            assert_eq!(moved[clamped].asset_id, "a1");
            let others: Vec<&str> = moved
                .iter()
                .map(|entry| entry.asset_id.as_str())
                .filter(|asset| *asset != "a1")
                .collect();
            assert_eq!(others, vec!["a0", "a2"], "其余附件相对顺序不变");
        }
    }
}
