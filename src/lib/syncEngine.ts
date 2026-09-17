import type { StoredImage, TaskRecord } from '../types'
import { bytesToDataUrl, dataUrlToBytes } from './dataUrl'
import { getSyncValue, removeSyncValue, setSyncValue } from './db'
import { createTaskErrorPatch } from './taskState'

/**
 * 多设备同步引擎。
 *
 * 服务端是活跃数据集（任务 + 图片）的权威：客户端把变更意图（改动的任务、删除的任务
 * id）推给 `POST /api/sync`，服务器合并后返回全量活跃集，客户端用它更新本地。
 *
 * 删除传播不靠服务端墓碑：客户端持久化两层状态——
 * - pending 意图（改了什么、删了什么）：删过的任务如果只存在内存里，关标签页就会复活；
 * - knownIds（上次同步响应里的活跃 id 集）：曾见过、现在没了 → 另一台设备删了它。
 *
 * 同步范围只有任务与图片；会话、收藏夹、settings 是本地概念，不参与。
 */

export type { StoredImage, TaskRecord }

/** 同步进度的对外形态，供设置面板渲染。 */
export interface SyncStatus {
  running: boolean
  total: number
  done: number
  lastSuccessAt: number | null
  error: string | null
  message: string | null
}

export interface SyncManifest {
  images: string[]
  version: number
  updatedAt: number
}

export interface TrashEntrySummary {
  id: string
  prompt: string
  deletedAt: number
  imageCount: number
}

export interface SyncPushResult {
  version: number
  updatedAt: number
  tasks: TaskRecord[]
}

export interface SyncClient {
  fetchManifest(): Promise<SyncManifest>
  hasImage(id: string): Promise<boolean>
  downloadImage(id: string): Promise<string | null>
  uploadImage(id: string, bytes: Uint8Array): Promise<void>
  /** 推送变更意图，拿回服务器合并后的全量活跃集。 */
  push(changedTasks: TaskRecord[], deletedTaskIds: string[]): Promise<SyncPushResult>
  listTrash(): Promise<TrashEntrySummary[]>
  restoreFromTrash(taskId: string): Promise<TaskRecord | null>
  emptyTrash(): Promise<{ tasks: number; images: number }>
}

/** 同步引擎所需的本地存储与状态出口，由接线层（syncBridge）注入。 */
export interface SyncSources {
  getTasks: () => TaskRecord[]
  /** 应用合并结果：整个任务列表换成给定的，removedIds 从本地库里删掉。 */
  applyTasks: (tasks: TaskRecord[], removedIds: string[]) => Promise<void>
  getImage: (id: string) => Promise<StoredImage | undefined>
  getAllImageIds: () => Promise<string[]>
  putImage: (id: string, dataUrl: string) => Promise<void>
  /** 本地收藏夹 id 集：拉下来的任务只认识这些夹，未知夹 id 摘除不回推。 */
  getLocalFavoriteCollectionIds: () => Set<string>
}

/** 重试、去抖等都是需要调优的关键参数，测试里会调小以免拖慢用例。 */
const DEFAULT_TIMING = {
  retryDelaysMs: [1_000, 5_000, 15_000],
  imageRetryMs: 30_000,
  taskDebounceMs: 1_000,
  periodicMs: 60_000,
}

let timing = { ...DEFAULT_TIMING }

/** 只供测试调整节奏，生产路径保持默认值。 */
export function configureSyncTiming(next: Partial<typeof DEFAULT_TIMING>) {
  timing = { ...timing, ...next }
}

const UPLOAD_CONCURRENCY = 3

let status: SyncStatus = {
  running: false,
  total: 0,
  done: 0,
  lastSuccessAt: null,
  error: null,
  message: null,
}

const listeners = new Set<(status: SyncStatus) => void>()

export function subscribeSyncStatus(listener: (status: SyncStatus) => void) {
  listeners.add(listener)
  listener(status)
  return () => {
    listeners.delete(listener)
  }
}

