import type { ComposerSnapshot, ScopeState } from "./types.ts";

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
