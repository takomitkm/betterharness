import { test } from "node:test";
import assert from "node:assert/strict";
// 纯 Deno/Node：只 import 零依赖模块，不碰 react/lexical（附件下标枚举本身在编辑器里，
// 这里测的是移动跨度纯数学的全部语义：前移、后移、同位、越界钳制、空、单附件）。
import { computeMoveSpan, type AttachmentSequenceEntry, type MoveSpan } from "../reorder.ts";
import { toAssetId, toNodeId } from "../snapshots.ts";

const entry = (nodeId: string, assetId: string): AttachmentSequenceEntry => ({
  nodeId: toNodeId(nodeId), assetId: toAssetId(assetId),
});
const seq = (...assetIds: string[]): AttachmentSequenceEntry[] => assetIds.map((assetId, index) => entry(`n${index}`, assetId));

/** 把跨度施加到副本上（removeFrom 摘除 → 其余序列 insertAt 插入），供落位断言用。 */
function applySpan(nodes: readonly AttachmentSequenceEntry[], span: MoveSpan): AttachmentSequenceEntry[] {
  const next = [...nodes];
  const [moved] = next.splice(span.removeFrom, 1);
  next.splice(span.insertAt, 0, moved);
  return next;
}

test("RO01: an empty attachment sequence is always a no-op", () => {
  assert.equal(computeMoveSpan([], toAssetId("a1"), 0), null);
  assert.equal(computeMoveSpan([], toAssetId("a1"), -3), null);
  assert.equal(computeMoveSpan([], toAssetId("a1"), 9), null);
});

test("RO02: an assetId that is not in the document is a no-op", () => {
  assert.equal(computeMoveSpan(seq("a1", "a2"), toAssetId("missing"), 1), null);
});

test("RO03: a single attachment cannot move — any target clamps onto itself", () => {
  const single = seq("a1");
  assert.equal(computeMoveSpan(single, toAssetId("a1"), 0), null);
  assert.equal(computeMoveSpan(single, toAssetId("a1"), 1), null);
  assert.equal(computeMoveSpan(single, toAssetId("a1"), -5), null);
  assert.equal(computeMoveSpan(single, toAssetId("a1"), 99), null);
});

test("RO04: moving forward removes at the current index and inserts at the clamped target", () => {
  const nodes = seq("a1", "a2", "a3");
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a1"), 2), { removeFrom: 0, insertAt: 2 });
  // 落位校验：节点成为新序列的第 2 个，其余相对顺序不变。
  assert.deepEqual(applySpan(nodes, computeMoveSpan(nodes, toAssetId("a1"), 2)!).map((node) => node.assetId), ["a2", "a3", "a1"]);
  // 跨一位的前移同样成立：b→2。
  const span = computeMoveSpan(nodes, toAssetId("a2"), 2)!;
  assert.deepEqual(span, { removeFrom: 1, insertAt: 2 });
  assert.deepEqual(applySpan(nodes, span).map((node) => node.assetId), ["a1", "a3", "a2"]);
});

test("RO05: moving backward inserts before the remaining attachment at the target", () => {
  const nodes = seq("a1", "a2", "a3");
  const span = computeMoveSpan(nodes, toAssetId("a3"), 0)!;
  assert.deepEqual(span, { removeFrom: 2, insertAt: 0 });
  assert.deepEqual(applySpan(nodes, span).map((node) => node.assetId), ["a3", "a1", "a2"]);
  const middle = computeMoveSpan(nodes, toAssetId("a3"), 1)!;
  assert.deepEqual(middle, { removeFrom: 2, insertAt: 1 });
  assert.deepEqual(applySpan(nodes, middle).map((node) => node.assetId), ["a1", "a3", "a2"]);
});

test("RO06: the clamped target equal to the current index is a no-op", () => {
  const nodes = seq("a1", "a2", "a3");
  assert.equal(computeMoveSpan(nodes, toAssetId("a2"), 1), null);
  assert.equal(computeMoveSpan(nodes, toAssetId("a1"), 0), null);
  assert.equal(computeMoveSpan(nodes, toAssetId("a3"), 2), null);
});

test("RO07: a negative target clamps to the start", () => {
  const nodes = seq("a1", "a2", "a3");
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a3"), -1), { removeFrom: 2, insertAt: 0 });
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a2"), -9), { removeFrom: 1, insertAt: 0 });
});

test("RO08: a target beyond the end clamps to the last attachment slot", () => {
  const nodes = seq("a1", "a2", "a3");
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a1"), 3), { removeFrom: 0, insertAt: 2 });
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a1"), 99), { removeFrom: 0, insertAt: 2 });
  // 已在末位时钳制后同位 → 无操作（键盘「到末尾」的钳制语义）。
  assert.equal(computeMoveSpan(nodes, toAssetId("a3"), 99), null);
});

test("RO09: fractional targets are truncated before clamping", () => {
  const nodes = seq("a1", "a2", "a3");
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a1"), 2.9), { removeFrom: 0, insertAt: 2 });
  assert.deepEqual(computeMoveSpan(nodes, toAssetId("a2"), 0.5), { removeFrom: 1, insertAt: 0 });
});

test("RO10: exhaustive property — every span places the node exactly at the clamped target", () => {
  for (let count = 1; count <= 4; count++) {
    const nodes = Array.from({ length: count }, (_, index) => entry(`n${index}`, `a${index}`));
    for (let from = 0; from < count; from++) {
      for (let to = -2; to <= count + 1; to++) {
        const clamped = Math.max(0, Math.min(to, count - 1));
        const span = computeMoveSpan(nodes, nodes[from].assetId, to);
        if (clamped === from) {
          assert.equal(span, null, `count=${count} from=${from} to=${to} must be a no-op`);
          continue;
        }
        assert.deepEqual(span, { removeFrom: from, insertAt: clamped }, `count=${count} from=${from} to=${to}`);
        const moved = applySpan(nodes, span!);
        assert.equal(moved[clamped].assetId, nodes[from].assetId, `count=${count} from=${from} to=${to} landing`);
        // 其余附件的相对顺序保持不变。
        const restBefore = nodes.filter((_, index) => index !== from).map((node) => node.assetId);
        const restAfter = moved.filter((node) => node.assetId !== nodes[from].assetId).map((node) => node.assetId);
        assert.deepEqual(restAfter, restBefore, `count=${count} from=${from} to=${to} rest order`);
      }
    }
  }
});
