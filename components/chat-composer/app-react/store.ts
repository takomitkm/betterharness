import type { ComposerStore, ScopeState } from "./types.ts";
import { copy } from "./snapshots.ts";

/** For tests and explicitly ephemeral hosts. Production browser code uses IndexedDbComposerStore. */
export class MemoryComposerStore implements ComposerStore {
  private scopes = new Map<string, ScopeState>();
  async read(scopeId: string): Promise<ScopeState | null> {
    return copy(this.scopes.get(scopeId) ?? null);
  }
  async compareAndSwap(scopeId: string, expectedRevision: number | null, next: ScopeState): Promise<boolean> {
    const current = this.scopes.get(scopeId);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.scopes.set(scopeId, copy(next));
    return true;
  }
}

export class IndexedDbComposerStore implements ComposerStore {
  private database: IDBDatabase;
  private constructor(database: IDBDatabase) { this.database = database; }

  static async open(name = "betterharness-composer"): Promise<IndexedDbComposerStore> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("scopes", { keyPath: "scopeId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Cannot open composer storage"));
      request.onblocked = () => reject(new Error("Composer storage upgrade is blocked by another window"));
    });
    database.onversionchange = () => database.close();
    return new IndexedDbComposerStore(database);
  }

  async read(scopeId: string): Promise<ScopeState | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("scopes", "readonly");
      const request = transaction.objectStore("scopes").get(scopeId);
      let result: ScopeState | null = null;
      request.onsuccess = () => { result = request.result ?? null; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Composer read aborted"));
      transaction.onerror = () => { /* onabort owns rejection */ };
    });
  }

  async compareAndSwap(scopeId: string, expectedRevision: number | null, next: ScopeState): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // One transaction owns both the draft and its outbox. Never await between IDB requests.
      const transaction = this.database.transaction("scopes", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("scopes");
      const request = store.get(scopeId);
      let matched = false;
      request.onsuccess = () => {
        if ((request.result?.revision ?? null) !== expectedRevision) return;
        matched = true;
        store.put(next);
      };
      transaction.oncomplete = () => resolve(matched);
      transaction.onabort = () => reject(transaction.error ?? new Error("Composer write aborted"));
      transaction.onerror = () => { /* onabort owns rejection */ };
    });
  }

  close(): void { this.database.close(); }
}
