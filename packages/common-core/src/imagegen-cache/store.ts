/**
 * IndexedDB-backed cache for AI image-generation results.
 *
 * Schema:
 *   db: "imagegen-cache" (version 1)
 *   object store: "entries" (keyPath: "id")
 *   indexes:
 *     - "by_source" → CachedGeneration.source
 *     - "by_createdAt" → CachedGeneration.createdAt
 *
 * All public methods auto-open the database.
 */

import type {
  CachedGeneration,
  ListFilter,
  SaveCachedGenerationInput
} from "./types";

const DB_NAME = "imagegen-cache";
const DB_VERSION = 1;
const STORE = "entries";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("by_source", "source", { unique: false });
      store.createIndex("by_createdAt", "createdAt", { unique: false });
    };
  });
  return dbPromise;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        let result: T | undefined;
        const maybe = run(store);
        if (maybe instanceof IDBRequest) {
          maybe.onsuccess = () => {
            result = maybe.result;
          };
          maybe.onerror = () => reject(maybe.error);
        } else {
          maybe.then((v) => {
            result = v;
          });
        }
        transaction.oncomplete = () => resolve(result as T);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

export async function saveEntry(input: SaveCachedGenerationInput): Promise<CachedGeneration> {
  const entry: CachedGeneration = {
    id: input.id ?? uuid(),
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    prompt: input.prompt,
    tags: input.tags,
    inputImageB64: input.inputImageB64 ?? null,
    outputB64: input.outputB64,
    outputMimeType: input.outputMimeType,
    contextJson: input.contextJson ?? null,
    note: input.note
  };
  await tx<void>("readwrite", (store) => {
    store.put(entry);
    return Promise.resolve();
  });
  return entry;
}

export async function getEntry(id: string): Promise<CachedGeneration | null> {
  const result = await tx<CachedGeneration | undefined>("readonly", (store) => store.get(id));
  return result ?? null;
}

export async function listEntries(filter: ListFilter = {}): Promise<CachedGeneration[]> {
  const all = await tx<CachedGeneration[]>("readonly", (store) => {
    if (filter.source !== undefined) {
      const idx = store.index("by_source");
      return idx.getAll(filter.source);
    }
    return store.getAll();
  });
  let entries = all;
  if (filter.tags) {
    const tagsToMatch = filter.tags;
    entries = entries.filter((e) =>
      Object.entries(tagsToMatch).every(([k, v]) => e.tags[k] === v)
    );
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  if (filter.limit !== undefined) entries = entries.slice(0, filter.limit);
  return entries;
}

export async function updateNote(id: string, note: string): Promise<CachedGeneration | null> {
  const existing = await getEntry(id);
  if (!existing) return null;
  const updated: CachedGeneration = { ...existing, note };
  await tx<void>("readwrite", (store) => {
    store.put(updated);
    return Promise.resolve();
  });
  return updated;
}

export async function deleteEntry(id: string): Promise<void> {
  await tx<void>("readwrite", (store) => {
    store.delete(id);
    return Promise.resolve();
  });
}

export async function clearAll(): Promise<void> {
  await tx<void>("readwrite", (store) => {
    store.clear();
    return Promise.resolve();
  });
}
