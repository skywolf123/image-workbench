/**
 * 内存版 IndexedDB 替身：本项目只用到 open/deleteDatabase 与对象仓库的
 * getAll / getAllKeys / put / delete / clear。
 *
 * 读写立即生效，回调通过微任务派发；事务的 oncomplete 走宏任务，保证在所有读写
 * 回调之后才触发（真实 IndexedDB 也是这个顺序）。
 */

interface FakeStore {
  keyPath: string
  rows: Map<IDBValidKey, unknown>
}

function defer(task: () => void) {
  queueMicrotask(task)
}

class FakeRequest<T> {
  result!: T
  error: DOMException | null = null
  target: FakeRequest<T> = this
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
  onblocked: (() => void) | null = null
}

class FakeObjectStore {
  constructor(private store: FakeStore) {}

  getAll() {
    const request = new FakeRequest<unknown[]>()
    const result = [...this.store.rows.values()]
    defer(() => {
      request.result = result
      request.onsuccess?.()
    })
    return request
  }

  getAllKeys() {
    const request = new FakeRequest<IDBValidKey[]>()
    const result = [...this.store.rows.keys()]
    defer(() => {
      request.result = result
      request.onsuccess?.()
    })
    return request
  }

  put(row: unknown) {
    const request = new FakeRequest<IDBValidKey>()
    const key = (row as Record<string, IDBValidKey>)[this.store.keyPath]
    this.store.rows.set(key, row)
    defer(() => {
      request.result = key
      request.onsuccess?.()
    })
    return request
  }

  delete(key: IDBValidKey) {
    const request = new FakeRequest<undefined>()
    this.store.rows.delete(key)
    defer(() => request.onsuccess?.())
    return request
  }

  clear() {
    const request = new FakeRequest<undefined>()
    this.store.rows.clear()
    defer(() => request.onsuccess?.())
    return request
  }
}

class FakeDatabase {
  version = 1
  stores = new Map<string, FakeStore>()

  get objectStoreNames() {
    const names = [...this.stores.keys()]
    return {
      length: names.length,
      contains: (name: string) => this.stores.has(name),
      [Symbol.iterator]: () => names[Symbol.iterator](),
    } as unknown as DOMStringList
  }

  createObjectStore(name: string, options: { keyPath?: string } = {}) {
    const store: FakeStore = { keyPath: options.keyPath ?? 'id', rows: new Map() }
    this.stores.set(name, store)
    return new FakeObjectStore(store)
  }

  transaction(storeName: string | string[], _mode?: string) {
    void storeName
    void _mode
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: (name: string) => {
        const store = this.stores.get(name)
        if (!store) throw new Error(`object store 不存在：${name}`)
        return new FakeObjectStore(store)
      },
    }
    setTimeout(() => tx.oncomplete?.(), 0)
    return tx as unknown as IDBTransaction
  }

  close() {}
}

export function createFakeIndexedDB() {
  const databases = new Map<string, FakeDatabase>()

  function createDatabase(name: string, version = 1) {
    const db = new FakeDatabase()
    db.version = version
    databases.set(name, db)
    return db
  }

  return {
    databases,
    createDatabase,
    open(name: string, version?: number) {
      const request = new FakeRequest<FakeDatabase>()
      defer(() => {
        const existing = databases.get(name)
        if (!existing) {
          request.result = createDatabase(name, version ?? 1)
          request.onupgradeneeded?.()
          request.onsuccess?.()
          return
        }
        request.result = existing
        if (version !== undefined && version > existing.version) {
          request.onupgradeneeded?.()
          existing.version = version
        }
        request.onsuccess?.()
      })
      return request as unknown as IDBOpenDBRequest
    },
    deleteDatabase(name: string) {
      const request = new FakeRequest<undefined>()
      databases.delete(name)
      defer(() => request.onsuccess?.())
      return request as unknown as IDBOpenDBRequest
    },
  }
}
