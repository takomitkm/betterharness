// 附件节点重排的纯数学（零依赖，不许 import react/lexical，Deno/Node 均可直接运行）。
// 目标下标语义：targetIndex 是「整篇文档附件节点序列」里的下标（0 起）——按文档顺序枚举
// 全部 composer-attachment 节点，移动后该节点必须成为其中第 targetIndex 个（不是原始
// 子节点数组的下标，跨段落时与段落内位置解耦）。移动只改文档顺序；附件条目列表、
// outbox 与 object-URL 一概不动（不变量见 ChatComposer / AttachmentCards 的注释）。

import type { AssetId, NodeId } from "./types.ts";

/** 附件序列条目：只需身份。顺序 = 文档顺序（不是 snapshot.attachments 列表顺序）。 */
export interface AttachmentSequenceEntry {
  readonly nodeId: NodeId;
  readonly assetId: AssetId;
}

/**
 * 移动跨度：removeFrom 是原序列上摘除的下标；insertAt 施加于摘除后的其余序列——
 * 等于其余数量时表示插在最后一个其余附件之后（没有其余附件 = 追加到文档末尾段落）。
 * 节点落位后恰好是新序列的第 insertAt 个，其余附件相对顺序不变。
 */
export interface MoveSpan {
  readonly removeFrom: number;
  readonly insertAt: number;
}

/**
 * 计算移动跨度（纯函数，不做任何编辑器操作）：
 * - 找不到 assetId → null（无操作）；
 * - targetIndex 越界钳制到 [0, 数量-1]；
 * - 钳制后等于当前位置 → null（无操作；含空序列、单附件的任意目标——单附件总在唯一可能的位置）。
 * 其余情况返回 { removeFrom: 当前下标, insertAt: 钳制后目标 }；向前向后移动统一表达：
 * 摘除后把节点插到其余序列的 insertAt 处即可。
 */
export function computeMoveSpan(
  nodes: readonly AttachmentSequenceEntry[],
  assetId: AssetId,
  targetIndex: number,
): MoveSpan | null {
  const currentIndex = nodes.findIndex((node) => node.assetId === assetId);
  if (currentIndex < 0) return null;
  const target = Math.max(0, Math.min(Math.trunc(targetIndex), nodes.length - 1));
  if (target === currentIndex) return null;
  return { removeFrom: currentIndex, insertAt: target };
}
