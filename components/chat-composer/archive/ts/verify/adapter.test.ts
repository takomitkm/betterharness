import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../core.ts";
import { createEditorAdapter } from "../editor-adapter.ts";
import { MemoryComposerStore } from "../store.ts";
import { textSnapshot } from "../snapshots.ts";

const transport = {
  async send() { return { status: "unknown" as const, reason: "reply lost" }; },
  async lookup() { return { status: "unknown" as const, reason: "no authoritative receipt" }; },
};

test("FM20: editor adapters compare generation and revision, never just equal text", async () => {
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport });
  try {
    const adapter = createEditorAdapter(engine);
    const before = engine.getSnapshot().state.draft;
    await engine.edit(textSnapshot("A"));
    assert.equal(await adapter.apply(textSnapshot("stale"), before), false);
    const captured = engine.getSnapshot().state.draft;
    await engine.submit();
    assert.equal(await adapter.apply(textSnapshot("A"), captured), false);
    assert.equal(adapter.capture().text, "");
  } finally { await engine.close(); }
});

test("FM21: unknown payloads cannot be discarded, and explicit removal cannot delete the successor draft", async () => {
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport });
  try {
    await engine.edit(textSnapshot("A")); const record = await engine.submit();
    await engine.idle();
    assert.equal(await engine.remove(record!.id), false);
    await engine.edit(textSnapshot("B"));
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, "B");
    assert.equal(engine.getSnapshot().state.submissions[0].snapshot.text, "A");
  } finally { await engine.close(); }
});

test("FM22: corrupt storage fails closed without overwriting existing data", async () => {
  const store = new MemoryComposerStore();
  const engine = await createComposer({ scopeId: "scope", store, transport });
  await engine.edit(textSnapshot("keep")); await engine.close();
  const current = (await store.read("scope"))!;
  const broken = structuredClone(current);
  broken.schema = 99 as 1;
  broken.revision++;
  await store.compareAndSwap("scope", current.revision, broken);
  await assert.rejects(createComposer({ scopeId: "scope", store, transport }), /corrupt/);
  assert.equal((await store.read("scope"))!.draft.snapshot.text, "keep");
});