export function getSyncStatus() {
  return status
}

/**
 * 失败原因不该只在设置面板里可见，所以给调用方一个提示出口。
 *
 * 本模块刻意不引用 store（它会被服务端测试直接加载），提示由接线层注入。
 */
let notify: ((message: string, type: 'info' | 'success' | 'error') => void) | null = null

export function setSyncNotifier(next: typeof notify) {
  notify = next
}

function setStatus(patch: Partial<SyncStatus>) {
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

/** 退避重试：网络或服务器暂时不可用时不该让某张图永久同步不上。 */
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

export interface SyncClientOptions {
  memberId: string
  fetchImpl?: typeof fetch
}

let baseUrlOverride: string | null = null

/** 只供测试：把客户端指向临时起的服务端（浏览器里没有 window 时无法推断地址）。 */
export function setSyncBaseUrlForTests(url: string | null) {
  baseUrlOverride = url
}

/**
 * 同步服务的地址：即当前站点。
 *
 * 由部署决定，不是用户设置项——应用与同步服务是同一个 Node 进程、同一端口，
 * 所以同源是必然的，界面上就不该有「服务器地址」这个输入框。
 */
export function resolveSyncBaseUrl() {
  if (baseUrlOverride !== null) return baseUrlOverride
  return typeof window === 'undefined' ? '' : window.location.origin
}

/**
 * 探测这个地址上有没有服务端。
 *
 * 决定「要不要显示成员码与同步」：纯静态部署下这个请求会 404 或失败，同步那一整套
 * UI 就不该出现。所以要一个专门且**便宜**的端点：不校验成员码、不读磁盘，只看这个
 * 进程在不在。带超时：地址填错时不该让界面干等浏览器的默认超时。
 */
export async function probeSyncServer(fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<boolean> {
  const base = resolveSyncBaseUrl()
  if (!base) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/api/sync/ping`, { method: 'GET', signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json() as { ok?: boolean }
    return body?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const base = resolveSyncBaseUrl()
  const fetchImpl = options.fetchImpl ?? fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持同步所需的网络请求接口。')

  async function request(path: string, init: RequestInit = {}) {
    return await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'X-Member-Id': options.memberId, ...init.headers },
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
      const response = await request('/api/sync/manifest')
      await expectOk(response, '无法读取服务器上的同步清单')
      const body = await response.json() as Partial<SyncManifest>
      return { images: body.images ?? [], version: body.version ?? 0, updatedAt: body.updatedAt ?? 0 }
    },

    async hasImage(id) {
      const response = await request(`/api/sync/images/${encodeURIComponent(id)}`, { method: 'HEAD' })
      if (response.status === 404) return false
      await expectOk(response, '无法检查图片是否已同步')
      return true
    },

    async downloadImage(id) {
      const response = await request(`/api/sync/images/${encodeURIComponent(id)}`)
      if (response.status === 404) return null
      await expectOk(response, '图片下载失败')
      // 服务器只存原始字节，data URL 的类型在客户端按文件头还原。
      const bytes = new Uint8Array(await response.arrayBuffer())
      return bytesToDataUrl(bytes, `image.${sniffImageExtension(bytes)}`)
    },

    async uploadImage(id, bytes) {
      const response = await request(`/api/sync/images/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        // 服务器存的是解码后的原始字节，用 Blob 包裹以满足 BodyInit 的类型要求。
        body: new Blob([bytes as BlobPart]),
      })
      await expectOk(response, '图片上传失败')
    },

    async push(changedTasks, deletedTaskIds) {
      const response = await request('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changedTasks, deletedTaskIds }),
      })
      await expectOk(response, '同步请求失败')
      const body = await response.json() as Partial<SyncPushResult>
      return { version: body.version ?? 0, updatedAt: body.updatedAt ?? 0, tasks: body.tasks ?? [] }
    },

    async listTrash() {
      const response = await request('/api/sync/trash')
      await expectOk(response, '无法读取回收站')
      const body = await response.json() as { items?: TrashEntrySummary[] }
      return body.items ?? []
    },

    async restoreFromTrash(taskId) {
      const response = await request(`/api/sync/trash/${encodeURIComponent(taskId)}/restore`, { method: 'POST' })
      if (response.status === 404) return null
      await expectOk(response, '还原失败')
      const body = await response.json() as { task?: TaskRecord }
      return body.task ?? null
    },

    async emptyTrash() {
      const response = await request('/api/sync/trash', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: options.memberId }),
      })
      await expectOk(response, '清空回收站失败')
      const body = await response.json() as { removed?: { tasks: number; images: number } }
      return body.removed ?? { tasks: 0, images: 0 }
    },
  }
}

