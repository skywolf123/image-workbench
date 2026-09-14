// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeIndexedDB } from './fakeIndexedDb'
import { LEGACY_MIGRATION_FLAG_KEY, LEGACY_STORAGE_NAME, STORAGE_NAME } from './storageNamespace'

const LEGACY_PRIMARY_KEY = LEGACY_STORAGE_NAME
const NEW_PRIMARY_KEY = STORAGE_NAME

function seedLegacyDatabase(fake: ReturnType<typeof createFakeIndexedDB>) {
  const db = fake.createDatabase(LEGACY_STORAGE_NAME)
  const tasks = db.createObjectStore('tasks', { keyPath: 'id' })
  const images = db.createObjectStore('images', { keyPath: 'id' })
  const agentConversations = db.createObjectStore('agentConversations', { keyPath: 'id' })
  tasks.put({ id: 'task-1', prompt: '旧任务' })
  images.put({ id: 'image-1', dataUrl: 'data:image/png;base64,old' })
  agentConversations.put({ id: 'conv-1', title: '旧会话' })
}

async function loadMigration() {
  return await import('./storageMigration')
}

async function runMigration() {
  const fake = createFakeIndexedDB()
  vi.stubGlobal('indexedDB', fake)
  const { ensureStorageNamespaceMigrated } = await loadMigration()
  const result = await ensureStorageNamespaceMigrated()
  return { fake, result }
}

async function readStore(fake: ReturnType<typeof createFakeIndexedDB>, dbName: string, storeName: string) {
  const db = fake.databases.get(dbName)
  if (!db) return null
  const store = db.stores.get(storeName)
  return store ? [...store.rows.values()] : null
}

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('storage namespace migration', () => {
  it('moves tasks, images, conversations and settings to the new namespace', async () => {
    localStorage.setItem(LEGACY_PRIMARY_KEY, JSON.stringify({ state: { settings: {} }, version: 2 }))
    localStorage.setItem(`${LEGACY_STORAGE_NAME}.copy-import-url-options`, '{"useNewApiKey":false}')
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake)
    seedLegacyDatabase(fake)

    const { ensureStorageNamespaceMigrated } = await loadMigration()
    const result = await ensureStorageNamespaceMigrated()

    expect(result.migrated).toBe(true)
    expect(localStorage.getItem(NEW_PRIMARY_KEY)).toBe(JSON.stringify({ state: { settings: {} }, version: 2 }))
    expect(localStorage.getItem(`${STORAGE_NAME}.copy-import-url-options`)).toBe('{"useNewApiKey":false}')
    expect(await readStore(fake, STORAGE_NAME, 'tasks')).toEqual([{ id: 'task-1', prompt: '旧任务' }])
    expect(await readStore(fake, STORAGE_NAME, 'images')).toEqual([{ id: 'image-1', dataUrl: 'data:image/png;base64,old' }])
    expect(await readStore(fake, STORAGE_NAME, 'agentConversations')).toEqual([{ id: 'conv-1', title: '旧会话' }])
  })

  it('removes the legacy naming so the two namespaces never both hold a copy', async () => {
    localStorage.setItem(LEGACY_PRIMARY_KEY, 'legacy-state')
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake)
    seedLegacyDatabase(fake)

    const { ensureStorageNamespaceMigrated } = await loadMigration()
    await ensureStorageNamespaceMigrated()

    expect(localStorage.getItem(LEGACY_PRIMARY_KEY)).toBeNull()
    expect(localStorage.getItem(`${LEGACY_STORAGE_NAME}.copy-import-url-options`)).toBeNull()
    expect(fake.databases.has(LEGACY_STORAGE_NAME)).toBe(false)
    expect(localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY)).toBe('true')
  })

  it('is idempotent and does not duplicate records when run repeatedly', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake)
    seedLegacyDatabase(fake)

    const { ensureStorageNamespaceMigrated } = await loadMigration()
    await ensureStorageNamespaceMigrated()
    const second = await ensureStorageNamespaceMigrated()

    expect(second.migrated).toBe(false)
    expect(await readStore(fake, STORAGE_NAME, 'tasks')).toHaveLength(1)

    // 抹掉标记强制重跑，模拟中途失败后的重试。
    localStorage.removeItem(LEGACY_MIGRATION_FLAG_KEY)
    await ensureStorageNamespaceMigrated()

    expect(await readStore(fake, STORAGE_NAME, 'tasks')).toHaveLength(1)
    expect(await readStore(fake, STORAGE_NAME, 'images')).toHaveLength(1)
  })

  it('keeps the data written after the upgrade when a legacy copy reappears', async () => {
    localStorage.setItem(LEGACY_PRIMARY_KEY, 'stale-legacy-state')
    localStorage.setItem(NEW_PRIMARY_KEY, 'current-state')
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake)
    seedLegacyDatabase(fake)

    const { ensureStorageNamespaceMigrated } = await loadMigration()
    await ensureStorageNamespaceMigrated()

    expect(localStorage.getItem(NEW_PRIMARY_KEY)).toBe('current-state')
  })

  it('does nothing for a user with no legacy data', async () => {
    const { fake, result } = await runMigration()

    expect(result.migrated).toBe(false)
    expect(localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY)).toBe('true')
    expect(fake.databases.has(LEGACY_STORAGE_NAME)).toBe(false)
  })

  it('still opens the new database with the current schema version after migrating', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake)
    seedLegacyDatabase(fake)

    const { ensureStorageNamespaceMigrated } = await loadMigration()
    await ensureStorageNamespaceMigrated()

    const db = await import('./db')
    await db.putTask({ id: 'task-2', prompt: '迁移后的新任务' } as never)
    const tasks = await db.getAllTasks()

    expect(tasks.map((task) => task.id).sort()).toEqual(['task-1', 'task-2'])
    expect(fake.databases.get(STORAGE_NAME)!.stores.has('thumbnails')).toBe(true)
  })
})
