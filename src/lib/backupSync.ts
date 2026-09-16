import type { AgentConversation, AppSettings, FavoriteCollection, StoredImage, TaskParams, TaskRecord } from '../types'
import { bytesToDataUrl, dataUrlToBytes } from './dataUrl'
import { createBackupPayload, dropDanglingAgentImageReferences, dropDanglingImageReferences, dropInterruptedAgentRounds, type BackupPayload, type BackupSnapshot } from './backupPayload'
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
  /** 待上传图片的 id。内容在上传时逐个按 id 取，避免一次性把整库原图读进内存。 */
  images: string[]
  tasks: TaskRecord[]
  settings: AppSettings
  params: TaskParams
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  agentConversations: AgentConversation[]
}

/** 恢复时写回本地的出口，由 store 提供，保证走与正常启动相同的归一化流程。 */
export interface RestoreSink {
  putImage: (id: string, dataUrl: string) => Promise<void>
  /** 清空本地数据：同步是用服务器数据替换本地，所以每次都要先清。 */
  clearLocal: () => Promise<void>
  /** 清空之后，本地实际可用的图片 id（用于摘掉悬空引用）。 */
  getAvailableImageIds: () => Promise<Set<string>>
  /** 一次交回全部任务：既落库，也让内存里的任务列表立刻可见。 */
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

let baseUrlOverride: string | null = null

/** 只供测试：把客户端指向临时起的服务端（浏览器里没有 window 时无法推断地址）。 */
export function setBackupBaseUrlForTests(url: string | null) {
  baseUrlOverride = url
}

/**
 * 备份服务的地址：即当前站点。
 *
 * 由部署决定，不是用户设置项——应用与备份服务是同一个 Node 进程、同一端口，
 * 所以同源是必然的，界面上就不该有「服务器地址」这个输入框。
 */
export function resolveBackupBaseUrl() {
  if (baseUrlOverride !== null) return baseUrlOverride
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** 只判断某个成员码在服务器上有没有记录，不拉取任何内容。 */
export async function memberExistsOnServer(config: BackupConfig, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!config.memberId) return false
  const client = createBackupClient(config, fetchImpl)
  const manifest = await withRetry(() => client.fetchManifest())
  return manifest.images.length > 0 || manifest.state !== null
}

/**
 * 探测这个地址上有没有服务端。
 *
 * 决定「要不要显示成员码与同步」：纯静态部署（GitHub Pages / Vercel / Cloudflare）下
 * 这个请求会 404 或失败，备份那一整套 UI 就不该出现。所以要一个专门且**便宜**的端点：
 * 不校验成员码、不读磁盘，只看这个进程在不在。
 *
 * 带超时：地址填错时不该让界面干等浏览器的默认超时。
 */
export async function probeBackupServer(fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<boolean> {
  const base = resolveBackupBaseUrl()
  if (!base) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/api/backup/ping`, { method: 'GET', signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json() as { ok?: boolean }
    return body?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createBackupClient(config: BackupConfig, fetchImpl: typeof fetch = fetch): BackupClient {
  const base = resolveBackupBaseUrl()
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
let snapshotProvider: (() => BackupSource | Promise<BackupSource>) | null = null
let restoreSink: RestoreSink | null = null
const pendingImageIds = new Set<string>()
let draining = false
let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null
let snapshotTimer: ReturnType<typeof setTimeout> | null = null

export function configureBackup(next: BackupConfig, nextClient?: BackupClient) {
  config = next
  client = nextClient ?? (next.memberId ? createBackupClient(next) : null)
}

/** 填了成员码备份就生效；服务器地址由部署决定，不是用户的前置条件。 */
export function isBackupActive() {
  return Boolean(config?.memberId && client)
}

export function bindBackupSources(sources: {
  provider: () => Promise<BackupSource> | BackupSource
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
    const source = image?.id === id ? image : await readImageForBackup(id)
    if (!source) return false
    await withRetry(() => client!.uploadImage(id, dataUrlToBytes(source.dataUrl).bytes))
    setStatus({ error: null })
    return true
  } catch (error) {
    setStatus({ error: `图片 ${id.slice(0, 8)} 备份失败：${describeError(error)}` })
    return false
  }
}

let imageReader: ((id: string) => Promise<StoredImage | undefined>) | null = null

/**
 * 接线层注入的图片读取实现。
 *
 * 全量备份按 id 逐张取图，而不是把整库原图一次性读进内存：4K 图片每张几 MB，
 * 几百张就足以让标签页崩掉。
 */
export function setBackupImageReader(reader: (id: string) => Promise<StoredImage | undefined>) {
  imageReader = reader
}

function readImageForBackup(id: string) {
  return imageReader ? imageReader(id) : Promise.resolve(undefined)
}

// ===== 全量备份 =====

export interface BackupOutcome {
  images: number
  version: number
}

/** 本地数据源尚未接线时返回 null，调用方报明确错误而不是静默不备份。 */
async function readBackupSource(): Promise<BackupSource | null> {
  return snapshotProvider ? await snapshotProvider() : null
}

export async function runBackupNow(source?: BackupSource): Promise<BackupOutcome> {
  if (!isBackupActive() || !client) {
    throw new Error('备份未启用，请先在备份标签页配置服务器地址与成员码。')
  }
  const data = source ?? await readBackupSource()
  if (!data) throw new Error('备份数据源尚未就绪。')

  setStatus({ running: true, error: null, message: '正在读取本地数据…', done: 0, total: data.images.length })
  try {
    let done = 0
    for (const id of data.images) {
      // 已存在的图片跳过，不重复上传。
      await uploadOneImage(id, await readImageForBackup(id))
      done++
      setStatus({ done })
    }

    const payload = createBackupPayload(data.settings, {
      params: data.params,
      favoriteCollections: data.favoriteCollections,
      defaultFavoriteCollectionId: data.defaultFavoriteCollectionId,
      // 上传前把运行中的轮次收尾：它们出了这台浏览器就是死的，
      // 与其把一个会永远转圈的状态存进备份，不如存成已中断。
      agentConversations: dropInterruptedAgentRounds(
        getPersistableAgentConversations(data.agentConversations),
      ),
    })
    const manifest = await withRetry(() => client!.fetchManifest())
    const version = await withRetry(() => client!.uploadSnapshot(
      {
        // 本地也可能存在悬空引用（图片被清理过），上传前按实际存在的图片过滤一遍，
        // 免得把一个渲染不出内容的空任务备份上去。
        tasks: dropDanglingImageReferences(data.tasks, new Set(data.images)),
        payload,
      },
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

/**
 * 从服务器同步回本地。
 *
 * **同步只有这一条语义：用服务器上的数据替换本地。** 本地未备份的内容会丢失。
 *
 * 实现上先按服务器清单把所有图片下载到内存，全部成功后才清空本地再灌入，
 * 所以中途失败（网络断了、服务器挂了）不会把本地清成半截状态。
 */
export interface RestoreOutcome {
  images: number
  tasks: number
}

/**
 * 从服务器同步回本地。
 *
 * **同步只有这一条语义：用服务器上的数据替换本地。** 本地未备份的内容会丢失。
 *
 * 实现上先按服务器清单把所有图片下载到内存，全部成功后才清空本地再灌入，
 * 所以中途失败（网络断了、服务器挂了）不会把本地清成半截状态。
 */
export async function runRestore(): Promise<RestoreOutcome> {
  if (!isBackupActive() || !client || !restoreSink) {
    throw new Error('备份未启用，请先在备份标签页配置服务器地址与成员码。')
  }
  const sink = restoreSink
  // 拉取期间先在内存里攒着，全部下载成功后再动本地——中途失败不会把本地清成半截状态。
  const downloadedImages: Array<{ id: string; dataUrl: string }> = []

  setStatus({ running: true, error: null, message: '正在读取服务器备份清单…', done: 0, total: 0 })
  try {
    const manifest = await withRetry(() => client!.fetchManifest())
    setStatus({ total: manifest.images.length, message: `正在下载 ${manifest.images.length} 张图片…` })

    let images = 0
    for (const id of manifest.images) {
      const dataUrl = await withRetry(() => client!.downloadImage(id))
      if (dataUrl) downloadedImages.push({ id, dataUrl })
      images++
      setStatus({ done: images })
    }

    const snapshot = await withRetry(() => client!.downloadSnapshot())
    const now = Date.now()
    // 运行中的任务其队列/回调标识在恢复后已失效，必须标记为已中断，否则界面会一直转圈。
    const restoredTasks = (snapshot?.tasks ?? []).map((task) => task.status === 'running'
      ? { ...task, ...createTaskErrorPatch(task, '请求中断（已同步）', now), falRecoverable: false, customRecoverable: false }
      : task)

    setStatus({ message: '正在用服务器数据替换本地…' })
    await sink.clearLocal()

    for (const image of downloadedImages) await sink.putImage(image.id, image.dataUrl)

    let tasks = 0
    const availableImageIds = snapshot
      ? await sink.getAvailableImageIds()
      : new Set<string>()
    let restoredConversations = snapshot?.payload.agentConversations ?? []
    if (snapshot) {
      // 一致性处理：摘掉指向不存在图片的引用，避免同步后出现渲染不出内容的空任务。
      const syncedTasks = dropDanglingImageReferences(restoredTasks, availableImageIds)
      await sink.putTasks(syncedTasks)
      tasks = syncedTasks.length
      restoredConversations = dropDanglingAgentImageReferences(restoredConversations, availableImageIds)
      setStatus({ message: '正在同步设置与会话…' })
      // 状态数据走与正常启动相同的归一化流程，避免旧版本备份把应用弄坏。
      await sink.applyPayload({ ...snapshot.payload, agentConversations: restoredConversations })
    }

    setStatus({
      running: false,
      error: null,
      message: `同步完成：${images} 张图片、${tasks} 个任务`,
      lastSuccessAt: Date.now(),
    })
    return { images, tasks }
  } catch (error) {
    const message = `同步失败：${describeError(error)}`
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
  imageReader = null
  notify = null
  status = { running: false, total: 0, done: 0, lastSuccessAt: null, error: null, message: null }
}
