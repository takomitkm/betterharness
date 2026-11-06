import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../core.ts";
import { MemoryComposerStore } from "../store.ts";
import { emptySnapshot, textSnapshot } from "../snapshots.ts";
import type { ComposerStore, ComposerTransport, DeliveryResult, ScopeState, SendRequest } from "../types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const accepted = (request: SendRequest): DeliveryResult => ({
  status: "accepted", receipt: { id: request.id, scopeId: request.scopeId, turnId: `turn-${request.id}` },
});

async function setup(options: { store?: ComposerStore; timeout?: number; send?: ComposerTransport["send"] } = {}) {
  const requests: SendRequest[] = [];
  const waiting = deferred<DeliveryResult>();
  const called = deferred<SendRequest>();
  const store = options.store ?? new MemoryComposerStore();
  const engine = await createComposer({
    scopeId: "project/thread", store, sendTimeoutMs: options.timeout ?? 5000,
    transport: {
      send: async (request, context) => {
        requests.push(structuredClone(request));
        called.resolve(request);
        return options.send ? options.send(request, context) : waiting.promise;
      },
      lookup: async ({ id, scopeId }) => ({ status: "accepted", receipt: { id, scopeId, turnId: `turn-${id}` } }),
    },
  });
  return { engine, store, requests, waiting, called };
}

function until(engine: Awaited<ReturnType<typeof createComposer>>, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("State transition was not observed")); }, 3000);
    const stop = engine.subscribe(() => {
      if (predicate()) { clearTimeout(timer); stop(); resolve(); }
    });
  });
}

test("FM01: durable handoff clears the editor before transport resolves and double submit sends once", async () => {
  const { engine, called, waiting, requests, store } = await setup();
  await engine.edit(textSnapshot("A"));
  const first = engine.submit();
  assert.equal(await engine.submit(), null);
  const record = await first;
  const request = await called.promise;
  assert.ok(record);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "");
  assert.equal((await store.read("project/thread"))!.submissions[0].snapshot.text, "A");
  assert.equal(await engine.submit(), null);
  assert.equal(requests.length, 1);
  waiting.resolve(accepted(request));
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
  await engine.close();
});

test("FM02: late acceptance cannot erase B, even when B has exactly the same text as A", async () => {
  for (const newText of ["B", "A", " \n"]) {
    const { engine, called, waiting } = await setup();
    await engine.edit(textSnapshot("A"));
    await engine.submit();
    const request = await called.promise;
    await engine.edit(textSnapshot(newText));
    const generation = engine.getSnapshot().state.draft.generation;
    waiting.resolve(accepted(request));
    await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
    assert.equal(engine.getSnapshot().state.draft.snapshot.text, newText);
    assert.equal(engine.getSnapshot().state.draft.generation, generation);
    await engine.close();
  }
});

test("FM03: thrown transport errors are unknown, not a draft restoration or automatic resend", async () => {
  const { engine, requests } = await setup({ send: async () => { throw new Error("reply lost"); } });
  await engine.edit(textSnapshot("A"));
  const record = await engine.submit();
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "unknown");
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "");
  assert.equal(await engine.retry(record!.id), false);
  assert.equal(await engine.restore(record!.id), false);
  assert.equal(requests.length, 1);
  await engine.close();
});

test("FM04: timeout releases only its own attempt; a late receipt preserves a new draft", async () => {
  const { engine, called, waiting, requests } = await setup({ timeout: 20 });
  await engine.edit(textSnapshot("A"));
  const record = await engine.submit();
  const request = await called.promise;
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "unknown");
  assert.equal(engine.getSnapshot().sending, false);
  await engine.edit(textSnapshot("B"));
  waiting.resolve(accepted(request));
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "B");
  assert.equal(engine.getSnapshot().state.submissions[0].id, record!.id);
  assert.equal(requests.length, 1);
  await engine.close();
});

test("FM05: explicit rejection stays separate; restore refuses whitespace and occupied drafts", async () => {
  const { engine } = await setup({ send: async () => ({ status: "rejected", reason: "not admitted" }) });
  await engine.edit(textSnapshot("A"));
  const record = await engine.submit();
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "rejected");
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "");
  await engine.edit(textSnapshot(" \n"));
  assert.equal(await engine.restore(record!.id), false);
  await engine.edit(emptySnapshot());
  assert.equal(await engine.restore(record!.id), true);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "A");
  assert.equal(engine.getSnapshot().state.submissions[0].status, "cancelled");
  await engine.close();
});

