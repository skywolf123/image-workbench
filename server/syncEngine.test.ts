import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './index.mjs'
import {
  bindSyncSources,
  configureSync,
  configureSyncTiming,
  enqueueImageSync,
  loadSyncMeta,
  queueTaskChange,
  queueTaskDeletion,
  resetSyncForTests,
  purgeSyncMeta,
  getPendingIntentsForTests,
  runSyncNow,
  setSyncBaseUrlForTests,
  type SyncSources,
} from '../src/lib/syncEngine'
import { dataUrlToBytes } from '../src/lib/dataUrl'
import type { StoredImage, TaskRecord } from '../src/types'

// 同步元数据（pending 意图、knownIds）在浏览器里走 IndexedDB，
// 这里用 hoisted 的内存 Map 顶替，并让多个用例之间可以整体清空。
const syncMeta = vi.hoisted(() => ({ map: new Map<string, unknown>() }))

vi.mock('../src/lib/db', () => ({
  getSyncValue: async (key: string) => (syncMeta.map.has(key) ? syncMeta.map.get(key) : null),
  setSyncValue: async (key: string, value: unknown) => {
    syncMeta.map.set(key, value)
  },
  removeSyncValue: async (key: string) => {
    syncMeta.map.delete(key)
  },
}))

const DATA_URL_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const DATA_URL_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let cleanup: string[] = []

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

