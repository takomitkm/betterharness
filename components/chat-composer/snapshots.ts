import type { AssetId, ComposerSnapshot, JsonValue, NodeId, ScopeState } from "./types.ts";

/** 附件身份构造器：运行时即非空随机字符串，编译期带品牌。 */
export const newAssetId = (): AssetId => crypto.randomUUID() as AssetId;
/** 文档节点身份构造器：随节点创建而固定，之后移动/重排/恢复都不改变。 */
export const newNodeId = (): NodeId => crypto.randomUUID() as NodeId;
/** 包装既有字符串；空身份在构造时就拒绝，不让坏身份进入快照。 */
export const toAssetId = (value: string): AssetId => {
  if (!value) throw new Error("AssetId must be a non-empty string");
  return value as AssetId;
};
export const toNodeId = (value: string): NodeId => {
  if (!value) throw new Error("NodeId must be a non-empty string");
  return value as NodeId;
};

/** 文档内附件节点的候选记录（校验前的宽松形态：nodeId/assetId 尚未验证）。 */
export type AttachmentNodeCandidate = { readonly [key: string]: JsonValue };

const ATTACHMENT_NODE_TYPE = "composer-attachment";

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按出现顺序收集 document.value 里的全部附件节点（身份尚未校验的宽松记录）。 */
export function documentAttachmentNodes(value: JsonValue): AttachmentNodeCandidate[] {
  const found: AttachmentNodeCandidate[] = [];
  const walk = (node: JsonValue): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (isPlainObject(node)) {
      if (node.type === ATTACHMENT_NODE_TYPE) found.push(node);
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(value);
  return found;
}

function isAttachmentFor(value: JsonValue, assetId: AssetId): boolean {
  return isPlainObject(value) && value.type === ATTACHMENT_NODE_TYPE && value.assetId === assetId;
}

/**
 * 从文档 JSON 中摘除引用指定 AssetId 的附件节点：其余结构与顺序原样保留，一次纯函数变换。
 * 供「移除附件」把条目与其文档节点作为同一次变更撤下，避免文档引用悬空的 AssetId。
 */
export function documentWithoutAttachment(value: JsonValue, assetId: AssetId): JsonValue {
  if (Array.isArray(value)) {
    return value.filter((child) => !isAttachmentFor(child, assetId)).map((child) => documentWithoutAttachment(child, assetId));
  }
  if (isPlainObject(value)) {
    const next: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = isAttachmentFor(child, assetId) ? null : documentWithoutAttachment(child, assetId);
    }
    return next;
  }
  return value;
}

export const emptySnapshot = (): ComposerSnapshot => ({ text: "", attachments: [], references: [] });
export const textSnapshot = (text: string): ComposerSnapshot => ({ ...emptySnapshot(), text });

export function hasContent(snapshot: ComposerSnapshot): boolean {
  return Boolean(snapshot.text.trim() || snapshot.attachments.length || snapshot.references.length);
}

/** Whitespace is user input. It must not be silently replaced when recovering a message. */
export function isEmptyDraft(snapshot: ComposerSnapshot): boolean {
  return snapshot.text === "" && !snapshot.attachments.length && !snapshot.references.length;
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !(value instanceof Blob) && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function validateJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 128) throw new Error("Document metadata is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("Document metadata must be finite, acyclic JSON");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Document metadata must contain plain JSON values");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) validateJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}

export function validateSnapshot(snapshot: ComposerSnapshot): void {
  if (typeof snapshot.text !== "string" || !Array.isArray(snapshot.attachments) || !Array.isArray(snapshot.references)) {
    throw new Error("Invalid composer snapshot");
  }
  const ids = new Set<string>();
  for (const attachment of snapshot.attachments) {
    if (!attachment.id || ids.has(attachment.id) || !(attachment.data instanceof Blob)) {
      throw new Error("Attachments require unique IDs and durable Blob bytes");
    }
    ids.add(attachment.id);
  }
  if (snapshot.document) {
    if (!snapshot.document.format || !Number.isSafeInteger(snapshot.document.version) || snapshot.document.version < 1) {
      throw new Error("Invalid document format/version");
    }
    validateJson(snapshot.document.value);
    // 有序文档是唯一内容事实。正向规则：文档里的每个附件节点都必须有稳定 NodeId（唯一且非空），
    // 且其 AssetId 能在 snapshot.attachments 里找到。反向不成立：未被文档引用的附件是合法的
    // （rail-only，宿主序列化时追加在文档内容之后）。
    const nodeIds = new Set<string>();
    const referencedAssets = new Set<string>();
    for (const node of documentAttachmentNodes(snapshot.document.value)) {
      if (typeof node.nodeId !== "string" || node.nodeId === "") throw new Error("Document attachment nodes require a stable NodeId");
      if (nodeIds.has(node.nodeId)) throw new Error(`Duplicate document NodeId: ${node.nodeId}`);
      nodeIds.add(node.nodeId);
      if (typeof node.assetId !== "string" || node.assetId === "") throw new Error("Document attachment nodes require an AssetId");
      referencedAssets.add(node.assetId);
    }
    const assetIds = new Set<string>(snapshot.attachments.map((attachment) => attachment.id));
    for (const assetId of referencedAssets) {
      if (!assetIds.has(assetId)) throw new Error(`Document attachment node references a missing asset: ${assetId}`);
    }
  }
  for (const reference of snapshot.references) {
    if (!reference.id || !reference.kind) throw new Error("References need stable IDs and kinds");
    validateJson(reference.value);
  }
  // Enforce structured-clone support before a draft can be cleared.
  copy(snapshot);
}

export function validateState(state: ScopeState, scopeId: string): void {
  if (state.schema !== 1 || state.scopeId !== scopeId || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !state.draft?.generation || !Number.isSafeInteger(state.draft.revision) || state.draft.revision < 0 ||
      !Array.isArray(state.finishedTurns) || !state.finishedTurns.every((turn) => typeof turn === "string" && turn.length > 0) ||
      !Array.isArray(state.submissions) || !(state.activeTurn === null || typeof state.activeTurn === "string")) {
    throw new Error("Unsupported or corrupt composer storage; existing data was not overwritten");
  }
  validateSnapshot(state.draft.snapshot);
  const ids = new Set<string>();
  const statuses = new Set(["queued", "sending", "accepted", "rejected", "unknown", "cancelled"]);
  for (const record of state.submissions) {
    if (!record.id || ids.has(record.id) || record.scopeId !== scopeId || !statuses.has(record.status)) {
      throw new Error("Invalid submission ledger");
    }
    ids.add(record.id);
    validateSnapshot(record.snapshot);
  }
}