/** 只判断某个成员码在服务器上有没有数据，不拉取任何内容。 */
export async function memberExistsOnServer(config: SyncClientOptions, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!config.memberId) return false
  const client = createSyncClient(config)
  const manifest = await withRetry(() => client.fetchManifest())
  return manifest.version > 0 || manifest.images.length > 0
}

/**
 * 从文件头判断图片格式后缀。
 *
 * 服务器是只存字节的哑巴仓库，不记 MIME（也就不需要为它维护一份旁路元数据），
 * 而 data URL 又必须带上正确的类型才能被浏览器解码，所以在客户端按魔数还原。
 */
export function sniffImageExtension(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x47) return 'gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp'
  return 'png'
}

// ===== 本地持久化的同步元数据 =====

interface PendingIntents {
  changedTaskIds: string[]
  deletedTaskIds: string[]
}

// 元数据全部按成员码分键：换成员码不会把上一个空间的删除意图和已知集带进新空间——
// 否则新空间的第一轮同步会把本地任务当成「远端已删」清掉。

function pendingKey(memberId: string) {
  return `pendingIntents:${memberId}`
}

function knownIdsKey(memberId: string) {
  return `knownTaskIds:${memberId}`
}

function lastVersionKey(memberId: string) {
  return `lastVersion:${memberId}`
}

let pending: { changed: Set<string>; deleted: Set<string> } = { changed: new Set(), deleted: new Set() }
let knownIds = new Set<string>()
/** 上次同步响应的版本号。响应版本比它小 = 服务端状态丢失（文件损坏/被清），不能信删除。 */
let lastVersion: number | null = null

/** IndexedDB 写入串行化：并发写同一键时后写者必须基于前写者的结果。 */
let metaWriteChain = Promise.resolve()

function persistPending() {
  const memberId = config?.memberId
  if (!memberId) return
  const snapshot: PendingIntents = { changedTaskIds: [...pending.changed], deletedTaskIds: [...pending.deleted] }
  metaWriteChain = metaWriteChain.then(() => setSyncValue(pendingKey(memberId), snapshot))
    .catch((error) => console.warn('[sync] 待推送队列写入失败：', error))
}

function persistKnownIds() {
  const memberId = config?.memberId
  if (!memberId) return
  const snapshot = [...knownIds]
  metaWriteChain = metaWriteChain.then(() => setSyncValue(knownIdsKey(memberId), snapshot))
    .catch((error) => console.warn('[sync] 已知任务集写入失败：', error))
}

function persistLastVersion() {
  const memberId = config?.memberId
  if (!memberId || lastVersion === null) return
  metaWriteChain = metaWriteChain.then(() => setSyncValue(lastVersionKey(memberId), lastVersion))
    .catch((error) => console.warn('[sync] 版本号写入失败：', error))
}

