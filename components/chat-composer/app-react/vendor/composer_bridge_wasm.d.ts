/* tslint:disable */
/* eslint-disable */
/**
 * Web 宿主桥：一个实例 = 一个 composer 会话（scope）。
 */
export class WasmBridge {
  free(): void;
  /**
   * 未回执引用数（诊断/卸载前检查）。
   */
  pending_count(): number;
  /**
   * Effect 回执（ref_id + EffectOutcomeDto JSON）→ DispatchResultDto JSON。
   * UnknownRef/OutcomeMismatch 以 Err 字符串返回（JS 侧按异常处理）。
   */
  ack(ref_id: number, outcome_json: string): string;
  /**
   * 构造。scope = 会话身份（回执 receipt.scope 必须与之一致，否则 IdentityMismatch
   * → uncertain——宿主配错身份时 FM15 的纪律正确兜底，D004 实录）。
   * state_json = Some(持久化的 ScopeState JSON) 恢复（FM09）；None 全新。
   */
  constructor(scope: string, state_json?: string | null);
  /**
   * 派发 UI 事件（ComposerEventDto JSON）→ DispatchResultDto JSON。
   */
  dispatch(event_json: string): string;
  /**
   * 当前完整快照（SnapshotDto JSON）。
   */
  snapshot(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmbridge_free: (a: number, b: number) => void;
  readonly wasmbridge_ack: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly wasmbridge_dispatch: (a: number, b: number, c: number) => [number, number, number, number];
  readonly wasmbridge_new: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly wasmbridge_pending_count: (a: number) => number;
  readonly wasmbridge_snapshot: (a: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
