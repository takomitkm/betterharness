// Web Host 持久化适配（PRODUCT-LINE-PLAN Phase 3）：Persist Effect → IndexedDB CAS。
// 存的是 Rust ScopeState 的 JSON（composer-bridge-wasm 构造恢复的同形状）——
// Blob 字节仍留 JS 侧（asset-inventory §4.1），这里只负责状态事实（Session Events 载体）。

export interface StatePersist {
  /** 恢复：返回持久化的 ScopeState JSON；无记录返回 null。 */
  load(scope: string): Promise<string | null>;
  /** 原子 CAS：expectedRevision 相符才写入（revision = expected + 1）。 */
  cas(scope: string, expectedRevision: number, stateJson: string): Promise<boolean>;
}

export async function openIdbStateStore(database: string): Promise<StatePersist> {
  const request = indexedDB.open(database, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('scopes', { keyPath: 'scope' });
  };
  const database_handle = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const get = (scope: string): Promise<{ scope: string; revision: number; state: string } | undefined> =>
    new Promise((resolve, reject) => {
      const transaction = database_handle.transaction('scopes', 'readonly');
      const found = transaction.objectStore('scopes').get(scope);
      found.onsuccess = () => resolve(found.result);
      found.onerror = () => reject(found.error);
    });

  return {
    async load(scope) {
      const record = await get(scope);
      return record?.state ?? null;
    },
    async cas(scope, expectedRevision, stateJson) {
      return new Promise((resolve, reject) => {
        const transaction = database_handle.transaction('scopes', 'readwrite');
        const store = transaction.objectStore('scopes');
        const found = store.get(scope);
        found.onsuccess = () => {
          const current = found.result;
          const currentRevision = current?.revision ?? 0;
          if (currentRevision !== expectedRevision) {
            resolve(false);
            return;
          }
          store.put({ scope, revision: expectedRevision + 1, state: stateJson });
          resolve(true);
        };
        found.onerror = () => reject(found.error);
        transaction.onabort = () => resolve(false);
      });
    },
  };
}
