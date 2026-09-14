/**
 * Where the local draft (document + comments + server baseline) is kept.
 *
 * localStorage caps at ~5 MB per origin and throws on overflow — and the
 * baseline can double the footprint — so a multi-megabyte HTML review silently
 * lost its local draft. IndexedDB has no such practical cap. localStorage stays
 * as a fallback for browsers without IndexedDB (or when it fails to open, e.g.
 * some private-browsing modes).
 */
export interface DraftStore {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory'
  get(): Promise<string | null>
  set(value: string): Promise<void>
  remove(): Promise<void>
}

const DB_NAME = 'md-review'
const STORE_NAME = 'drafts'
const RECORD_KEY = 'state'

export function createMemoryStore(): DraftStore {
  let value: string | null = null
  return {
    kind: 'memory',
    async get() { return value },
    async set(v) { value = v },
    async remove() { value = null },
  }
}

export function createLocalStorageStore(key: string): DraftStore {
  return {
    kind: 'localstorage',
    async get() { return localStorage.getItem(key) },
    async set(v) { localStorage.setItem(key, v) },
    async remove() { localStorage.removeItem(key) },
  }
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

export function createIndexedDbStore(): DraftStore {
  let dbPromise: Promise<IDBDatabase> | null = null
  const db = () => (dbPromise ??= openDb())

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const d = await db()
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE_NAME, mode)
      const req = fn(tx.objectStore(STORE_NAME))
      let result: T
      req.onsuccess = () => { result = req.result }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  }

  return {
    kind: 'indexeddb',
    async get() {
      const v = await withStore('readonly', (s) => s.get(RECORD_KEY) as IDBRequest<string | undefined>)
      return typeof v === 'string' ? v : null
    },
    async set(value) { await withStore('readwrite', (s) => s.put(value, RECORD_KEY)) },
    async remove() { await withStore('readwrite', (s) => s.delete(RECORD_KEY)) },
  }
}

/**
 * Pick the best available store. Probes IndexedDB with a real round-trip so a
 * broken implementation degrades to localStorage instead of failing later.
 */
export async function openDraftStore(localStorageKey: string): Promise<DraftStore> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const idb = createIndexedDbStore()
      await idb.get()
      return idb
    } catch {
      // fall through
    }
  }
  try {
    localStorage.getItem(localStorageKey)
    return createLocalStorageStore(localStorageKey)
  } catch {
    return createMemoryStore()
  }
}

export { requestToPromise as _requestToPromise }
