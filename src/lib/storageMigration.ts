import { createObjectStores } from './db'
import { LEGACY_MIGRATION_FLAG_KEY, LEGACY_STORAGE_NAME, STORAGE_NAME } from './storageNamespace'

export interface MigrationResult {
  /** 旧命名下确实存在数据并被搬运过来。 */
  migrated: boolean
}

/**
 * 把旧命名（上游原版 `gpt-image-playground`）下的数据搬到本项目的命名空间。
 *
 * localStorage 必须同步完成，且早于 zustand persist 读取，所以本函数在 store 模块加载时
 * 就被调用。整个流程是幂等的：先搬 localStorage，再搬 IndexedDB，最后写标记；中途失败
 * 不写标记，下次启动整体重试，重复执行不会产生重复数据。
 */
export function ensureStorageNamespaceMigrated(): Promise<MigrationResult> {
  if (hasMigrationFlag()) return Promise.resolve({ migrated: false })

  const localStateMigrated = migrateLocalStorage()
  return migrateIndexedDb()
    .then((dbMigrated) => {
      setMigrationFlag()
      return { migrated: localStateMigrated || dbMigrated }
    })
    .catch((error) => {
      console.warn('[storage] 旧命名数据迁移失败，下次启动会重试：', error)
      return { migrated: false }
    })
}

function hasMigrationFlag(): boolean {
  try {
    return localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY) !== null
  } catch {
    return false
  }
}

function setMigrationFlag() {
  try {
    localStorage.setItem(LEGACY_MIGRATION_FLAG_KEY, 'true')
  } catch {
    // localStorage 不可用时忽略，下次启动重跑迁移仍是幂等的。
  }
}

/** 把 `gpt-image-playground*` 下的 localStorage 条目搬到 `image-workbench*`。 */
function migrateLocalStorage(): boolean {
  let storage: Storage
  try {
    storage = localStorage
  } catch {
    return false
  }

  let migrated = false
  for (const key of listStorageKeys(storage)) {
    const suffix = legacyKeySuffix(key)
    if (suffix === null) continue

    const targetKey = suffix ? `${STORAGE_NAME}.${suffix}` : STORAGE_NAME
    const value = storage.getItem(key)
    // 新命名已有数据时不覆盖，避免把用户升级后的修改回退掉。
    if (value !== null && storage.getItem(targetKey) === null) {
      storage.setItem(targetKey, value)
      migrated = true
    }
    storage.removeItem(key)
  }
  return migrated
}

function listStorageKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

function legacyKeySuffix(key: string): string | null {
  if (key === LEGACY_STORAGE_NAME) return ''
  const prefix = `${LEGACY_STORAGE_NAME}.`
  return key.startsWith(prefix) ? key.slice(prefix.length) : null
}

function migrateIndexedDb(): Promise<boolean> {
  return probeLegacyDatabase().then((legacyDb) => {
    if (!legacyDb) return false

    const storeNames = [...legacyDb.objectStoreNames]
    return copyObjectStores(legacyDb, storeNames).then(() => {
      legacyDb.close()
      removeLegacyDatabase()
      return true
    }, (error) => {
      legacyDb.close()
      throw error
    })
  })
}

/**
 * 无版本打开旧库以探测其存在。旧库不存在时会触发 onupgradeneeded 建出一个空库，
 * 这种情况下把它删掉，避免给新用户留下无意义的残留。
 */
function probeLegacyDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    const request = indexedDB.open(LEGACY_STORAGE_NAME)
    let createdByProbe = false
    request.onupgradeneeded = () => {
      createdByProbe = true
    }
    request.onblocked = () => reject(new Error('旧数据库被其他页面占用'))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      if (db.objectStoreNames.length === 0) {
        db.close()
        if (createdByProbe) removeLegacyDatabase()
        resolve(null)
        return
      }
      resolve(db)
    }
  })
}

async function copyObjectStores(legacyDb: IDBDatabase, storeNames: string[]) {
  const targetDb = await openTargetDb()
  try {
    for (const storeName of storeNames) {
      // 目标库没有的对象仓库直接跳过，避免为一个上游已废弃的仓库让整次迁移失败。
      if (!targetDb.objectStoreNames.contains(storeName)) continue
      const rows = await readAllRows(legacyDb, storeName)
      if (rows.length === 0) continue
      // 只补缺失：目标库里已有的同 id 记录保持不动，重复执行无害。
      const existingKeys = new Set(await readAllKeys(targetDb, storeName))
      const missing = rows.filter((row) => !isRecord(row) || !existingKeys.has(row.id as IDBValidKey))
      if (missing.length > 0) await writeRows(targetDb, storeName, missing)
    }
  } finally {
    targetDb.close()
  }
}

function removeLegacyDatabase() {
  try {
    indexedDB.deleteDatabase(LEGACY_STORAGE_NAME)
  } catch (error) {
    console.warn('[storage] 旧数据库清理失败：', error)
  }
}

function openTargetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_NAME)
    request.onupgradeneeded = () => createObjectStores(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readAllRows(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as unknown[])
    request.onerror = () => reject(request.error)
  })
}

function readAllKeys(db: IDBDatabase, storeName: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function writeRows(db: IDBDatabase, storeName: string, rows: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const row of rows) store.put(row)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
