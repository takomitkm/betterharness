import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../core.ts";
import { MemoryComposerStore } from "../store.ts";
import { textSnapshot } from "../snapshots.ts";
import type { DeliveryResult, JsonValue, SendRequest } from "../types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
async function stateWhen(engine: Awaited<ReturnType<typeof createComposer>>, predicate: () => boolean) {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Expected state was not observed")); }, 1000);
    const stop = engine.subscribe(() => { if (predicate()) { clearTimeout(timer); stop(); resolve(); } });
  });
}

test("FM17: a finished turn never becomes active again when admission arrives late", async () => {
  const response = deferred<DeliveryResult>();
  const called = deferred<SendRequest>();
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: {
    send(request) { called.resolve(request); return response.promise; },
    async lookup() { return { status: "unknown", reason: "pending" }; },
  } });
  try {
    await engine.edit(textSnapshot("A")); await engine.submit();
    const request = await called.promise;
    await engine.beginTurn("already-finished");
    await engine.endTurn("already-finished");
    response.resolve({ status: "accepted", receipt: { id: request.id, scopeId: "scope", turnId: "already-finished" } });
    await stateWhen(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
    assert.equal(engine.getSnapshot().state.activeTurn, null);
  } finally { await engine.close(); }
});

test("FM18: closing cancels an uncooperative lookup without waiting for its timeout", async () => {
  const lookupStarted = deferred<void>();
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), sendTimeoutMs: 5000, transport: {
    async send() { return { status: "unknown", reason: "reply lost" }; },
    lookup() { lookupStarted.resolve(); return new Promise<DeliveryResult>(() => {}); },
  } });
  await engine.edit(textSnapshot("A")); const record = await engine.submit();
  await stateWhen(engine, () => engine.getSnapshot().state.submissions[0].status === "unknown");
  const query = engine.query(record!.id);
  await lookupStarted.promise;
  await engine.close();
  let timer: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    query.then(() => "closed"),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 100); }),
  ]);
  clearTimeout(timer!);
  assert.equal(result, "closed");
});

test("FM19: cyclic or non-JSON document metadata is rejected without destroying the existing draft", async () => {
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), transport: {
    async send() { return { status: "unknown", reason: "unused" }; },
    async lookup() { return { status: "unknown", reason: "unused" }; },
  } });
  try {
    await engine.edit(textSnapshot("keep"));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.equal(await engine.edit({ ...textSnapshot("bad"), document: { format: "custom", version: 1, value: cycle as JsonValue } }), false);
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, "keep");
  } finally { await engine.close(); }
});

test("FM25: a stale unknown lookup cannot downgrade an explicit rejection", async () => {
  const response = deferred<DeliveryResult>();
  const lookup = deferred<DeliveryResult>();
  const querying = deferred<void>();
  const engine = await createComposer({ scopeId: "scope", store: new MemoryComposerStore(), sendTimeoutMs: 20, transport: {
    send() { return response.promise; },
    lookup() { querying.resolve(); return lookup.promise; },
  } });
  try {
    await engine.edit(textSnapshot("A")); const record = await engine.submit();
    await stateWhen(engine, () => engine.getSnapshot().state.submissions[0].status === "unknown");
    const query = engine.query(record!.id); await querying.promise;
    response.resolve({ status: "rejected", reason: "authoritatively not admitted" });
    await stateWhen(engine, () => engine.getSnapshot().state.submissions[0].status === "rejected");
    lookup.resolve({ status: "unknown", reason: "stale lookup" });
    await query;
    assert.equal(engine.getSnapshot().state.submissions[0].status, "rejected");
  } finally { await engine.close(); }
});
