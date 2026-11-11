// WasmEngine：把 WasmBridge（真实 Rust Core WASM）适配成 archive 的 ComposerEngine
// 形状——LexicalEditor/ChatComposer/TextareaEditor 的调用点零改动。
//
// 范围（D004）：文本语义全保真（edit/submit/handleKey/queue/turn/hold/timeout/恢复）；
// 富文本 document 与附件 Blob 车道 = 协议 v2（Edit 事件的 text-only 形状已冻结，
// document 车道待后续扩展）；query(主动 lookup) 未接（runtime 无该 Effect，UI 上的
// unknown「核对送达状态」按钮在 wasm 模式返回 false）。
// 持久化：v1 内存模拟 CAS（ok=true）；IndexedDB 接线是下一步（asset-inventory §4）。
import type {
  BusyMode, ComposerKeyEvent, ComposerOptions, ComposerSnapshot,
  ComposerView, DeliveryResult, Submission,
} from "../../types.ts";
import type { EngineFace } from "../../core.ts";
import {
  isDispatchResult,
  type ComposerEventDto, type DispatchResultDto, type EffectRefDto, type EffectOutcomeDto, type SnapshotDto,
} from "../generated/protocol.ts";

type WasmBridgeModule = {
  default: (init?: { module_or_path: string }) => Promise<void>;
  WasmBridge: new (scope: string, stateJson: string | null) => {
    snapshot(): string;
    dispatch(eventJson: string): string;
    ack(refId: number, outcomeJson: string): string;
    pendingCount(): number;
  };
};

const WASM_BRIDGE_JS = "/wasm/composer_bridge_wasm.js";
const WASM_BINARY = "/wasm/composer_bridge_wasm_bg.wasm";

/** DTO ↔ TS 形状换算（桥面 JSON → ComposerView/ComposerSnapshot）。 */
function toSnapshotShape(dto: SnapshotDto["state"]["draft"]["snapshot"]) {
  return { text: dto.text, attachments: [], references: [] } as ComposerSnapshot;
}

export class WasmEngine {
  private bridge: InstanceType<WasmBridgeModule["WasmBridge"]> | null = null;
  private view!: ComposerView;
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private options: ComposerOptions;

  constructor(options: ComposerOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    const module = (await import(/* @vite-ignore */ WASM_BRIDGE_JS)) as unknown as WasmBridgeModule;
    await module.default({ module_or_path: WASM_BINARY });
    this.bridge = new module.WasmBridge(this.options.scopeId, null);
    this.applySnapshot(JSON.parse(this.bridge.snapshot()));
    this.notify();
  }

  getSnapshot = (): ComposerView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private applySnapshot(dto: SnapshotDto): void {
    this.view = {
      state: {
        schema: 1,
        scopeId: dto.state.scope,
        revision: dto.state.revision,
        draft: {
          generation: dto.state.draft.generation,
          revision: dto.state.draft.revision,
          snapshot: toSnapshotShape(dto.state.draft.snapshot),
        },
        submissions: dto.state.submissions.map((submission) => ({
          id: submission.id,
          scopeId: submission.scope,
          sourceGeneration: submission.source_generation,
          snapshot: toSnapshotShape(submission.snapshot),
          // Rust 命名 uncertain = TS 契约 unknown（同一语义，两侧历史命名）。
          status: submission.status === "uncertain" ? "unknown" : submission.status,
          delivery: submission.delivery,
          queuedForTurn: submission.queued_for_turn,
          attemptId: submission.attempt,
          attempts: submission.attempts,
          createdAt: submission.created_at_ms,
          reason: submission.reason ?? undefined,
        })),
        activeTurn: dto.state.active_turn,
        finishedTurns: dto.state.finished_turns,
      },
      admitting: dto.admitting,
      sending: dto.state.submissions.some((submission) => submission.status === "sending"),
      pendingReceipts: dto.pending_receipt_count,
      paused: dto.paused,
      // Rust 侧 Edit 即时内存生效（无 dirty 中间态）；CAS 落盘义务由 Persist Effect 承载。
      dirty: false,
      closed: dto.closed,
      error: null,
    };
  }

  private applyResult(raw: unknown): DispatchResultDto {
    if (!isDispatchResult(raw)) throw new Error("bad bridge result");
    this.applySnapshot(raw.snapshot);
    this.notify();
    return raw;
  }