/** 启动时把 IndexedDB 里的意图与已知集恢复到内存（在 configureSync 之后调用）。 */
export async function loadSyncMeta() {
  const memberId = config?.memberId
  if (!memberId) {
    pending = { changed: new Set(), deleted: new Set() }
    knownIds = new Set()
    lastVersion = null
    return
  }
  // 写入是异步链，先等在途写落地再读，否则刚入队的意图会被旧值覆盖。
  await metaWriteChain
  const [storedPending, storedKnown, storedVersion] = await Promise.all([
    getSyncValue<PendingIntents>(pendingKey(memberId)),
    getSyncValue<string[]>(knownIdsKey(memberId)),
    getSyncValue<number>(lastVersionKey(memberId)),
  ])
  pending = {
    changed: new Set(Array.isArray(storedPending?.changedTaskIds) ? storedPending.changedTaskIds : []),
    deleted: new Set(Array.isArray(storedPending?.deletedTaskIds) ? storedPending.deletedTaskIds : []),
  }
  knownIds = new Set(Array.isArray(storedKnown) ? storedKnown : [])
  lastVersion = typeof storedVersion === 'number' && Number.isFinite(storedVersion) ? storedVersion : null
}

/** 只供测试重置模块级状态。 */
export function resetSyncForTests() {
  if (retryTimer) clearTimeout(retryTimer)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (periodicTimer) clearInterval(periodicTimer)
  retryTimer = null
  debounceTimer = null
  periodicTimer = null
  pending = { changed: new Set(), deleted: new Set() }
  knownIds = new Set()
  lastVersion = null
  metaWriteChain = Promise.resolve()
  config = null
  client = null
  sources = null
  imageReader = null
  notify = null
  syncChain = Promise.resolve(null)
  applyingLocally = false
  status = { running: false, total: 0, done: 0, lastSuccessAt: null, error: null, message: null }
}

// ===== 运行时接线 =====

let config: SyncClientOptions | null = null
let client: SyncClient | null = null
let sources: SyncSources | null = null
let imageReader: ((id: string) => Promise<StoredImage | undefined>) | null = null

export function configureSync(next: SyncClientOptions, nextClient?: SyncClient) {
  config = next
  client = nextClient ?? (next.memberId ? createSyncClient(next) : null)
}

/** 填了成员码同步就生效；服务器地址由部署决定，不是用户的前置条件。 */
export function isSyncActive() {
  return Boolean(config?.memberId && client)
}

export function bindSyncSources(next: SyncSources, reader?: (id: string) => Promise<StoredImage | undefined>) {
  sources = next
  imageReader = reader ?? next.getImage
}

/** 合并应用期间为真：接线层的任务 diff 看到它要跳过，否则拉下来的任务会被当成改动再推回去。 */
export function isSyncApplying() {
  return applyingLocally
}

let applyingLocally = false

// ===== 变更意图队列 =====

/** 任务内容变了：下一轮同步推上去。running 任务会在推送时被过滤，不进请求体。 */
export function queueTaskChange(taskId: string) {
  if (!isSyncActive()) return
  pending.changed.add(taskId)
  persistPending()
  scheduleTaskSync()
}

/** 任务被删：从变更集里摘掉，进删除集。删除意图必须持久化，否则关标签页就复活。 */
export function queueTaskDeletion(taskId: string) {
  if (!isSyncActive()) return
  pending.changed.delete(taskId)
  pending.deleted.add(taskId)
  persistPending()
  scheduleTaskSync()
}

// ===== 同步周期 =====

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let periodicTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let syncChain: Promise<SyncOutcome | null> = Promise.resolve(null)

/** mutation 后适度去抖，避免一次批量操作触发一连串同步。 */
export function scheduleTaskSync() {
  if (!isSyncActive()) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSyncNow()
  }, timing.taskDebounceMs)
}

/** 定时兜底：拉取别的设备推上来的变更，也重试之前失败的部分。 */
export function startPeriodicSync() {
  if (periodicTimer) return
  periodicTimer = setInterval(() => {
    void runSyncNow()
  }, timing.periodicMs)
}

/**
 * 标签页隐藏/关闭时尽力同步一次。
 *
 * flush 只是尽力而为：pending 意图已经持久化在 IndexedDB 里，这次没发出去的
 * 下次启动同步会补上，所以失败与中断都不需要任何补偿。
 */
