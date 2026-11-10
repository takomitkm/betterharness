import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../core.ts";
import { MemoryComposerStore } from "../store.ts";
import { textSnapshot } from "../snapshots.ts";
import type { ComposerStore } from "../types.ts";

test("FM23: a failed receipt write is retryable locally without a second transport call", async () => {
  const backing = new MemoryComposerStore();
  let failReceipt = true;
  let injections = 0;
  let sends = 0;
  const store: ComposerStore = {
    read: (scope) => backing.read(scope),
    compareAndSwap: (scope, revision, next) => {
      if (failReceipt && next.submissions.some((record) => record.status === "accepted")) {
        injections++; throw new Error("receipt write failed");
      }
      return backing.compareAndSwap(scope, revision, next);
    },
  };
  const engine = await createComposer({ scopeId: "scope", store, transport: {
    async send(request) { sends++; return { status: "accepted", receipt: { id: request.id, scopeId: request.scopeId, turnId: "turn" } }; },
    async lookup() { return { status: "unknown", reason: "unused" }; },
  } });
  try {
    await engine.edit(textSnapshot("A")); await engine.submit();
    await new Promise<void>((resolve) => {
      if (engine.getSnapshot().error) return resolve();
      const stop = engine.subscribe(() => { if (engine.getSnapshot().error) { stop(); resolve(); } });
    });
    assert.equal(injections, 1);
    await engine.edit(textSnapshot("B"));
    failReceipt = false;
    assert.equal(await engine.flush(), true);
    assert.equal(engine.getSnapshot().state.submissions[0].status, "accepted");
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, "B");
    assert.equal(sends, 1);
  } finally { await engine.close(); }
});

test("FM24: retrying local persistence restarts a queue whose sending marker failed to save", async () => {
  const backing = new MemoryComposerStore();
  let injections = 0;
  let sends = 0;
  const engine = await createComposer({ scopeId: "scope", store: {
    read: (scope) => backing.read(scope),
    compareAndSwap: (scope, revision, next) => {
      if (injections === 0 && next.submissions.some((record) => record.status === "sending")) {
        injections++; throw new Error("sending marker write failed");
      }
      return backing.compareAndSwap(scope, revision, next);
    },
  }, transport: {
    async send(request) { sends++; return { status: "accepted", receipt: { id: request.id, scopeId: request.scopeId, turnId: "turn" } }; },
    async lookup() { return { status: "unknown", reason: "unused" }; },
  } });
  try {
    await engine.edit(textSnapshot("A")); await engine.submit();
    await new Promise<void>((resolve) => {
      if (engine.getSnapshot().error) return resolve();
      const stop = engine.subscribe(() => { if (engine.getSnapshot().error) { stop(); resolve(); } });
    });
    assert.equal(injections, 1);
    assert.equal(sends, 0);
    await engine.flush();
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      new Promise<void>((resolve) => {
        if (engine.getSnapshot().state.submissions[0].status === "accepted") return resolve();
        const stop = engine.subscribe(() => { if (engine.getSnapshot().state.submissions[0].status === "accepted") { stop(); resolve(); } });
      }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
    ]);
    clearTimeout(timer!);
    assert.equal(sends, 1);
    assert.equal(engine.getSnapshot().state.submissions[0].status, "accepted");
  } finally { await engine.close(); }
});
