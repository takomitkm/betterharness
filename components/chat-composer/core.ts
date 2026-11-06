import type {
  BusyMode, ComposerKeyEvent, ComposerOptions, ComposerSnapshot, ComposerView,
  DeliveryResult, Draft, ScopeState, SendRequest, Submission,
} from "./types.ts";
import { copy, emptySnapshot, freeze, hasContent, isEmptyDraft, validateSnapshot, validateState } from "./snapshots.ts";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function createComposer(options: ComposerOptions): Promise<ComposerEngine> {
  const engine = new ComposerEngine(options);
  await engine.initialize();
  return engine;
}

/** Owns one scope. React is only a subscriber; no side effects run inside React state updaters. */
export class ComposerEngine {
  private durable!: ScopeState;
  private draft!: Draft;
  private view!: ComposerView;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private admitting = false;
  private paused = false;
  private closed = false;
  private error: string | null = null;
  private mode: BusyMode;
  private pumping = false;
  private active: { id: string; attemptId: string; controller: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;
  private queries = new Set<AbortController>();
  private pendingResults = new Map<string, { attemptId: string | null; result: DeliveryResult }>();
  private readonly id: () => string;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly options: ComposerOptions;

  constructor(options: ComposerOptions) {
    this.options = options;
    if (!options.scopeId) throw new Error("A stable scopeId is required");
    this.mode = options.busyMode ?? "queue";
    this.id = options.id ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    this.timeout = options.sendTimeoutMs ?? 15000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new Error("Invalid send timeout");
  }

  async initialize(): Promise<void> {
    let saved = await this.options.store.read(this.options.scopeId);
    const existed = saved !== null;
    if (!saved) {
      const initial: ScopeState = {
        schema: 1, scopeId: this.options.scopeId, revision: 0,
        draft: this.newDraft(), submissions: [], activeTurn: null, finishedTurns: [],
      };
      if (await this.options.store.compareAndSwap(this.options.scopeId, null, initial)) saved = initial;
      else saved = await this.options.store.read(this.options.scopeId);
    }
    if (!saved) throw new Error("Composer scope could not be initialized");
    validateState(saved, this.options.scopeId);
    this.durable = copy(saved);
    this.draft = copy(saved.draft);
    // A restarted renderer cannot know whether its former request reached the host.
    if (saved.submissions.some((record) => record.status === "sending")) {
      const next = copy(saved);
      for (const record of next.submissions) {
        if (record.status === "sending") {
          record.status = "unknown";
          record.reason = "应用已重启，先前提交的送达结果待确认";
        }
      }
      await this.commit(next);
    }
    this.paused = existed && Boolean(this.durable.activeTurn || this.durable.submissions.some(
      (record) => record.status === "queued" || record.status === "unknown",
    ));
    this.publish();
  }

  private newDraft(snapshot = emptySnapshot()): Draft {
    return { generation: this.id(), revision: 0, snapshot: copy(snapshot) };
  }

  private publish(): void {
    this.view = freeze({
      state: { ...copy(this.durable), draft: copy(this.draft) },
      admitting: this.admitting,
      sending: Boolean(this.active) || this.durable.submissions.some((record) => record.status === "sending" && !this.pendingResults.has(record.id)),
      pendingReceipts: this.pendingResults.size,
      paused: this.paused,
      dirty: this.draft.generation !== this.durable.draft.generation || this.draft.revision !== this.durable.draft.revision,
      closed: this.closed, error: this.error,
    });
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): ComposerView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Serializes writes within this engine; CAS also protects against independent windows. */
  private run<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed) return fallback;
      try { return await work(); }
      catch (error) {
        this.error = messageOf(error);
        this.publish();
        return fallback;
      }
    });
    this.tail = result.then(() => undefined);
    return result;
  }

  private async commit(next: ScopeState, replaceDraft?: Draft): Promise<void> {
    next.revision = this.durable.revision + 1;
    validateState(next, this.options.scopeId);
    const saved = await this.options.store.compareAndSwap(this.options.scopeId, this.durable.revision, next);
    if (!saved) {
      this.paused = true;
      throw new Error("另一窗口已修改此会话；本地新输入已保留，请复制后重新打开会话");
    }
    this.durable = copy(next);
    if (replaceDraft) this.draft = copy(replaceDraft);
    this.error = null;
    this.publish();
  }

  idle(): Promise<unknown> { return this.tail; }
  setBusyMode(mode: BusyMode): void { this.mode = mode; }

  edit(snapshot: ComposerSnapshot): Promise<boolean> {
    if (this.closed || this.admitting) return Promise.resolve(false);
    try { validateSnapshot(snapshot); }
    catch (error) { this.error = messageOf(error); this.publish(); return Promise.resolve(false); }
    const nextDraft = { ...this.draft, revision: this.draft.revision + 1, snapshot: copy(snapshot) };
    this.draft = nextDraft;
    this.publish();
    return this.run(async () => {
      const next = copy(this.durable);
      next.draft = copy(nextDraft);
      await this.commit(next);
      return true;
    }, false);
  }

  submit(): Promise<Submission | null> {
    if (this.closed || this.admitting || this.view.sending || !hasContent(this.draft.snapshot)) return Promise.resolve(null);
    if (this.durable.activeTurn && this.mode === "none") return Promise.resolve(null);
    const captured = copy(this.draft);
    // The short read-only interval is local persistence, never the network or model turn.
    this.admitting = true;
    this.publish();
    const result = this.run(async () => {
      const next = copy(this.durable);
      const activeTurn = next.activeTurn;
      const record: Submission = {
        id: this.id(), scopeId: next.scopeId, sourceGeneration: captured.generation,
        snapshot: copy(captured.snapshot), status: "queued",
        delivery: activeTurn && this.mode === "steer" ? "steer" : "start",
        queuedForTurn: activeTurn, attemptId: null, attempts: 0, createdAt: this.now(),
      };
      if (next.submissions.some((existing) => existing.id === record.id)) throw new Error("Duplicate generated submission ID");
      next.submissions.push(record);
      next.draft = this.newDraft();
      // Both payload ownership and the empty successor draft are one durable transaction.
      await this.commit(next, next.draft);
      return copy(record);
    }, null as Submission | null);
    return result.finally(() => {
      this.admitting = false;
      this.publish();
      this.pump();
    });
  }

  handleKey(event: ComposerKeyEvent): void {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!event.repeat) void this.submit();
  }

  private pump(): void {
    if (this.pumping || this.closed || this.paused || this.admitting || this.active) return;
    this.pumping = true;
    void this.run(async () => {
      if (this.paused || this.active || this.durable.submissions.some((record) => record.status === "sending" || record.status === "unknown")) return;
      const first = this.durable.submissions.find((record) => record.status === "queued");
      if (!first) return;
      if (this.durable.activeTurn && !(first.delivery === "steer" && first.queuedForTurn === this.durable.activeTurn)) return;
      const next = copy(this.durable);
      const record = next.submissions.find((item) => item.id === first.id)!;
      record.status = "sending";
      record.attemptId = this.id();
      record.attempts++;
      delete record.reason;
      await this.commit(next);
      if (this.closed) return;
      const request: SendRequest = {
        id: record.id, scopeId: record.scopeId, snapshot: copy(record.snapshot),
        delivery: next.activeTurn ? "steer" : "start", turnId: next.activeTurn,
      };
      this.dispatch(request, record.attemptId!);
    }, undefined).finally(() => { this.pumping = false; });
  }

  private dispatch(request: SendRequest, attemptId: string): void {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      this.releaseAttempt(request.id, attemptId);
      controller.abort();
      void this.applyResult(request.id, attemptId, { status: "unknown", reason: "确认超时，未自动重发" });
    }, this.timeout);
    this.active = { id: request.id, attemptId, controller, timer };
    // A Promise rejection is not proof of non-admission. Late responses retain the original identity.
    void Promise.resolve().then(() => this.options.transport.send(copy(request), { signal: controller.signal })).then(
      (result) => {
        if (this.closed) return;
        this.releaseAttempt(request.id, attemptId);
        void this.applyResult(request.id, attemptId, result);
      },
      (error) => {
        if (this.closed) return;
        this.releaseAttempt(request.id, attemptId);
        void this.applyResult(request.id, attemptId, { status: "unknown", reason: messageOf(error) });
      },
    );
  }

  private releaseAttempt(id: string, attemptId: string): void {
    if (this.active?.id !== id || this.active.attemptId !== attemptId) return;
    clearTimeout(this.active.timer);
    this.active = null;
  }

  private normalize(id: string, result: DeliveryResult): DeliveryResult {
    if (!result || !["accepted", "rejected", "unknown"].includes(result.status)) {
      return { status: "unknown", reason: "宿主返回了无效的送达结果" };
    }
    if (result.status === "accepted" && (!result.receipt || result.receipt.id !== id || result.receipt.scopeId !== this.options.scopeId || typeof result.receipt.turnId !== "string" || !result.receipt.turnId)) {
      return { status: "unknown", reason: "回执的消息、会话或轮次身份不匹配" };
    }
    return result;
  }

  private applyResult(id: string, attemptId: string | null, raw: DeliveryResult): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const previous = this.pendingResults.get(id);
    const entry = previous?.result.status === "accepted" && previous.attemptId === attemptId ? previous : { attemptId, result: this.normalize(id, raw) };
    this.pendingResults.set(id, entry);
    const forget = () => {
      if (this.pendingResults.get(id) === entry) this.pendingResults.delete(id);
      this.publish();
    };
    return this.run(async () => {
      const result = entry.result;
      const next = copy(this.durable);
      const record = next.submissions.find((item) => item.id === id);
      if (!record || record.status === "cancelled" || record.status === "accepted") { forget(); return false; }
      // A late rejection from a previous attempt cannot reject a newer retry.
      if (entry.attemptId && record.attemptId !== entry.attemptId) { forget(); return false; }
      if (record.status === "rejected" && result.status === "unknown") { forget(); return false; }
      record.status = result.status;
      if (result.status === "accepted") {
        record.receipt = copy(result.receipt);
        delete record.reason;
        if (!next.finishedTurns.includes(result.receipt.turnId) && (!next.activeTurn || next.activeTurn === record.queuedForTurn)) {
          next.activeTurn = result.receipt.turnId;
        }
      } else {
        record.reason = result.reason;
      }
      // If saving the receipt fails, retain it locally for flush(); never send the message again.
      await this.commit(next);
      forget();
      return true;
    }, false).finally(() => this.pump());
  }

  async flush(): Promise<boolean> {
    if (this.closed) return false;
    if (this.view.dirty && !await this.edit(copy(this.draft.snapshot))) return false;
    for (const [id, entry] of [...this.pendingResults]) {
      await this.applyResult(id, entry.attemptId, entry.result);
      if (this.pendingResults.has(id)) return false;
    }
    await this.idle();
    this.pump();
    return this.pendingResults.size === 0 && !this.view.dirty;
  }

  query(id: string): Promise<boolean> {
    const record = this.durable.submissions.find((item) => item.id === id);
    if (!record || record.status !== "unknown" || this.closed) return Promise.resolve(false);
    const controller = new AbortController();
    this.queries.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const cancelled = new Promise<DeliveryResult>((resolve) => {
      onAbort = () => resolve({ status: "unknown", reason: "查询已取消，未自动重发" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timeout = new Promise<DeliveryResult>((resolve) => {
      timer = setTimeout(() => { resolve({ status: "unknown", reason: "查询超时，仍未自动重发" }); controller.abort(); }, this.timeout);
    });
    return Promise.race([
      Promise.resolve().then(() => this.options.transport.lookup({ id, scopeId: this.options.scopeId }, { signal: controller.signal })).catch(
        (error): DeliveryResult => ({ status: "unknown", reason: messageOf(error) }),
      ), timeout, cancelled,
    ]).then((result) => this.applyResult(id, record.attemptId, result)).finally(() => {
      clearTimeout(timer!);
      controller.signal.removeEventListener("abort", onAbort!);
      this.queries.delete(controller);
    });
  }

  retry(id: string): Promise<boolean> {
    if (this.closed || this.admitting) return Promise.resolve(false);
    return this.run(async () => {
      const next = copy(this.durable);
      const record = next.submissions.find((item) => item.id === id);
      if (!record || record.status !== "rejected" || this.pendingResults.has(id)) return false;
      record.status = "queued";
      record.attemptId = null;
      record.delivery = "start";
      record.queuedForTurn = next.activeTurn;
      delete record.reason;
      await this.commit(next);
      return true;
    }, false).finally(() => this.pump());
  }

  restore(id: string): Promise<boolean> {
    if (this.closed || this.admitting || !isEmptyDraft(this.draft.snapshot)) return Promise.resolve(false);
    this.admitting = true;
    this.publish();
    return this.run(async () => {
      const next = copy(this.durable);
      const record = next.submissions.find((item) => item.id === id);
      if (!record || !["rejected", "queued"].includes(record.status)) return false;
      next.draft = this.newDraft(record.snapshot);
      record.status = "cancelled";
      record.reason = "已取回到独立草稿";
      await this.commit(next, next.draft);
      return true;
    }, false).finally(() => { this.admitting = false; this.publish(); });
  }

  /** Explicit local deletion releases only this record's payload. Unknown and queued records stay owned. */
  remove(id: string): Promise<boolean> {
    return this.run(async () => {
      const next = copy(this.durable);
      const record = next.submissions.find((item) => item.id === id);
      if (!record || !["accepted", "rejected", "cancelled"].includes(record.status)) return false;
      next.submissions = next.submissions.filter((item) => item.id !== id);
      await this.commit(next);
      return true;
    }, false);
  }

  takeLatestQueued(): Promise<boolean> {
    const record = [...this.durable.submissions].reverse().find((item) => item.status === "queued");
    return record ? this.restore(record.id) : Promise.resolve(false);
  }

  beginTurn(turnId: string): Promise<boolean> {
    if (!turnId) return Promise.resolve(false);
    return this.run(async () => {
      const next = copy(this.durable);
      if (next.finishedTurns.includes(turnId) || (next.activeTurn && next.activeTurn !== turnId)) return false;
      next.activeTurn = turnId;
      await this.commit(next);
      return true;
    }, false);
  }

  endTurn(turnId: string): Promise<boolean> {
    if (!turnId) return Promise.resolve(false);
    return this.run(async () => {
      if (this.durable.finishedTurns.includes(turnId)) return false;
      const next = copy(this.durable);
      const current = next.activeTurn === turnId;
      next.finishedTurns.push(turnId);
      if (current) next.activeTurn = null;
      await this.commit(next);
      return current;
    }, false).finally(() => this.pump());
  }

  resume(): void {
    if (this.closed) return;
    this.paused = false;
    this.publish();
    this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Queue this behind admitted local writes, retaining interrupted payloads in durable storage.
    await this.run(async () => {
      this.closed = true;
      if (this.active) {
        const active = this.active;
        clearTimeout(active.timer);
        active.controller.abort();
        this.active = null;
      }
      for (const query of this.queries) query.abort();
      this.queries.clear();
      this.publish();
    }, undefined);
    this.listeners.clear();
  }
}