export function registerFlushHandlers() {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void runSyncNow()
  })
  window.addEventListener('pagehide', () => {
    void runSyncNow()
  })
}

/**
 * 一轮完整同步：推送本地意图 → 应用服务器活跃集 → 图片差集补齐。
 *
 * 多次调用串行执行；失败只记录状态并交给定时/去抖重试，不向外抛。
 */
export function runSyncNow(): Promise<SyncOutcome | null> {
  const run = syncChain.then(() => runCycle())
  syncChain = run.then(() => null, () => null)
  return run
}

export interface SyncOutcome {
  version: number
  tasks: number
  images: number
}

async function runCycle(): Promise<SyncOutcome | null> {
  if (!isSyncActive() || !client || !sources) return null

  try {
    setStatus({ running: true, error: null, message: '正在同步任务…' })
    const body = buildPushBody()
    const result = await withRetry(() => client!.push(body.changedTasks, body.deletedTaskIds))
    // 响应版本号比上次见过的还小：服务端活跃集丢了（state.json 损坏/被清）。
    // 这时候「曾见过、现在没了」不再成立，本地一个都不能删，反而要把本地全量重推上去。
    const stateLost = lastVersion !== null && result.version < lastVersion
    lastVersion = result.version
    persistLastVersion()
    await applySyncResult(result.tasks, body.sentChanged, stateLost)
    clearSentIntents(body)
    if (stateLost) requeueAllLocalTasks()

    const images = await reconcileImages()
    setStatus({
      running: false,
      message: `已同步：${result.tasks.length} 个任务、版本 ${result.version}`,
      lastSuccessAt: Date.now(),
    })
    return { version: result.version, tasks: result.tasks.length, images }
  } catch (error) {
    const message = `同步失败：${describeError(error)}`
    setStatus({ running: false, message: null, error: message })
    notify?.(message, 'error')
    return null
  }
}

/**
 * 组装推送体。
 *
 * running 任务是纯本地态不参与同步：它们的 id 留在 pending 里但不出现在请求体，
 * 等结束后由完成时的 mutation 重新入队。
 */
function buildPushBody() {
  const changedTasks: TaskRecord[] = []
  const sentChanged = new Set<string>()
  const tasksById = new Map(sources!.getTasks().map((task) => [task.id, task]))
  for (const id of pending.changed) {
    const task = tasksById.get(id)
    if (!task) {
      // 任务已经不存在又不在删除集里，是残留的陈旧意图，直接清掉。
      pending.changed.delete(id)
      continue
    }
    if (task.status === 'running') continue
    changedTasks.push(task)
    sentChanged.add(id)
  }
  return { changedTasks, deletedTaskIds: [...pending.deleted], sentChanged }
}

function clearSentIntents(body: ReturnType<typeof buildPushBody>) {
  for (const id of body.sentChanged) pending.changed.delete(id)
  for (const id of body.deletedTaskIds) pending.deleted.delete(id)
  persistPending()
}

/**
 * 把服务器活跃集合并进本地。
 *
 * 规则（按任务逐个套用）：
 * - 本地有、服务器没有：knownIds 里有它 → 别的设备删了 → 本地也删；没有 → 本地新任务，留下等推送。
 * - 两边都有：pending 里还有它的变更 → 保留本地版（同步期间又改过），下轮再推；否则采用服务器版。
 * - 服务器有、本地没有：拉下来。
 *
 * stateLost（服务端状态丢失）时跳过删除判定：本地任务全部保留，配合全量重推把服务器重新灌满。
 */
