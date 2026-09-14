import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformServer } from './index.mjs'
import {
  bindBackupSources,
  configureBackup,
  configureBackupTiming,
  createBackupClient,
  enqueueImageBackup,
  resetBackupForTests,
  runBackupNow,
  runRestore,
  scheduleSnapshotBackup,
  setPendingImageReader,
  sniffImageExtension,
  type BackupSource,
} from '../src/lib/backupSync'
import { bytesToDataUrl, dataUrlToBytes } from '../src/lib/dataUrl'
import type { BackupConfig } from '../src/lib/backupConfig'
import type { AppSettings, StoredImage, TaskRecord } from '../src/types'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../src/lib/apiProfiles'

const DATA_URL_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const DATA_URL_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let cleanup: string[] = []

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

function makeDist() {
  const dist = join(makeTempDir('backup-root-'), 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>平台</title>')
  return dist
}

/** 用内存 Map 替代浏览器存储：断言的是「数据回到了本地」这一可观察结果。 */
function createMemoryStore() {
  const images = new Map<string, StoredImage>()
  const tasks = new Map<string, TaskRecord>()
  return {
    images,
    tasks,
    putImage(id: string, dataUrl: string) {
      images.set(id, { id, dataUrl, createdAt: Date.now(), source: 'generated' })
    },
    putTasks(next: TaskRecord[]) {
      for (const task of next) tasks.set(task.id, task)
    },
  }
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: overrides.profiles ?? [
      createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true, baseUrl: 'https://upstream.invalid/v1', apiKey: 'sneaked-key', model: 'sneaked-model' }),
    ],
  })
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    prompt: '一只猫',
    params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1, transparent_output: false },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

function makeSource(overrides: Partial<BackupSource> = {}): BackupSource {
  return {
    images: [],
    tasks: [],
    settings: makeSettings(),
    params: makeTask().params,
    favoriteCollections: [],
    defaultFavoriteCollectionId: null,
    agentConversations: [],
    ...overrides,
  }
}

async function startPlatform() {
  const instance = await createPlatformServer({
    host: '127.0.0.1',
    port: 0,
    distDir: makeDist(),
    dataDir: makeTempDir('backup-data-'),
    apiUrl: 'https://upstream.invalid/v1',
    apiKey: 'secret',
    env: {},
  })
  await instance.listen()
  return {
    ...instance,
    origin: `http://127.0.0.1:${instance.port}`,
    closeServer: instance.close,
  }
}

function makeConfig(origin: string, memberId = 'member-a'): BackupConfig {
  return { enabled: true, serverUrl: origin, memberId }
}

function readServerState(dataDir: string, memberId: string) {
  const path = join(dataDir, memberId, 'state.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null
}

function bindRestore(local: ReturnType<typeof createMemoryStore>, onPayload: (payload: unknown) => void = () => {}) {
  bindBackupSources({
    provider: () => makeSource(),
    sink: {
      getExistingImageIds: async () => new Set(local.images.keys()),
      putImage: async (id, dataUrl) => local.putImage(id, dataUrl),
      getExistingTaskIds: async () => new Set(local.tasks.keys()),
      putTasks: async (next) => local.putTasks(next),
      applyPayload: async (payload) => onPayload(payload),
    },
  })
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

beforeEach(() => {
  cleanup = []
  resetBackupForTests()
  configureBackupTiming({ retryDelaysMs: [10], pendingRetryMs: 50, snapshotDebounceMs: 20 })
})

afterEach(() => {
  resetBackupForTests()
  configureBackupTiming({ retryDelaysMs: [1_000, 5_000, 15_000], pendingRetryMs: 30_000, snapshotDebounceMs: 3_000 })
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('备份载荷', () => {
  it('把平台级配置从顶层字段与 profiles 数组两处一起剥离', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))

      await runBackupNow(makeSource({ tasks: [makeTask()] }))

      const state = readServerState(platform.config.dataDir, 'member-a')
      const uploaded = JSON.stringify(state)
      expect(uploaded).not.toContain('sneaked-key')
      expect(uploaded).not.toContain('upstream.invalid')
      expect(uploaded).not.toContain('sneaked-model')
      expect(state.data.payload.settings.apiKey).toBe('')
      expect(state.data.payload.settings.profiles[0].apiKey).toBe('')
      expect(state.data.payload.settings.profiles[0].baseUrl).toBe('')
      expect(state.data.tasks).toHaveLength(1)
      // 设置里的平台字段被清空后，用户数据仍然在。
      expect(state.data.payload.params.n).toBe(1)
    } finally {
      await platform.closeServer()
    }
  })

  it('只上传原图，缩略图不出现在服务器上', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))

      await runBackupNow(makeSource({
        images: [{ id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' }],
      }))

      const manifest = await createBackupClient(config).fetchManifest()
      expect(manifest.images).toEqual(['image-a'])
      expect(readdirSync(join(platform.config.dataDir, 'member-a'))).toEqual(expect.arrayContaining(['images', 'state.json']))
      expect(readdirSync(join(platform.config.dataDir, 'member-a'))).not.toContain('thumbnails')
    } finally {
      await platform.closeServer()
    }
  })
})