test("FM06: write failure before handoff neither clears the draft nor dispatches the message", async () => {
  const backing = new MemoryComposerStore();
  let fail = false;
  let injections = 0;
  const store: ComposerStore = {
    read: (scope) => backing.read(scope),
    compareAndSwap: (scope, revision, next) => {
      if (fail) { injections++; throw new Error("quota exhausted"); }
      return backing.compareAndSwap(scope, revision, next);
    },
  };
  const { engine, requests } = await setup({ store });
  await engine.edit(textSnapshot("A"));
  fail = true;
  assert.equal(await engine.submit(), null);
  assert.equal(injections, 1);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "A");
  assert.equal(requests.length, 0);
  assert.equal(engine.getSnapshot().admitting, false);
  fail = false;
  await engine.close();
});

test("FM07: the local admission barrier blocks edits briefly, while network waiting leaves the new draft editable", async () => {
  const backing = new MemoryComposerStore();
  const gate = deferred<void>();
  const entered = deferred<void>();
  let hold = false;
  const { engine, called, waiting } = await setup({ store: {
    read: (scope) => backing.read(scope),
    async compareAndSwap(scope, revision, next) {
      if (hold) { entered.resolve(); await gate.promise; }
      return backing.compareAndSwap(scope, revision, next);
    },
  } });
  await engine.edit(textSnapshot("A"));
  hold = true;
  const pending = engine.submit();
  await entered.promise;
  assert.equal(await engine.edit(textSnapshot("unsafe edit during local handoff")), false);
  hold = false;
  gate.resolve();
  await pending;
  const request = await called.promise;
  assert.equal(await engine.edit(textSnapshot("B")), true);
  waiting.resolve(accepted(request));
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "B");
  await engine.close();
});

test("FM08: attachment-only input is a message; snapshots and Blob bytes survive rejection and restoration", async () => {
  const { engine } = await setup({ send: async () => ({ status: "rejected", reason: "not admitted" }) });
  const snapshot = {
    ...emptySnapshot(),
    document: { format: "lexical", version: 1, value: { root: { children: [{ type: "mention", id: "person" }] } } },
    attachments: [{ id: "file", name: "你好.txt", mediaType: "text/plain", data: new Blob(["payload"]) }],
    references: [{ id: "person", kind: "mention", value: { label: "Person" } }],
  };
  await engine.edit(snapshot);
  const record = await engine.submit();
  assert.ok(record);
  snapshot.attachments.length = 0;
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "rejected");
  assert.equal(await engine.restore(record!.id), true);
  const restored = engine.getSnapshot().state.draft.snapshot;
  assert.equal(await restored.attachments[0].data.text(), "payload");
  assert.equal(restored.references[0].id, "person");
  assert.deepEqual(restored.document!.value, { root: { children: [{ type: "mention", id: "person" }] } });
  await engine.close();
});

test("FM09: restart turns interrupted sends into unknown without resending, while retaining the newer draft", async () => {
  const original = await setup();
  await original.engine.edit(textSnapshot("A"));
  await original.engine.submit();
  await original.called.promise;
  await original.engine.edit(textSnapshot("B"));
  await original.engine.close();
  const restored = await setup({ store: original.store });
  assert.equal(restored.engine.getSnapshot().state.draft.snapshot.text, "B");
  assert.equal(restored.engine.getSnapshot().state.submissions[0].status, "unknown");
  assert.equal(restored.requests.length, 0);
  assert.equal(await restored.engine.query(restored.engine.getSnapshot().state.submissions[0].id), true);
  assert.equal(restored.requests.length, 0);
  await restored.engine.close();
});

test("FM10: rejected retries preserve the original id and payload; edited recovery creates a different message", async () => {
  let count = 0;
  const { engine, requests } = await setup({ send: async (request) => {
    count++;
    return count === 1 ? { status: "rejected", reason: "not admitted" } : accepted(request);
  } });
  await engine.edit(textSnapshot("A"));
  const record = await engine.submit();
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "rejected");
  assert.equal(await engine.retry(record!.id), true);
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, requests[1].id);
  assert.deepEqual(requests[0].snapshot, requests[1].snapshot);
  await engine.close();
});