  /** 单一串行队列（对齐 TS engine 的 run/tail）：dispatch + 全部衍生 ack 依次执行。 */
  private enqueue(work: (bridge: NonNullable<WasmEngine["bridge"]>) => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => {
      if (!this.bridge) return;
      await work(this.bridge);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** 单个 Effect 的宿主执行：返回回执（无回执类返回 null——超时排程/取消）。 */
  private async executeEffect(ref: EffectRefDto): Promise<EffectOutcomeDto | null> {
    const effect = ref.effect;
    if (effect.type === "persist") {
      // v1：内存 CAS 模拟（ok=true）。IndexedDB 接线 = 下一步（CAS 语义不变）。
      return { outcome: "persisted", ok: true };
    }
    if (effect.type === "deliver") {
      let result: DeliveryResult;
      try {
        result = await this.options.transport.send({
          id: effect.id, scopeId: this.options.scopeId,
          snapshot: this.view.state.submissions.find((submission) => submission.id === effect.id)?.snapshot
            ?? { text: "", attachments: [], references: [] },
          delivery: effect.delivery, turnId: effect.turn,
        }, { signal: new AbortController().signal });
      } catch (error) {
        // 传输异常不是拒绝证明：unknown，不自动重发（FM03）。
        result = { status: "unknown", reason: String(error) };
      }
      const outcome: EffectOutcomeDto = { outcome: "delivered", result: toDtoResult(result, this.options.scopeId) };
      return outcome;
    }
    if (effect.type === "schedule_timeout") {
      const timer = setTimeout(() => {
        this.timeouts.delete(ref.ref_id);
        void this.enqueue(async (bridge) => {
          const result = this.applyResult(JSON.parse(bridge.ack(ref.ref_id, JSON.stringify({ outcome: "timed_out" }))));
          await this.pumpEffects(bridge, result);
        });
      }, Math.max(0, effect.deadline_ms - Date.now()));
      this.timeouts.set(ref.ref_id, timer);
      return null; // 到期时独立回 TimedOut；结果先到由 cancel_timeout 清除。
    }
    if (effect.type === "cancel_timeout") {
      const timer = this.timeouts.get(ref.ref_id);
      void timer;
      for (const [pendingRef, pendingTimer] of [...this.timeouts]) clearTimeout(pendingTimer);
      this.timeouts.clear();
      return null;
    }
    // cancel_all_lookups / lookup：清全部排程（v1 无主动 lookup，D004）。
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
    return null;
  }

  /**
   * Effects 泵：循环执行引用效果并把 ack 产生的新效果接力下去，直到无回执类效果
   * （Persist→Deliver→Persist→…链条一次跑完，对齐 TS engine 的 commit→pump 语义）。
   * guard 防御协议层异常导致的无限循环。
   */
  private async pumpEffects(engine: NonNullable<WasmEngine["bridge"]>, first: DispatchResultDto): Promise<void> {
    let current: DispatchResultDto | null = first;
    for (let guard = 0; current !== null && guard < 64; guard += 1) {
      let next: DispatchResultDto | null = null;
      for (const ref of current.effects) {
        if (ref.ref_id === 0) continue; // Cancel* 无引用（fire-and-forget）。
        const outcome = await this.executeEffect(ref);
        if (outcome === null) continue;
        next = this.applyResult(JSON.parse(engine.ack(ref.ref_id, JSON.stringify(outcome))));
      }
      current = next;
    }
  }

  private dispatchNow(event: ComposerEventDto): Promise<void> {
    return this.enqueue(async (bridge) => {
      const result = this.applyResult(JSON.parse(bridge.dispatch(JSON.stringify(event))));
      await this.pumpEffects(bridge, result);
    });
  }

  idle(): Promise<unknown> { return this.tail; }

  setBusyMode(mode: BusyMode): void {
    if (mode === "none") return; // Rust busy 面只有 queue/steer；none = 不提交（UI 侧守卫）。
    void this.dispatchNow({ type: "set_busy_mode", mode });
  }

  edit(snapshot: ComposerSnapshot): Promise<boolean> {
    // v1 文本语义：document/attachments 车道 = 协议 v2（D004）。
    void this.dispatchNow({ type: "edit", text: snapshot.text });
    return Promise.resolve(true);
  }

  submit(): Promise<Submission | null> {
    void this.dispatchNow({ type: "submit" });
    return Promise.resolve(null);
  }

  handleKey(event: ComposerKeyEvent): void {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!event.repeat) void this.submit();
  }

  async flush(): Promise<boolean> {
    await this.dispatchNow({ type: "flush" });
    return true;
  }

  query(_id: string): Promise<boolean> {
    // v1 未接主动 lookup（D004）：unknown 的「核对送达状态」在 wasm 模式不可用。
    return Promise.resolve(false);
  }

  retry(id: string): Promise<boolean> {
    void this.dispatchNow({ type: "retry", id });
    return Promise.resolve(true);
  }

  restore(id: string): Promise<boolean> {
    void this.dispatchNow({ type: "restore", id });
    return Promise.resolve(true);
  }

  remove(id: string): Promise<boolean> {
    void this.dispatchNow({ type: "remove", id });
    return Promise.resolve(true);
  }

  takeLatestQueued(): Promise<boolean> {
    const latest = [...this.view.state.submissions].reverse().find((submission) => submission.status === "queued");
    return latest ? this.restore(latest.id) : Promise.resolve(false);
  }

  beginTurn(turnId: string): Promise<boolean> {
    void this.dispatchNow({ type: "begin_turn", turn_id: turnId });
    return Promise.resolve(true);
  }

  endTurn(turnId: string): Promise<boolean> {
    void this.dispatchNow({ type: "end_turn", turn_id: turnId });
    return Promise.resolve(true);
  }

  resume(): void {
    void this.dispatchNow({ type: "resume" });
  }

  async close(): Promise<void> {
    await this.dispatchNow({ type: "close" });
  }
}

/** TS DeliveryResult → 协议 DTO 形状（receipt 字段名不同：scopeId/turnId vs scope/turn）。 */
type DeliveredResultDto = Extract<EffectOutcomeDto, { outcome: "delivered" }>["result"];
function toDtoResult(result: DeliveryResult, scope: string): DeliveredResultDto {
  if (result.status === "accepted") {
    return { status: "accepted", receipt: { id: result.receipt.id, scope, turn: result.receipt.turnId } };
  }
  return result.status === "rejected"
    ? { status: "rejected", reason: result.reason }
    : { status: "uncertain", reason: result.reason };
}

/** 构造并初始化 WASM 引擎（demo/宿主共用）。 */
export async function createWasmEngine(options: ComposerOptions): Promise<EngineFace> {
  const engine = new WasmEngine(options);
  await engine.initialize();
  return engine;
}