describe('备份与恢复的完整往返', () => {
  it('写入数据 → 备份 → 清空本地模拟驱逐 → 恢复 → 数据回来了', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        images: [
          { id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' },
          { id: 'image-b', dataUrl: DATA_URL_B, createdAt: 1, source: 'generated' },
        ],
        tasks: [makeTask(), makeTask({ id: 'task-2', prompt: '一只狗' })],
        favoriteCollections: [{ id: 'fav-1', name: '收藏夹', createdAt: 1, updatedAt: 1 }],
      }))

      // 模拟浏览器存储被驱逐：本地什么都没有了。
      const local = createMemoryStore()
      let appliedPayload: Record<string, unknown> | null = null
      bindRestore(local, (payload) => { appliedPayload = payload as Record<string, unknown> })

      const restored = await runRestore()

      expect(restored).toEqual({ images: 2, tasks: 2 })
      expect([...local.images.keys()].sort()).toEqual(['image-a', 'image-b'])
      expect(local.images.get('image-a')!.dataUrl).toBe(DATA_URL_A)
      expect([...local.tasks.keys()].sort()).toEqual(['task-1', 'task-2'])
      expect(appliedPayload).not.toBeNull()
      expect((appliedPayload as unknown as { favoriteCollections: unknown[] }).favoriteCollections).toHaveLength(1)
    } finally {
      await platform.closeServer()
    }
  })

  it('重复执行恢复结果一致、无重复记录', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        images: [{ id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' }],
        tasks: [makeTask()],
      }))

      const local = createMemoryStore()
      bindRestore(local)
      await runRestore()
      await runRestore()

      expect(local.images.size).toBe(1)
      expect(local.tasks.size).toBe(1)
    } finally {
      await platform.closeServer()
    }
  })

  it('不覆盖本地已有的同 id 数据，也不删除本地数据', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        images: [{ id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' }],
        tasks: [makeTask({ prompt: '服务器上的旧提示词' })],
      }))

      const local = createMemoryStore()
      local.putImage('image-a', DATA_URL_B)
      local.putTasks([makeTask({ prompt: '本地较新的提示词' })])
      local.putImage('image-local-only', DATA_URL_B)
      bindRestore(local)

      await runRestore()

      expect(local.images.get('image-a')!.dataUrl).toBe(DATA_URL_B)
      expect(local.tasks.get('task-1')!.prompt).toBe('本地较新的提示词')
      expect(local.images.has('image-local-only')).toBe(true)
    } finally {
      await platform.closeServer()
    }
  })

  it('引用了缺失图片的任务在恢复后仍然写回，不会让画廊空白', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        tasks: [makeTask({ outputImages: ['image-never-uploaded'] })],
      }))

      const local = createMemoryStore()
      bindRestore(local)
      const restored = await runRestore()

      expect(restored).toEqual({ images: 0, tasks: 1 })
      expect(local.tasks.get('task-1')!.outputImages).toEqual(['image-never-uploaded'])
    } finally {
      await platform.closeServer()
    }
  })

  it('备份中运行中的任务恢复后状态为已中断，不会永远转圈', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        tasks: [makeTask({ id: 'task-running', status: 'running', finishedAt: null })],
      }))

      const local = createMemoryStore()
      bindRestore(local)
      await runRestore()

      expect(local.tasks.get('task-running')!.status).toBe('error')
      expect(local.tasks.get('task-running')!.error).toContain('中断')
      expect(local.tasks.get('task-running')!.finishedAt).not.toBeNull()
    } finally {
      await platform.closeServer()
    }
  })

  it('成员之间不串数据', async () => {
    const platform = await startPlatform()
    try {
      const configA = makeConfig(platform.origin, 'member-a')
      configureBackup(configA, createBackupClient(configA))
      await runBackupNow(makeSource({
        images: [{ id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' }],
        tasks: [makeTask()],
      }))

      const configB = makeConfig(platform.origin, 'member-b')
      const otherClient = createBackupClient(configB)
      expect((await otherClient.fetchManifest()).images).toEqual([])

      const local = createMemoryStore()
      bindRestore(local)
      configureBackup(configB, otherClient)

      expect(await runRestore()).toEqual({ images: 0, tasks: 0 })
      expect(local.images.size).toBe(0)
      expect(local.tasks.size).toBe(0)
    } finally {
      await platform.closeServer()
    }
  })

  it('服务器上的数据不因客户端操作而被删除', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      configureBackup(config, createBackupClient(config))
      await runBackupNow(makeSource({
        images: [{ id: 'image-a', dataUrl: DATA_URL_A, createdAt: 1, source: 'generated' }],
      }))

      // 本地删掉图片后再备份一次，服务器上仍应保留。
      await runBackupNow(makeSource({ images: [] }))

      expect((await createBackupClient(config).fetchManifest()).images).toEqual(['image-a'])
      expect(existsSync(join(platform.config.dataDir, 'member-a', 'images', 'im', 'image-a'))).toBe(true)
    } finally {
      await platform.closeServer()
    }
  })
})