async function applySyncResult(serverTasks: TaskRecord[], sentChanged: Set<string>, stateLost = false) {
  if (!sources) return
  const serverIds = new Set(serverTasks.map((task) => task.id))
  const localTasks = sources.getTasks()
  const now = Date.now()

  const nextTasks: TaskRecord[] = []
  const removedIds: string[] = []
  for (const task of localTasks) {
    if (!serverIds.has(task.id)) {
      if (!stateLost && knownIds.has(task.id)) removedIds.push(task.id)
      else nextTasks.push(task)
      continue
    }
    if (pending.changed.has(task.id) && !sentChanged.has(task.id)) {
      // 同步期间又改过（或 running 被过滤没推出去）：本地版更新，留下下轮推。
      nextTasks.push(task)
    }
    // 其余情况：本地副本丢弃，采用服务器版本（下面统一补进 nextTasks）。
  }

  const localCollectionIds = sources.getLocalFavoriteCollectionIds()
  for (const task of serverTasks) {
    if (nextTasks.some((existing) => existing.id === task.id)) continue
    nextTasks.push(normalizePulledTask(task, now, localCollectionIds))
  }

  applyingLocally = true
  try {
    await sources.applyTasks(nextTasks, removedIds)
  } finally {
    applyingLocally = false
  }

  // 状态丢失时把本地任务也记进已知集：它们还活着，只是服务器暂时不认识它们。
  knownIds = stateLost ? new Set([...serverIds, ...localTasks.map((task) => task.id)]) : serverIds
  persistKnownIds()
}

/** 服务端状态丢失后的自愈：把本地全部（非 running）任务重新入队，下一轮推上去。 */
function requeueAllLocalTasks() {
  if (!sources) return
  for (const task of sources.getTasks()) {
    if (task.status !== 'running') pending.changed.add(task.id)
  }
  persistPending()
  scheduleTaskSync()
}

/**
 * 拉下来的任务的清理：running 状态出了那台设备就是死的，标记为已中断；
 * 收藏夹是本地概念，指向本地不存在的夹 id 摘除（不回推，服务器原件不受影响）。
 */
export function normalizePulledTask(task: TaskRecord, now: number, localCollectionIds: Set<string>): TaskRecord {
  let next = task
  if (next.status === 'running') {
    next = { ...next, ...createTaskErrorPatch(next, '请求中断（已同步）', now), falRecoverable: false, customRecoverable: false }
  }
  if (Array.isArray(next.favoriteCollectionIds) && next.favoriteCollectionIds.some((id) => !localCollectionIds.has(id))) {
    next = { ...next, favoriteCollectionIds: next.favoriteCollectionIds!.filter((id) => localCollectionIds.has(id)) }
  }
  return next
}

// ===== 图片仓库 =====

/**
 * 图片写入的统一入口回调。
 *
 * 上传在后台排队进行，不阻塞调用方继续生成；服务器上已存在的图片会被跳过。
 */
export function enqueueImageSync(image: StoredImage) {
  if (!isSyncActive()) return
  pendingImageIds.add(image.id)
  void drainImageQueue()
}

const pendingImageIds = new Set<string>()
let draining = false

async function drainImageQueue() {
  if (draining || !client) return
  draining = true
  try {
    while (pendingImageIds.size > 0) {
      const batch = [...pendingImageIds].slice(0, UPLOAD_CONCURRENCY)
      for (const id of batch) pendingImageIds.delete(id)
      const results = await Promise.all(batch.map((id) => uploadOneImage(id)))
      // 失败的图片放回队列，稍后整体重试一次，避免某张图永久没有同步。
      for (const [index, ok] of results.entries()) {
        if (!ok) pendingImageIds.add(batch[index])
      }
      if (results.some((ok) => !ok)) break
    }
  } finally {
    draining = false
    scheduleImageRetry()
  }
}

function scheduleImageRetry() {
  if (retryTimer || pendingImageIds.size === 0 || !isSyncActive()) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void drainImageQueue()
  }, timing.imageRetryMs)
}

async function uploadOneImage(id: string, image?: StoredImage) {
  try {
    if (await client!.hasImage(id)) return true
    const source = image?.id === id ? image : await readImage(id)
    if (!source) return false
    await withRetry(() => client!.uploadImage(id, dataUrlToBytes(source.dataUrl).bytes))
    setStatus({ error: null })
    return true
  } catch (error) {
    setStatus({ error: `图片 ${id.slice(0, 8)} 同步失败：${describeError(error)}` })
    return false
  }
}

