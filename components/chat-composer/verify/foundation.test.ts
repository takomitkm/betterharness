import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../core.ts";
import { MemoryComposerStore } from "../store.ts";
import {
  documentWithoutAttachment, emptySnapshot, newAssetId, newNodeId, textSnapshot, validateSnapshot,
} from "../snapshots.ts";
import type { AssetId, Attachment, AttachmentNodeJson, ComposerSnapshot, JsonValue, NodeId, SendRequest } from "../types.ts";

const unusedTransport = {
  async send() { return { status: "unknown" as const, reason: "unused" }; },
  async lookup() { return { status: "unknown" as const, reason: "unused" }; },
};

function attachmentNode(nodeId: NodeId, assetId: AssetId): AttachmentNodeJson {
  return { type: "composer-attachment", version: 1, nodeId, assetId };
}
function paragraph(children: JsonValue[]): JsonValue {
  return { type: "paragraph", version: 1, children };
}
function lexicalDoc(children: JsonValue[]): JsonValue {
  return { root: { children: [paragraph(children)], direction: null, format: "", indent: 0, version: 1 } };
}
function assetEntry(id: AssetId, name = "图.png"): Attachment {
  return { id, name, mediaType: "image/png", data: new Blob(["bytes"]) };
}
function docSnapshot(children: JsonValue[], attachments: Attachment[], text = ""): ComposerSnapshot {
  return { ...emptySnapshot(), text, document: { format: "lexical", version: 1, value: lexicalDoc(children) }, attachments };
}
function orderedText(value: JsonValue, index = 0): string {
  const paragraph = (value as { root: { children: { children?: { type: string; text?: string }[] }[] } }).root.children[index];
  return (paragraph.children ?? []).map((node) => node.text ?? node.type).join("|");
}

test("FD01: an ordered document referencing existing assets validates and orders text with attachment nodes", () => {
  const asset = newAssetId();
  const children: JsonValue[] = [
    { type: "text", version: 1, text: "前" },
    attachmentNode(newNodeId(), asset),
    { type: "text", version: 1, text: "后" },
  ];
  validateSnapshot(docSnapshot(children, [assetEntry(asset)], "前后"));
  const nested = docSnapshot([{ type: "quote", version: 1, children: [attachmentNode(newNodeId(), asset)] }], [assetEntry(asset)]);
  validateSnapshot(nested);
});

test("FD02: an orphan AssetId in the document is rejected and the engine keeps the previous draft", async () => {
  const orphan = docSnapshot([{ type: "text", version: 1, text: "A" }, attachmentNode(newNodeId(), newAssetId())], []);
  assert.throws(() => validateSnapshot(orphan), /missing asset/);
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: unusedTransport });
  try {
    await engine.edit(textSnapshot("keep"));
    assert.equal(await engine.edit(orphan), false);
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, "keep");
  } finally { await engine.close(); }
});

test("FD03: duplicate NodeIds are rejected even when both referenced assets exist", () => {
  const first = newAssetId();
  const second = newAssetId();
  const nodeId = newNodeId();
  const snapshot = docSnapshot(
    [attachmentNode(nodeId, first), attachmentNode(nodeId, second)],
    [assetEntry(first), assetEntry(second)],
  );
  assert.throws(() => validateSnapshot(snapshot), /Duplicate document NodeId/);
});

test("FD04: attachment nodes without a usable NodeId or AssetId are rejected", () => {
  assert.throws(
    () => validateSnapshot(docSnapshot([{ type: "composer-attachment", version: 1, nodeId: newNodeId() }], [])),
    /AssetId/,
  );
  assert.throws(
    () => validateSnapshot(docSnapshot([{ type: "composer-attachment", version: 1, nodeId: newNodeId(), assetId: "" }], [])),
    /AssetId/,
  );
  assert.throws(
    () => validateSnapshot(docSnapshot([{ type: "composer-attachment", version: 1, assetId: newAssetId() }], [])),
    /NodeId/,
  );
  assert.throws(
    () => validateSnapshot(docSnapshot([{ type: "composer-attachment", version: 1, nodeId: "", assetId: newAssetId() }], [])),
    /NodeId/,
  );
});

