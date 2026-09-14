import type { AgentConversation, AppSettings, FavoriteCollection, StoredImage, TaskParams, TaskRecord } from '../types'
import { bytesToDataUrl, dataUrlToBytes } from './dataUrl'
import { createBackupPayload, type BackupPayload, type BackupSnapshot } from './backupPayload'
import type { BackupConfig } from './backupConfig'
import { getPersistableAgentConversations } from './agentResponseState'
import { createTaskErrorPatch } from './taskState'

export type { BackupPayload, BackupSnapshot }

/** 备份进度的对外形态，供设置面板渲染。 */
export interface BackupStatus {
  running: boolean
  total: number
  done: number
  lastSuccessAt: number | null
  error: string | null
  message: string | null
}

/** 一次备份所需的全部本地数据。 */
export interface BackupSource {
  images: StoredImage[]
  tasks: TaskRecord[]
  settings: AppSettings
  params: TaskParams
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  agentConversations: AgentConversation[]
}

/** 恢复时写回本地的出口，由 store 提供，保证走与正常启动相同的归一化流程。 */
export interface RestoreSink {
  getExistingImageIds: () => Promise<Set<string>>
  putImage: (id: string, dataUrl: string) => Promise<void>
  getExistingTaskIds: () => Promise<Set<string>>
  /** 一次交回全部缺失任务：既落库，也让内存里的任务列表立刻可见。 */
  putTasks: (tasks: TaskRecord[]) => Promise<void>
  applyPayload: (payload: BackupPayload) => Promise<void>
}

type StatusListener = (status: BackupStatus) => void

/** 重试、去抖等都是需要调优的关键参数，测试里会调小以免拖慢用例。 */
const DEFAULT_TIMING = {
  retryDelaysMs: [1_000, 5_000, 15_000],
  pendingRetryMs: 30_000,
  snapshotDebounceMs: 3_000,
}

let timing = { ...DEFAULT_TIMING }

/** 只供测试调整节奏，生产路径保持默认值。 */
export function configureBackupTiming(next: Partial<typeof DEFAULT_TIMING>) {
  timing = { ...timing, ...next }
}

const UPLOAD_CONCURRENCY = 3

let status: BackupStatus = {
  running: false,
  total: 0,
  done: 0,
  lastSuccessAt: null,
  error: null,
  message: null,
}

const listeners = new Set<StatusListener>()

export function subscribeBackupStatus(listener: StatusListener) {
  listeners.add(listener)
  listener(status)
  return () => {
    listeners.delete(listener)
  }
}

export function getBackupStatus() {
  return status
}

/**
 * 失败原因不该只在设置面板里可见，所以给调用方一个提示出口。
 *
 * 本模块刻意不引用 store（它会被服务端测试直接加载），提示由接线层注入。
 */
let notify: ((message: string, type: 'info' | 'success' | 'error') => void) | null = null

export function setBackupNotifier(next: typeof notify) {
  notify = next
}

function setStatus(patch: Partial<BackupStatus>) {
  status = { ...status, ...patch }
  for (const listener of listeners) listener(status)
}

function describeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || '未知错误'
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 退避重试：网络或服务器暂时不可用时不该让某张图永久没有备份。 */
async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= timing.retryDelaysMs.length; attempt++) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt === timing.retryDelaysMs.length) break
      await delay(timing.retryDelaysMs[attempt])
    }
  }
  throw lastError
}

// ===== 服务器客户端 =====

export interface BackupManifest {
  images: string[]
  state: { version: number; updatedAt: number } | null
}

export interface BackupClient {
  fetchManifest(): Promise<BackupManifest>
  hasImage(id: string): Promise<boolean>
  downloadImage(id: string): Promise<string | null>
  uploadImage(id: string, bytes: Uint8Array): Promise<void>
  downloadSnapshot(): Promise<BackupSnapshot | null>
  uploadSnapshot(snapshot: BackupSnapshot, expectedVersion: number | null): Promise<number>
}