async function startPlatform() {
  const dist = join(makeTempDir('syncengine-root-'), 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>平台</title>')

  const instance = await createServer({
    host: '127.0.0.1',
    port: 0,
    distDir: dist,
    dataDir: makeTempDir('syncengine-data-'),
    gatewayApiKey: null,
    env: {},
  })
  await instance.listen()
  return { instance, origin: `http://127.0.0.1:${instance.port}` }
}

/** 「另一台设备」：绕过引擎直接对服务端说话，模拟同一成员空间里的第二个客户端。 */
function createSecondDevice(origin: string, memberId: string) {
  const headers = { 'X-Member-Id': memberId, 'Content-Type': 'application/json' }
  return {
    async push(changedTasks: TaskRecord[], deletedTaskIds: string[] = []) {
      const response = await fetch(`${origin}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ changedTasks, deletedTaskIds }),
      })
      return await response.json() as { version: number; tasks: TaskRecord[] }
    },
    async pull() {
      const response = await fetch(`${origin}/api/sync`, { method: 'POST', headers, body: '{}' })
      return await response.json() as { version: number; tasks: TaskRecord[] }
    },
    async trash() {
      const response = await fetch(`${origin}/api/sync/trash`, { headers: { 'X-Member-Id': memberId } })
      return await response.json() as { items: Array<{ id: string }> }
    },
    async restore(taskId: string) {
      await fetch(`${origin}/api/sync/trash/${taskId}/restore`, { method: 'POST', headers: { 'X-Member-Id': memberId } })
    },
    async putImage(id: string, bytes: Uint8Array) {
      await fetch(`${origin}/api/sync/images/${id}`, { method: 'PUT', headers: { 'X-Member-Id': memberId }, body: new Blob([bytes as BlobPart]) })
    },
  }
}

interface DeviceStorage {
  tasks: Map<string, TaskRecord>
  images: Map<string, StoredImage>
  sources: SyncSources
}

/** 用内存 Map 模拟一台设备的本地库：断言的是「数据回到了本地」这一可观察结果。 */
function createDeviceStorage(): DeviceStorage {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  return {
    tasks,
    images,
    sources: {
      getTasks: () => [...tasks.values()],
      async applyTasks(next, removedIds) {
        for (const id of removedIds) tasks.delete(id)
        const nextIds = new Set(next.map((task) => task.id))
        for (const id of [...tasks.keys()]) {
          if (!nextIds.has(id)) tasks.delete(id)
        }
        for (const task of next) tasks.set(task.id, task)
      },
      getImage: async (id) => images.get(id),
      getAllImageIds: async () => [...images.keys()],
      async putImage(id, dataUrl) {
        images.set(id, { id, dataUrl, createdAt: Date.now(), source: 'generated' })
      },
      getLocalFavoriteCollectionIds: () => new Set(['real']),
    },
  }
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    prompt: '一只猫',
    params: {},
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_500,
    elapsed: 500,
    ...overrides,
  }
}

let storage: DeviceStorage

beforeEach(() => {
  cleanup = []
  storage = createDeviceStorage()
  syncMeta.map.clear()
  configureSyncTiming({ retryDelaysMs: [], imageRetryMs: 50, taskDebounceMs: 50, periodicMs: 3_600_000 })
})

afterEach(() => {
  resetSyncForTests()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

async function initEngine(memberId: string, origin: string) {
  setSyncBaseUrlForTests(origin)
  configureSync({ memberId })
  bindSyncSources(storage.sources, storage.sources.getImage)
  await loadSyncMeta()
}

describe('syncEngine 与真实服务端', () => {
  it('本地任务与图片推送上去，第二轮不产生版本号变化（幂等）', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      storage.images.set('img-1', { id: 'img-1', dataUrl: DATA_URL_A, createdAt: 0, source: 'upload' })
      queueTaskChange('task-1')

      const first = await runSyncNow()
      expect(first).not.toBeNull()
      expect(first!.tasks).toBe(1)

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      const seen = await deviceB.pull()
      expect(seen.tasks.map((task) => task.id)).toEqual(['task-1'])

      const versionBefore = seen.version
      const second = await runSyncNow()
      expect(second!.version).toBe(versionBefore)

      const manifest = await fetch(`${platform.origin}/api/sync/manifest`, { headers: { 'X-Member-Id': 'member-a' } })
      expect(((await manifest.json()) as { images: string[] }).images).toContain('img-1')
    } finally {
      await platform.instance.close()
    }
  })

  it('别的设备删除的任务会被本地移除（knownIds 感知删除）', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      await runSyncNow()

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      await deviceB.push([], ['task-1'])

      await runSyncNow()
      expect([...storage.tasks.keys()]).toEqual([])
    } finally {
      await platform.instance.close()
    }
  })

  it('本地删除把任务整条送进服务器回收站，还原后同步回本地', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      await runSyncNow()

      // 本地删除：存储层先删（store 的行为），再入队删除意图。
      storage.tasks.delete('task-1')
      queueTaskDeletion('task-1')
      await runSyncNow()

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      expect((await deviceB.trash()).items.map((item) => item.id)).toEqual(['task-1'])
      expect((await deviceB.pull()).tasks).toHaveLength(0)

      await deviceB.restore('task-1')
      await runSyncNow()
      expect(storage.tasks.get('task-1')?.prompt).toBe('一只猫')
    } finally {
      await platform.instance.close()
    }
  })

  it('两台设备各改各的任务，最终收敛到同一个活跃集', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask({ prompt: '本机的任务' }))
      queueTaskChange('task-1')
      await runSyncNow()

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      await deviceB.push([makeTask({ id: 'task-2', prompt: '另一台的任务' })])

      await runSyncNow()
      expect([...storage.tasks.keys()].sort()).toEqual(['task-1', 'task-2'])

      await deviceB.push([makeTask({ id: 'task-1', prompt: '另一台改过的任务' })])
      await runSyncNow()
      // 任务级 LWW：后推送者覆盖，本机没有未推送的本地变更时采用服务器版。
      expect(storage.tasks.get('task-1')?.prompt).toBe('另一台改过的任务')
    } finally {
      await platform.instance.close()
    }
  })

  it('running 任务不参与同步：推不出去，结束后再推；拉到别台的 running 标记为已中断', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)

      storage.tasks.set('task-1', makeTask({ status: 'running', error: null, finishedAt: null }))
      queueTaskChange('task-1')
      await runSyncNow()

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      expect((await deviceB.pull()).tasks).toHaveLength(0)
      expect(storage.tasks.get('task-1')?.status).toBe('running')

      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      await runSyncNow()
      expect((await deviceB.pull()).tasks).toHaveLength(1)

      // 另一台设备推上来一个 running 任务（服务器不过滤），本机拉下来要标记中断。
      await deviceB.push([makeTask({ id: 'task-2', status: 'running', error: null, finishedAt: null })])
      await runSyncNow()
      const pulled = storage.tasks.get('task-2')
      expect(pulled?.status).toBe('error')
      expect(pulled?.error).toBe('请求中断（已同步）')
    } finally {
      await platform.instance.close()
    }
  })

  it('图片差集自愈：本地缺的从服务器下载，服务器缺的补传', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)

      const serverBytes = dataUrlToBytes(DATA_URL_A).bytes
      await createSecondDevice(platform.origin, 'member-a').putImage('img-server', serverBytes)
      storage.images.set('img-local', { id: 'img-local', dataUrl: DATA_URL_B, createdAt: 0, source: 'upload' })

      await runSyncNow()

      expect(storage.images.get('img-server')?.dataUrl).toContain('data:image/png')
      const manifest = await fetch(`${platform.origin}/api/sync/manifest`, { headers: { 'X-Member-Id': 'member-a' } })
      const { images } = await manifest.json() as { images: string[] }
      expect(images.sort()).toEqual(['img-local', 'img-server'])
    } finally {
      await platform.instance.close()
    }
  })

  it('写库钩子入队的图片会在后台补传', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)

      // 写库钩子只在图片真的落库后触发，这里先落库再入队。
      storage.images.set('img-hook', { id: 'img-hook', dataUrl: DATA_URL_A, createdAt: 0, source: 'upload' })
      enqueueImageSync(storage.images.get('img-hook')!)
      await vi.waitFor(async () => {
        const response = await fetch(`${platform.origin}/api/sync/manifest`, { headers: { 'X-Member-Id': 'member-a' } })
        expect(((await response.json()) as { images: string[] }).images).toContain('img-hook')
      })
    } finally {
      await platform.instance.close()
    }
  })

  it('拉下来的任务摘掉本地不存在的收藏夹 id，且不回推服务器原件', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)

      const deviceB = createSecondDevice(platform.origin, 'member-a')
      await deviceB.push([makeTask({ id: 'task-1', favoriteCollectionIds: ['ghost', 'real'] })])

      await runSyncNow()
      expect(storage.tasks.get('task-1')?.favoriteCollectionIds).toEqual(['real'])

      // 服务器上的原件不受摘除影响；引擎也不会把摘除后的版本推回去。
      const serverTask = (await deviceB.pull()).tasks.find((task) => task.id === 'task-1')
      expect(serverTask?.favoriteCollectionIds).toEqual(['ghost', 'real'])
    } finally {
      await platform.instance.close()
    }
  })

  it('待推送意图持久化：重置内存后还能从存储层读回来', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      storage.tasks.set('task-2', makeTask({ id: 'task-2' }))
      queueTaskDeletion('task-2')

      // 模拟标签页重启：引擎内存清空，持久化的意图重新加载。
      resetSyncForTests()
      syncMeta.map.set('knownTaskIds:member-a', ['task-0'])
      await initEngine('member-a', platform.origin)

      const outcome = await runSyncNow()
      expect(outcome).not.toBeNull()
      // task-1 推上去了；task-2 的删除意图也生效（本地本来就没有它，服务器也没有）。
      const state = await fetch(`${platform.origin}/api/sync`, {
        method: 'POST',
        headers: { 'X-Member-Id': 'member-a', 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await state.json() as { tasks: TaskRecord[] }
      expect(body.tasks.map((task) => task.id)).toEqual(['task-1'])
    } finally {
      await platform.instance.close()
    }
  })

  it('服务端状态丢失时不误删本地任务，并把它们重新灌回服务器', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      await runSyncNow()

      // 模拟服务端 state.json 损坏：文件内容变成半个 JSON，活跃集按空处理。
      const statePath = join(platform.instance.config.dataDir, 'member-a', 'state.json')
      writeFileSync(statePath, '{"version":9,"tasks":')

      await runSyncNow()
      // 版本回退被识别为状态丢失：本地任务一个不删。
      expect(storage.tasks.get('task-1')?.prompt).toBe('一只猫')

      // 自愈：本地任务重新入队，下一轮推上去，服务器重新有数据（读取也恢复正常）。
      await runSyncNow()
      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { tasks: TaskRecord[] }
      expect(state.tasks.map((task) => task.id)).toEqual(['task-1'])
      expect(readFileSync(statePath, 'utf-8')).not.toContain('"version":9')
    } finally {
      await platform.instance.close()
    }
  })

  it('purgeSyncMeta 清掉本机该成员的意图与持久化元数据', async () => {
    const platform = await startPlatform()
    try {
      await initEngine('member-a', platform.origin)
      storage.tasks.set('task-1', makeTask())
      queueTaskChange('task-1')
      queueTaskDeletion('task-2')
      expect(getPendingIntentsForTests().changed.size).toBe(1)

      purgeSyncMeta()
      // 内存立即清空；「清空本机」正是靠这一点保证残留删除意图不会推上服务器。
      expect(getPendingIntentsForTests().changed.size).toBe(0)
      expect(getPendingIntentsForTests().deleted.size).toBe(0)

      // 持久化的键也被移除，重新进入同一成员空间时不会复活旧意图。
      await loadSyncMeta()
      expect(getPendingIntentsForTests().changed.size).toBe(0)
      expect(syncMeta.map.has('pendingIntents:member-a')).toBe(false)
      expect(syncMeta.map.has('knownTaskIds:member-a')).toBe(false)
      expect(syncMeta.map.has('lastVersion:member-a')).toBe(false)
    } finally {
      await platform.instance.close()
    }
  })
})