test("FD05: attachments-only content is submittable, and whitespace text with an attachment is valid", async () => {
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: unusedTransport });
  try {
    const attachmentsOnly: ComposerSnapshot = { ...emptySnapshot(), text: "", attachments: [assetEntry(newAssetId())] };
    validateSnapshot(attachmentsOnly);
    await engine.edit(attachmentsOnly);
    const record = await engine.submit();
    assert.ok(record, "附件即内容，允许提交");

    const whitespace = { ...emptySnapshot(), text: "  \n", attachments: [assetEntry(newAssetId())] };
    validateSnapshot(whitespace);
  } finally { await engine.close(); }
});

test("FD06: a completely empty draft passes snapshot validation but is refused at submit", async () => {
  validateSnapshot(emptySnapshot());
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: unusedTransport });
  try {
    await engine.edit(emptySnapshot());
    assert.equal(await engine.submit(), null);
  } finally { await engine.close(); }
});

test("FD07: rail-only attachments are legal, and documentWithoutAttachment strips only the matching node", () => {
  const referenced = newAssetId();
  const railOnly = newAssetId();
  const children: JsonValue[] = [
    { type: "text", version: 1, text: "前" },
    attachmentNode(newNodeId(), referenced),
    { type: "text", version: 1, text: "后" },
  ];
  const snapshot = docSnapshot(children, [assetEntry(referenced), assetEntry(railOnly, "说明.pdf")]);
  validateSnapshot(snapshot);

  const value = snapshot.document!.value;
  assert.deepEqual(documentWithoutAttachment(value, referenced), lexicalDoc([
    { type: "text", version: 1, text: "前" },
    { type: "text", version: 1, text: "后" },
  ]));
  assert.deepEqual(documentWithoutAttachment(value, railOnly), value);
  // 非附件节点不受影响；顺序由文档本身决定，而不是 attachments 数组顺序。
  assert.equal(orderedText(value), "前|composer-attachment|后");
});

test("FD08: ordered document plus a rail-only attachment survive handoff, rejection and restore with NodeId intact", async () => {
  const requests: SendRequest[] = [];
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: {
    async send(request) {
      requests.push(structuredClone(request));
      return { status: "rejected", reason: "not admitted" };
    },
    async lookup() { return { status: "unknown", reason: "unused" }; },
  } });
  try {
    const asset = newAssetId();
    const rail = newAssetId();
    const node = attachmentNode(newNodeId(), asset);
    const children: JsonValue[] = [
      { type: "text", version: 1, text: "前" },
      node,
      { type: "text", version: 1, text: "后" },
    ];
    await engine.edit(docSnapshot(children, [assetEntry(asset), assetEntry(rail)], "前后"));
    const record = await engine.submit();
    assert.ok(record);
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, "");
    const submitted = engine.getSnapshot().state.submissions[0].snapshot;
    assert.deepEqual(submitted.document!.value, lexicalDoc(children));
    assert.deepEqual(submitted.attachments.map((item) => item.id), [asset, rail]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("rejected was not observed")); }, 3000);
      const stop = engine.subscribe(() => {
        if (engine.getSnapshot().state.submissions[0].status === "rejected") { clearTimeout(timer); stop(); resolve(); }
      });
    });
    assert.equal(await engine.restore(record!.id), true);
    const restored = engine.getSnapshot().state.draft.snapshot;
    assert.deepEqual(restored.document!.value, lexicalDoc(children));
    assert.equal(orderedText(restored.document!.value), "前|composer-attachment|后");
    assert.equal((restored.document!.value as { root: { children: { children: { nodeId: NodeId }[] }[] } }).root.children[0].children[1].nodeId, node.nodeId);
    assert.equal(restored.attachments.length, 2);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].snapshot.document!.value, lexicalDoc(children));
  } finally { await engine.close(); }
});