export function createBackupClient(config: BackupConfig, fetchImpl: typeof fetch = fetch): BackupClient {
  const base = config.serverUrl.replace(/\/+$/, '')
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持备份所需的网络请求接口。')

  async function request(path: string, init: RequestInit = {}) {
    return await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'X-Member-Id': config.memberId, ...init.headers },
    })
  }

  async function expectOk(response: Response, fallback: string) {
    if (response.ok) return
    let detail = ''
    try {
      const body = await response.json() as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {
      // 非 JSON 响应体时用默认提示。
    }
    throw new Error(detail || `${fallback}（HTTP ${response.status}）`)
  }

  return {
    async fetchManifest() {
      const response = await request('/api/backup/manifest')
      await expectOk(response, '无法读取服务器上的备份清单')
      const body = await response.json() as BackupManifest
      return { images: body.images ?? [], state: body.state ?? null }
    },

    async hasImage(id) {
      const response = await request(`/api/backup/images/${encodeURIComponent(id)}`, { method: 'HEAD' })
      if (response.status === 404) return false
      await expectOk(response, '无法检查图片是否已备份')
      return true
    },

    async downloadImage(id) {
      const response = await request(`/api/backup/images/${encodeURIComponent(id)}`)
      if (response.status === 404) return null
      await expectOk(response, '图片下载失败')
      // 服务器只存原始字节，data URL 的类型在客户端按文件头还原。
      const bytes = new Uint8Array(await response.arrayBuffer())
      return bytesToDataUrl(bytes, `image.${sniffImageExtension(bytes)}`)
    },

    async uploadImage(id, bytes) {
      const response = await request(`/api/backup/images/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        // 服务器存的是解码后的原始字节，用 Blob 包裹以满足 BodyInit 的类型要求。
        body: new Blob([bytes as BlobPart]),
      })
      await expectOk(response, '图片上传失败')
    },

    async downloadSnapshot() {
      const response = await request('/api/backup/state')
      if (response.status === 404) return null
      await expectOk(response, '状态快照下载失败')
      const body = await response.json() as { data?: BackupSnapshot }
      return body.data ?? null
    },

    async uploadSnapshot(snapshot, expectedVersion) {
      const response = await request('/api/backup/state', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(expectedVersion === null ? {} : { 'If-Match': String(expectedVersion) }),
        },
        body: JSON.stringify({ data: snapshot }),
      })
      await expectOk(response, '状态快照上传失败')
      const body = await response.json() as { version?: number }
      return body.version ?? 0
    },
  }
}

// ===== 编解码 =====

/**
 * 从文件头判断图片格式后缀。
 *
 * 服务器是只存字节的哑巴仓库，不记 MIME（也就不需要为它维护一份旁路元数据），
 * 而 data URL 又必须带上正确的类型才能被浏览器解码，所以在客户端按魔数还原。
 */
export function sniffImageExtension(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp'
  return 'png'
}

// ===== 运行时接线 =====

let config: BackupConfig | null = null
let client: BackupClient | null = null
let snapshotProvider: (() => BackupSource) | null = null
let restoreSink: RestoreSink | null = null
const pendingImageIds = new Set<string>()
let draining = false
let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null
let snapshotTimer: ReturnType<typeof setTimeout> | null = null

export function configureBackup(next: BackupConfig, nextClient?: BackupClient) {
  config = next
  client = nextClient ?? (next.serverUrl && next.memberId ? createBackupClient(next) : null)
}

/** 只有开关打开、服务器地址与成员码都填了，备份才真正工作。 */
export function isBackupActive() {
  return Boolean(config?.enabled && config.serverUrl && config.memberId && client)
}

export function bindBackupSources(sources: {
  provider: () => BackupSource
  sink: RestoreSink
}) {
  snapshotProvider = sources.provider
  restoreSink = sources.sink
}

// ===== 自动上传 =====

/**
 * 图片写入的统一入口回调。
 *
 * 上传在后台排队进行，不阻塞调用方继续生成；服务器上已存在的图片会被跳过。
 */
export function enqueueImageBackup(image: StoredImage) {
  if (!isBackupActive()) return
  pendingImageIds.add(image.id)
  void drainImageQueue()
}

/** 任务、设置与会话的变化用整份快照推上去，做适度去抖，避免每次击键都上传。 */
export function scheduleSnapshotBackup() {
  if (!isBackupActive() || !snapshotProvider) return
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    void runBackupNow().catch(() => {})
  }, timing.snapshotDebounceMs)
}

async function drainImageQueue() {
  if (draining || !client) return
  draining = true
  try {
    while (pendingImageIds.size > 0) {
      const batch = [...pendingImageIds].slice(0, UPLOAD_CONCURRENCY)
      for (const id of batch) pendingImageIds.delete(id)
      const results = await Promise.all(batch.map((id) => uploadOneImage(id)))
      // 失败的图片放回队列，稍后整体重试一次，避免某张图永久没有备份。
      for (const [index, ok] of results.entries()) {
        if (!ok) pendingImageIds.add(batch[index])
      }
      if (results.some((ok) => !ok)) break
    }
  } finally {
    draining = false
    schedulePendingRetry()
  }
}

function schedulePendingRetry() {
  if (pendingRetryTimer || pendingImageIds.size === 0 || !isBackupActive()) return
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null
    void drainImageQueue()
  }, timing.pendingRetryMs)
}

async function uploadOneImage(id: string, image?: StoredImage) {
  try {
    if (await client!.hasImage(id)) return true
    const source = image?.id === id ? image : await readPendingImage(id)
    if (!source) return false
    await withRetry(() => client!.uploadImage(id, dataUrlToBytes(source.dataUrl).bytes))
    setStatus({ error: null })
    return true
  } catch (error) {
    setStatus({ error: `图片 ${id.slice(0, 8)} 备份失败：${describeError(error)}` })
    return false
  }
}

let pendingImageReader: ((id: string) => Promise<StoredImage | undefined>) | null = null

/** 自动上传时只有 id，需要回本地存储取出图片内容。 */
export function setPendingImageReader(reader: (id: string) => Promise<StoredImage | undefined>) {
  pendingImageReader = reader
}

async function readPendingImage(id: string) {
  return pendingImageReader ? await pendingImageReader(id) : undefined
}

// ===== 全量备份 =====

export interface BackupOutcome {
  images: number
  version: number
}

export async function runBackupNow(source?: BackupSource): Promise<BackupOutcome> {
  if (!isBackupActive() || !client) {
    throw new Error('备份未启用，请先在备份标签页配置服务器地址与成员码。')
  }
  const data = source ?? snapshotProvider?.()
  if (!data) throw new Error('备份数据源尚未就绪。')

  setStatus({ running: true, error: null, message: '正在读取本地数据…', done: 0, total: data.images.length })
  try {
    let done = 0
    for (const image of data.images) {
      // 已存在的图片跳过，不重复上传。
      await uploadOneImage(image.id, image)
      done++
      setStatus({ done })
    }

    const payload = createBackupPayload(data.settings, {
      params: data.params,
      favoriteCollections: data.favoriteCollections,
      defaultFavoriteCollectionId: data.defaultFavoriteCollectionId,
      agentConversations: getPersistableAgentConversations(data.agentConversations),
    })
    const manifest = await withRetry(() => client!.fetchManifest())
    const version = await withRetry(() => client!.uploadSnapshot(
      { tasks: data.tasks, payload },
      manifest.state?.version ?? null,
    ))

    setStatus({
      running: false,
      message: `备份完成（快照版本 ${version}）`,
      lastSuccessAt: Date.now(),
      error: null,
    })
    return { images: done, version }
  } catch (error) {
    const message = `备份失败：${describeError(error)}`
    setStatus({ running: false, message: null, error: message })
    // 不可恢复的错误不能静默失败，调用方（接线层）负责把它变成用户可见的提示。
    notify?.(message, 'error')
    throw error
  }
}

// ===== 恢复 =====

export interface RestoreOutcome {
  images: number
  tasks: number
}

/**
 * 从服务器同步回本地。
 *
 * 语义是**只补缺失、永不覆盖或删除本地已有数据**：图片 id 由内容决定，所以「填缺」
 * 天然幂等，重复执行完全无害。
 */
export async function runRestore(): Promise<RestoreOutcome> {
  if (!isBackupActive() || !client || !restoreSink) {
    throw new Error('备份未启用，请先在备份标签页配置服务器地址与成员码。')
  }
  const sink = restoreSink

  setStatus({ running: true, error: null, message: '正在读取服务器备份清单…', done: 0, total: 0 })
  try {
    const manifest = await withRetry(() => client!.fetchManifest())
    const existingImageIds = await sink.getExistingImageIds()
    const missingImageIds = manifest.images.filter((id) => !existingImageIds.has(id))
    setStatus({ total: missingImageIds.length, message: `正在恢复 ${missingImageIds.length} 张图片…` })

    let images = 0
    for (const id of missingImageIds) {
      const dataUrl = await withRetry(() => client!.downloadImage(id))
      if (dataUrl) await sink.putImage(id, dataUrl)
      images++
      setStatus({ done: images })
    }

    let tasks = 0
    const snapshot = await withRetry(() => client!.downloadSnapshot())
    if (snapshot) {
      const existingTaskIds = await sink.getExistingTaskIds()
      const now = Date.now()
      // 运行中的任务其队列/回调标识在恢复后已失效，必须标记为已中断，否则界面会一直转圈。
      const missingTasks = (snapshot.tasks ?? [])
        .filter((task) => !existingTaskIds.has(task.id))
        .map((task) => task.status === 'running'
          ? { ...task, ...createTaskErrorPatch(task, '请求中断（已从备份恢复）', now), falRecoverable: false, customRecoverable: false }
          : task)
      await sink.putTasks(missingTasks)
      tasks = missingTasks.length
      setStatus({ message: '正在恢复设置与会话…' })
      // 状态数据走与正常启动相同的归一化流程，避免旧版本备份把应用弄坏。
      await sink.applyPayload(snapshot.payload)
    }

    setStatus({
      running: false,
      error: null,
      message: `恢复完成：${images} 张图片、${tasks} 个任务`,
      lastSuccessAt: Date.now(),
    })
    return { images, tasks }
  } catch (error) {
    const message = `恢复失败：${describeError(error)}`
    setStatus({ running: false, message: null, error: message })
    notify?.(message, 'error')
    throw error
  }
}

/** 仅供测试重置模块级状态。 */
export function resetBackupForTests() {
  if (pendingRetryTimer) clearTimeout(pendingRetryTimer)
  if (snapshotTimer) clearTimeout(snapshotTimer)
  pendingRetryTimer = null
  snapshotTimer = null
  pendingImageIds.clear()
  draining = false
  config = null
  client = null
  snapshotProvider = null
  restoreSink = null
  pendingImageReader = null
  notify = null
  status = { running: false, total: 0, done: 0, lastSuccessAt: null, error: null, message: null }
}
