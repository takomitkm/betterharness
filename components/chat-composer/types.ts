export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  /** Immutable bytes, persisted by IndexedDB. An object URL is never a durable file reference. */
  data: Blob;
}

export interface ComposerSnapshot {
  text: string;
  document?: { format: string; version: number; value: JsonValue };
  attachments: Attachment[];
  references: { id: string; kind: string; value: JsonValue }[];
}

export interface Draft {
  generation: string;
  revision: number;
  snapshot: ComposerSnapshot;
}

export type Delivery = "start" | "steer";
export type BusyMode = "queue" | "steer" | "none";
export type SubmissionStatus = "queued" | "sending" | "accepted" | "rejected" | "unknown" | "cancelled";

export interface Receipt {
  id: string;
  scopeId: string;
  turnId: string;
}

export type DeliveryResult =
  | { status: "accepted"; receipt: Receipt }
  | { status: "rejected"; reason: string }
  | { status: "unknown"; reason: string };

export interface Submission {
  id: string;
  scopeId: string;
  sourceGeneration: string;
  snapshot: ComposerSnapshot;
  status: SubmissionStatus;
  delivery: Delivery;
  queuedForTurn: string | null;
  attemptId: string | null;
  attempts: number;
  createdAt: number;
  reason?: string;
  receipt?: Receipt;
}

export interface ScopeState {
  schema: 1;
  scopeId: string;
  revision: number;
  draft: Draft;
  submissions: Submission[];
  activeTurn: string | null;
  finishedTurns: string[];
}

export interface ComposerStore {
  read(scopeId: string): Promise<ScopeState | null>;
  /** Atomically compare the revision and replace the complete scope, including Blob bytes. */
  compareAndSwap(scopeId: string, expectedRevision: number | null, next: ScopeState): Promise<boolean>;
}

export interface SendRequest {
  id: string;
  scopeId: string;
  snapshot: ComposerSnapshot;
  delivery: Delivery;
  turnId: string | null;
}

export interface ComposerTransport {
  /** The host must deduplicate by (scopeId, id), and report durable admission, not generation completion. */
  send(request: SendRequest, options: { signal: AbortSignal }): Promise<DeliveryResult>;
  /** A missing receipt must remain unknown unless the host can prove non-admission. */
  lookup(request: { id: string; scopeId: string }, options: { signal: AbortSignal }): Promise<DeliveryResult>;
}

export interface ComposerView {
  state: ScopeState;
  admitting: boolean;
  sending: boolean;
  pendingReceipts: number;
  paused: boolean;
  dirty: boolean;
  closed: boolean;
  error: string | null;
}

export interface ComposerOptions {
  scopeId: string;
  store: ComposerStore;
  transport: ComposerTransport;
  busyMode?: BusyMode;
  sendTimeoutMs?: number;
  id?: () => string;
  now?: () => number;
}

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  preventDefault(): void;
}

export interface ComposerEditorAdapter {
  capture(): ComposerSnapshot;
  /** Restore only into the exact draft version the caller observed. */
  apply(snapshot: ComposerSnapshot, expected: { generation: string; revision: number }): Promise<boolean>;
}