function readImage(id: string) {
  return imageReader ? imageReader(id) : Promise.resolve(undefined)
}

/**
 * 图片差集自愈：清单对比，本地缺的下载、服务器缺的补传。
 *
 * 拉下来的任务会引用本机没有的图片（别的设备生成的），只靠写库钩子永远补不齐，
 * 所以每轮同步后做一次双向 diff。图片 id 是内容哈希，两边都是并集语义，没有冲突。
 */
async function reconcileImages(): Promise<number> {
  if (!client || !sources) return 0
  const manifest = await withRetry(() => client!.fetchManifest())
  const serverIds = new Set(manifest.images)
  const localIds = new Set(await sources.getAllImageIds())

  const toUpload = [...localIds].filter((id) => !serverIds.has(id))
  const toDownload = manifest.images.filter((id) => !localIds.has(id))
  if (!toUpload.length && !toDownload.length) return 0

  setStatus({ total: toUpload.length + toDownload.length, done: 0, message: '正在补齐图片…' })
  let done = 0
  let failed = 0

  const queue = [...toDownload.map((id) => ({ id, direction: 'download' as const })), ...toUpload.map((id) => ({ id, direction: 'upload' as const }))]
  while (queue.length > 0) {
    const batch = queue.splice(0, UPLOAD_CONCURRENCY)
    const results = await Promise.all(batch.map(async (item) => {
      try {
        if (item.direction === 'upload') {
          await uploadOneImage(item.id)
        } else {
          const dataUrl = await withRetry(() => client!.downloadImage(item.id))
          if (dataUrl) await sources!.putImage(item.id, dataUrl)
        }
        return true
      } catch {
        return false
      }
    }))
    done += results.filter(Boolean).length
    failed += results.filter((ok) => !ok).length
    setStatus({ done })
  }

  if (failed > 0) setStatus({ error: `${failed} 张图片本轮未能同步，稍后自动重试。` })
  return done
}

/** 仅供测试：读取当前待推送意图。 */
export function getPendingIntentsForTests() {
  return { changed: new Set(pending.changed), deleted: new Set(pending.deleted) }
}

// ===== 回收站与退出成员空间 =====

function requireClient(): SyncClient {
  if (!client) throw new Error('同步未启用，请先在同步设置里填写成员码。')
  return client
}

/** 服务器回收站列表（任务摘要，按删除时间倒序）。 */
export function fetchTrashEntries(): Promise<TrashEntrySummary[]> {
  return requireClient().listTrash()
}

/** 还原一条回收站任务到活跃集，并立刻同步一次把它拉回本地。 */
export async function restoreTrashEntry(taskId: string): Promise<boolean> {
  const restored = await requireClient().restoreFromTrash(taskId)
  if (!restored) return false
  await runSyncNow()
  return true
}

/** 清空服务器回收站（确认成员码由客户端按配置带上），并同步一次让本地与服务器对齐。 */
export async function emptyServerTrash(): Promise<{ tasks: number; images: number }> {
  const removed = await requireClient().emptyTrash()
  await runSyncNow()
  return removed
}

/**
 * 退出当前成员空间：清掉本机为这个成员持久化的同步元数据。
 *
 * 只影响本机的意图与已知集，服务器数据不动；不清的话，陈旧的删除意图会在用户
 * 重新加入同一个成员空间时复活，把刚同步回来的任务再删一遍。
 */
export function purgeSyncMeta() {
  const memberId = config?.memberId
  if (!memberId) return
  pending = { changed: new Set(), deleted: new Set() }
  knownIds = new Set()
  lastVersion = null
  metaWriteChain = metaWriteChain.then(() => Promise.all([
    removeSyncValue(pendingKey(memberId)),
    removeSyncValue(knownIdsKey(memberId)),
    removeSyncValue(lastVersionKey(memberId)),
  ])).then(() => undefined)
}