describe('自动上传', () => {
  it('图片落库后自动上传，无需用户操作，且已存在的图片被跳过', async () => {
    const platform = await startPlatform()
    try {
      const config = makeConfig(platform.origin)
      const client = createBackupClient(config)
      configureBackup(config, client)
      setPendingImageReader(async (id) => ({ id, dataUrl: DATA_URL_A }))

      enqueueImageBackup({ id: 'image-a', dataUrl: DATA_URL_A })
      expect(await waitFor(async () => (await client.fetchManifest()).images.length === 1)).toBe(true)

      // 第二次入队会被存在性检查挡下，不会产生第二份数据。
      enqueueImageBackup({ id: 'image-a', dataUrl: DATA_URL_A })
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(readdirSync(join(platform.config.dataDir, 'member-a', 'images', 'im'))).toEqual(['image-a'])
    } finally {
      await platform.closeServer()
    }
  })

  it('服务器暂时不可用时重试，恢复后图片最终被备份', async () => {
    const platform = await startPlatform()
    try {
      const brokenConfig = { enabled: true, serverUrl: 'http://127.0.0.1:1', memberId: 'member-a' }
      configureBackup(brokenConfig, createBackupClient(brokenConfig))
      setPendingImageReader(async (id) => ({ id, dataUrl: DATA_URL_A }))
      enqueueImageBackup({ id: 'image-a', dataUrl: DATA_URL_A })
      await new Promise((resolve) => setTimeout(resolve, 50))

      // 服务器恢复可用，重试队列会把之前失败的图片补上。
      const config = makeConfig(platform.origin)
      const client = createBackupClient(config)
      configureBackup(config, client)

      expect(await waitFor(async () => (await client.fetchManifest()).images.length === 1, 2_000)).toBe(true)
    } finally {
      await platform.closeServer()
    }
  })
})

describe('编解码', () => {
  it('data URL 与原始字节往返一致', () => {
    const { bytes } = dataUrlToBytes(DATA_URL_A)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytesToDataUrl(bytes, 'image.png')).toBe(DATA_URL_A)
  })

  it('上传到服务器的是解码后的原始字节而不是 base64 文本', () => {
    const { bytes } = dataUrlToBytes(DATA_URL_A)
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
    expect(new TextDecoder().decode(bytes)).not.toContain('data:image')
  })

  it('按文件头还原 data URL 的图片类型', () => {
    expect(sniffImageExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png')
    expect(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg')
    expect(sniffImageExtension(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe('webp')
  })
})

describe('备份未启用时', () => {
  it('图片落库不产生任何上传请求，应用其余功能不受影响', async () => {
    const platform = await startPlatform()
    try {
      configureBackup({ enabled: false, serverUrl: platform.origin, memberId: 'member-a' })
      enqueueImageBackup({ id: 'image-a', dataUrl: DATA_URL_A })
      scheduleSnapshotBackup()
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect((await createBackupClient(makeConfig(platform.origin)).fetchManifest()).images).toEqual([])
    } finally {
      await platform.closeServer()
    }
  })

  it('缺少成员码或服务器地址时也不上传', async () => {
    const platform = await startPlatform()
    try {
      configureBackup({ enabled: true, serverUrl: platform.origin, memberId: '' })
      enqueueImageBackup({ id: 'image-a', dataUrl: DATA_URL_A })
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect((await createBackupClient(makeConfig(platform.origin)).fetchManifest()).images).toEqual([])
      await expect(runBackupNow(makeSource())).rejects.toThrow('备份未启用')
    } finally {
      await platform.closeServer()
    }
  })
})