test("FM11: queued messages are durable full snapshots; Up cannot overwrite a draft", async () => {
  const { engine, store } = await setup();
  await engine.beginTurn("existing-turn");
  await engine.edit(textSnapshot("queued"));
  const record = await engine.submit();
  assert.equal(record!.status, "queued");
  assert.equal((await store.read("project/thread"))!.submissions[0].snapshot.text, "queued");
  await engine.edit(textSnapshot("B"));
  assert.equal(await engine.takeLatestQueued(), false);
  await engine.edit(emptySnapshot());
  assert.equal(await engine.takeLatestQueued(), true);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "queued");
  await engine.close();
});

test("FM12: ending a turn dispatches one queued start; the next waits for the newly accepted turn", async () => {
  const { engine, requests } = await setup({ send: async (request) => accepted(request) });
  await engine.beginTurn("old-turn");
  for (const text of ["B", "C"]) { await engine.edit(textSnapshot(text)); await engine.submit(); }
  await engine.endTurn("wrong-turn");
  assert.equal(requests.length, 0);
  await engine.endTurn("old-turn");
  await until(engine, () => requests.length === 1 && engine.getSnapshot().state.submissions[0].status === "accepted");
  assert.equal(requests[0].snapshot.text, "B");
  assert.equal(engine.getSnapshot().state.submissions[1].status, "queued");
  await engine.endTurn(`turn-${requests[0].id}`);
  await until(engine, () => requests.length === 2 && engine.getSnapshot().state.submissions[1].status === "accepted");
  assert.equal(requests[1].snapshot.text, "C");
  await engine.close();
});

test("FM13: steer carries the active turn ID, while none retains the draft", async () => {
  const { engine, called, waiting } = await setup();
  await engine.beginTurn("active");
  engine.setBusyMode("none");
  await engine.edit(textSnapshot("keep"));
  assert.equal(await engine.submit(), null);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "keep");
  engine.setBusyMode("steer");
  await engine.submit();
  const request = await called.promise;
  assert.equal(request.delivery, "steer");
  assert.equal(request.turnId, "active");
  waiting.resolve({ status: "accepted", receipt: { id: request.id, scopeId: request.scopeId, turnId: "active" } });
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "accepted");
  await engine.close();
});

test("FM14: CAS prevents a second window from overwriting the first window's persisted draft", async () => {
  const store = new MemoryComposerStore();
  const a = await setup({ store });
  const b = await setup({ store });
  await a.engine.edit(textSnapshot("A"));
  assert.equal(await b.engine.edit(textSnapshot("B")), false);
  assert.equal((await store.read("project/thread"))!.draft.snapshot.text, "A");
  assert.equal(b.engine.getSnapshot().state.draft.snapshot.text, "B");
  assert.equal(b.engine.getSnapshot().dirty, true);
  await a.engine.close();
  await b.engine.close();
});

test("FM15: malformed or cross-scope receipts never count as successful delivery", async () => {
  const { engine } = await setup({ send: async (request) => ({ status: "accepted", receipt: { id: request.id, scopeId: "other", turnId: "turn" } }) });
  await engine.edit(textSnapshot("A"));
  await engine.submit();
  await until(engine, () => engine.getSnapshot().state.submissions[0].status === "unknown");
  assert.equal(engine.getSnapshot().state.activeTurn, null);
  await engine.close();
});

test("FM16: empty / IME / explicit newline / repeat follow key semantics without triggering submission", async () => {
  const { engine, requests } = await setup();
  let prevented = 0;
  const event = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => { prevented++; } };
  engine.handleKey(event);
  assert.equal(prevented, 1);
  engine.handleKey({ ...event, isComposing: true });
  engine.handleKey({ ...event, nativeEvent: { isComposing: true } });
  engine.handleKey({ ...event, shiftKey: true });
  assert.equal(prevented, 1);
  await engine.edit(textSnapshot("A"));
  engine.handleKey({ ...event, repeat: true });
  await engine.idle();
  assert.equal(requests.length, 0);
  assert.equal(engine.getSnapshot().state.draft.snapshot.text, "A");
  await engine.close();
});
