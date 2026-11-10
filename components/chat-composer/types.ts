export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * 品牌化身份类型：运行时就是非空 string，编译期防止与普通文本混用。
 * - AssetId 标识一个附件资产（snapshot.attachments 的条目键）；
 * - NodeId 标识有序文档中的一个节点。
 * 两者都不是数组下标，也不是 blob URL；插入、移动、重排或恢复草稿时身份保持不变。
 */
export type AssetId = string & { readonly __brand: "AssetId" };
export type NodeId = string & { readonly __brand: "NodeId" };

export interface Attachment {
  /** AssetId：附件资产的稳定身份，有序文档中的附件节点通过 assetId 引用它。 */
  id: AssetId;
  name: string;
  mediaType: string;
  /** Immutable bytes, persisted by IndexedDB. An object URL is never a durable file reference. */
  data: Blob;
  /** 图片可选替代文本（无障碍）：随快照持久化并进入发送载荷；文件卡无此概念。 */
  alt?: string;
  /**
   * 图片可选发送模式：true = 原图按文件发送（不压缩），缺省 = 常规图片。
   * 组件只存储并持久化该标志（卡片切换呈现），压缩/原样编码由宿主发送管线消费——不伪造上传行为。
   */
  sendAsFile?: boolean;
}

/** 附件条目（以 AssetId 为键的 AssetMeta）：Blob 字节始终留在 JS 侧，从不进入 document.value。 */
export type AssetMeta = Attachment;

/**
 * 有序文档中附件节点的约定形状。core 把 document.value 视为不透明 JSON（由编辑器拥有并序列化），
 * 但 NodeId/AssetId 就住在 value 里：编辑器按此形状写入，validateSnapshot 按此形状校验引用完整性。
 * 引用/提及节点继续携带既有的 referenceId（见 LexicalEditor 的 ComposerMentionNode）。
 * 用 type alias（而非 interface）让它保持对 JsonValue 的隐式索引签名兼容。
 */
export type AttachmentNodeJson = {
  type: "composer-attachment";
  version: number;
  nodeId: NodeId;
  assetId: AssetId;
};

export interface ComposerSnapshot {
  text: string;
  /**
   * 有序文档（可选）。包装形态保持不变：{ format: "lexical", version, value }；
   * value 对 core 不透明、由编辑器拥有，但 NodeId/AssetId 就住在 value 内部——
   * 附件节点形如 { type: "composer-attachment", version, nodeId: NodeId, assetId: AssetId }。
   * 文档与附件条目是同一份内容的两面：validateSnapshot 保证文档附件节点的 assetId
   * 都能在 snapshot.attachments 里找到；未被文档引用的附件合法（rail-only）。
   */
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
