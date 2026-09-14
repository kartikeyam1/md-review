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

/** Small per-browser key/value store (same backing as the draft, arbitrary keys). */
export interface KeyValueStore {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory'
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

const DB_NAME = 'md-review'
const STORE_NAME = 'drafts'
const RECORD_KEY = 'state'

function fixedKey(kv: KeyValueStore, key: string): DraftStore {
  return {
    kind: kv.kind,
    get: () => kv.get(key),
    set: (v) => kv.set(key, v),
    remove: () => kv.remove(key),
  }
}

export function createMemoryKeyValueStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    kind: 'memory',
    async get(key) { return map.get(key) ?? null },
    async set(key, v) { map.set(key, v) },
    async remove(key) { map.delete(key) },
  }
}

export function createLocalStorageKeyValueStore(prefix = ''): KeyValueStore {
  return {
    kind: 'localstorage',
    async get(key) { return localStorage.getItem(prefix + key) },
    async set(key, v) { localStorage.setItem(prefix + key, v) },
    async remove(key) { localStorage.removeItem(prefix + key) },
  }
}

export function createMemoryStore(): DraftStore {
  return fixedKey(createMemoryKeyValueStore(), RECORD_KEY)
}

export function createLocalStorageStore(key: string): DraftStore {
  return fixedKey(createLocalStorageKeyValueStore(), key)
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

let sharedDb: Promise<IDBDatabase> | null = null

export function createIndexedDbKeyValueStore(): KeyValueStore {
  const db = () => (sharedDb ??= openDb().catch((e) => { sharedDb = null; throw e }))

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
    async get(key) {
      const v = await withStore('readonly', (s) => s.get(key) as IDBRequest<string | undefined>)
      return typeof v === 'string' ? v : null
    },
    async set(key, value) { await withStore('readwrite', (s) => s.put(value, key)) },
    async remove(key) { await withStore('readwrite', (s) => s.delete(key)) },
  }
}

export function createIndexedDbStore(): DraftStore {
  return fixedKey(createIndexedDbKeyValueStore(), RECORD_KEY)
}

/** Best available key/value store: IndexedDB → localStorage (prefixed) → memory. */
export async function openKeyValueStore(localStoragePrefix = 'md-review-kv:'): Promise<KeyValueStore> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const idb = createIndexedDbKeyValueStore()
      await idb.get('__probe__')
      return idb
    } catch {
      // fall through
    }
  }
  try {
    localStorage.getItem(localStoragePrefix + '__probe__')
    return createLocalStorageKeyValueStore(localStoragePrefix)
  } catch {
    return createMemoryKeyValueStore()
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
