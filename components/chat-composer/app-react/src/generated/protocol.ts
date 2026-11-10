// Composer Bridge 协议类型（生成面）——与 crates/composer-bridge-protocol 的
// BM05 JSON 形状测试一一对应（契约冻结）。修改任何形状必须两侧同步 + 形状测试。
// 生成方式：v1 手写对照（契约由 BM05 冻结）；迁移 ts-rs 时不破坏 JSON 形状。

export const PROTOCOL_VERSION = 1;

export type BusyEnterDto = 'queue' | 'steer';

/** 完整业务快照（v1 全量）。 */
export interface SnapshotDto {
  protocol_version: number;
  /** Bridge 级单调递增：每次快照发射 +1。UI 忽略 revision 更小的快照。 */
  revision: number;
  admitting: boolean;
  paused: boolean;
  closed: boolean;
  busy_mode: BusyEnterDto;
  pending_receipt_count: number;
  state: {
    schema: number;
    scope: string;
    revision: number;
    draft: {
      generation: string;
      revision: number;
      snapshot: { text: string; attachment_ids: string[]; reference_ids: string[] };
    };
    submissions: {
      id: string;
      scope: string;
      source_generation: string;
      snapshot: { text: string; attachment_ids: string[]; reference_ids: string[] };
      status: 'queued' | 'sending' | 'accepted' | 'rejected' | 'uncertain' | 'cancelled';
      delivery: 'start' | 'steer';
      queued_for_turn: string | null;
      attempt: string | null;
      attempts: number;
      created_at_ms: number;
      reason: string | null;
    }[];
    active_turn: string | null;
    finished_turns: string[];
    pending_receipts: unknown[];
  };
}

/** UI 可发的事件（窄面；回执类只能走 ackEffect）。 */
export type ComposerEventDto =
  | { type: 'edit'; text: string }
  | { type: 'submit' }
  | { type: 'set_busy_mode'; mode: BusyEnterDto }
  | { type: 'begin_turn'; turn_id: string }
  | { type: 'end_turn'; turn_id: string }
  | { type: 'restore'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'flush' }
  | { type: 'resume' }
  | { type: 'close' };

export type EffectDto =
  | { type: 'persist'; state: SnapshotDto['state'] }
  | { type: 'deliver'; id: string; attempt: string; delivery: 'start' | 'steer'; turn: string | null }
  | { type: 'schedule_timeout'; id: string; attempt: string; deadline_ms: number }
  | { type: 'cancel_timeout'; id: string; attempt: string }
  | { type: 'lookup'; id: string }
  | { type: 'cancel_all_lookups' };

/** Effect 回执。Cancel* 不产生引用（fire-and-forget）。 */
export type EffectOutcomeDto =
  | { outcome: 'persisted'; ok: boolean }
  | { outcome: 'delivered'; result: DeliveryResultDto }
  | { outcome: 'timed_out' }
  | { outcome: 'lookup_returned'; result: DeliveryResultDto };

export type DeliveryResultDto =
  | { status: 'accepted'; receipt: { id: string; scope: string; turn: string } }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string };

/** 带引用的 Effect：宿主执行完必须 ack（ref_id 0 = 无引用）。 */
export interface EffectRefDto {
  ref_id: number;
  effect: EffectDto;
}

export interface DispatchResultDto {
  snapshot: SnapshotDto;
  effects: EffectRefDto[];
}

/** ack 错误（WASM Host 以 Err 字符串抛出，含这些判词）。 */
export type AckErrorKind = 'UnknownRef' | 'OutcomeMismatch';

/** 类型守卫：DispatchResultDto 的最小结构校验（桥面是 JSON 字符串，解析后先守卫）。 */
export function isDispatchResult(value: unknown): value is DispatchResultDto {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as DispatchResultDto;
  return (
    typeof candidate.snapshot?.revision === 'number'
    && Array.isArray(candidate.effects)
    && candidate.snapshot.state?.draft?.snapshot?.text !== undefined
  );
}
