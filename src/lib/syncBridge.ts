import { commitTaskDeletion, getAllImageIds, getImage, putImage, setImageStoredHook } from './db'
import {
  bindSyncSources,
  configureSync,
  enqueueImageSync,
  isSyncActive,
  isSyncApplying,
  loadSyncMeta,
  probeSyncServer,
  queueTaskChange,
  queueTaskDeletion,
  registerFlushHandlers,
  resolveSyncBaseUrl,
  runSyncNow,
  setSyncNotifier,
  startPeriodicSync,
  type SyncSources,
} from './syncEngine'
import { readSyncConfig, saveSyncConfig, type SyncConfig } from './syncConfig'
import { useStore } from '../store'

let stopWatching: (() => void) | null = null

/**
 * 把同步引擎接到应用的存储与状态上。
 *
 * 这里只做接线：引擎的变更意图来自本模块对 store 的任务 diff（按任务对象引用判变），
 * 图片写入的统一入口在 `db.ts` 挂一个回调，合并结果经 applyTasks 一次性交回本地。
 */
export function initSync() {
  configureSync(readSyncConfig())
  bindSyncSources(createSyncSources(), getImage)
  setSyncNotifier((message, type) => useStore.getState().showToast(message, type))
  // 先把持久化的意图与已知集读回来再启动同步：带着旧状态合并才不会误判删除。
  void loadSyncMeta().then(() => {
    if (isSyncActive()) void runSyncNow()
  })
  setImageStoredHook((image) => enqueueImageSync(image))
  watchTasks()
  startPeriodicSync()
  registerFlushHandlers()
}

function createSyncSources(): SyncSources {
  return {
    getTasks: () => useStore.getState().tasks,
    async applyTasks(tasks, removedIds) {
      // 存储层与内存要一起换，否则会出现「库里换了但界面上还在」的中间态。
      await commitTaskDeletion(removedIds, tasks, [])
      useStore.setState({ tasks })
    },
    getImage,
    getAllImageIds,
    async putImage(id, dataUrl) {
      await putImage({ id, dataUrl, createdAt: Date.now(), source: 'generated' })
    },
    getLocalFavoriteCollectionIds: () =>
      new Set(useStore.getState().favoriteCollections.map((collection) => collection.id)),
  }
}

/**
 * 任务列表的 diff 接线：对象引用没变的任务没变，引用变了或新增的算变更，消失的算删除。
 *
 * 代码库对任务的更新全部走不可变替换，所以引用比较既便宜又准确；引擎应用合并结果
 * 期间（isSyncApplying）产生的变更来自服务器，不能再推回去。
 */
function watchTasks() {
  stopWatching?.()
  let previousTasks = useStore.getState().tasks
  stopWatching = useStore.subscribe((state) => {
    if (state.tasks === previousTasks) return
    const previous = previousTasks
    previousTasks = state.tasks
    if (!isSyncActive() || isSyncApplying()) return

    const previousById = new Map(previous.map((task) => [task.id, task]))
    for (const task of state.tasks) {
      if (task.status === 'running') continue
      if (previousById.get(task.id) !== task) queueTaskChange(task.id)
    }
    const currentIds = new Set(state.tasks.map((task) => task.id))
    for (const task of previous) {
      if (!currentIds.has(task.id)) queueTaskDeletion(task.id)
    }
  })
}

/** 配置变更后重新接线；成员码变化由设置面板负责触发一次同步。 */
export function applySyncConfig(next: SyncConfig) {
  saveSyncConfig(next)
  configureSync(next)
  watchTasks()
}

/**
 * 这次会话里探测到的同步服务器地址；null 表示还没探过。
 *
 * 探测只发生在两个地方：首次打开的引导，以及打开设置窗口。两处都按「当前站点」探——
 * 应用与同步服务同源部署，能探到就说明这个部署有服务端在提供同步能力。
 */
let probedServerUrl: string | null = null
const probeListeners = new Set<() => void>()

/** 让界面在探测结果回来后重新渲染。 */
export function subscribeSyncServerProbe(listener: () => void) {
  probeListeners.add(listener)
  return () => {
    probeListeners.delete(listener)
  }
}

/** 探测当前站点上有没有服务端；结果缓存在本次会话内，避免反复请求。 */
export async function detectSyncServer(): Promise<boolean> {
  if (probedServerUrl !== null) return probedServerUrl !== ''
  const reachable = await probeSyncServer()
  probedServerUrl = reachable ? resolveSyncBaseUrl() : ''
  for (const listener of probeListeners) listener()
  return reachable
}

/** 让设置页在用户改完地址后能重新探测。 */
export function resetSyncServerProbe() {
  probedServerUrl = null
  for (const listener of probeListeners) listener()
}

/** 探测是否已经完成（无论有没有探到）。界面用它区分「还没探完」与「探过但没有」。 */
export function isSyncServerProbed() {
  return probedServerUrl !== null
}

/** 探到同步服务器了吗。引导弹窗与设置页的同步标签都用它决定出不出现。 */
export function hasSyncServer() {
  return probedServerUrl !== null && probedServerUrl !== ''
}

/** 首次引导的出现条件：能探到服务器，且这台设备还没有成员码。 */
export function needsMemberIdOnboarding() {
  return hasSyncServer() && !readSyncConfig().memberId
}

/** 生成便于口头/手抄传递的成员码：去掉容易看错的 0/O/1/l/I。 */
export function createMemberId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

/**
 * 换用一个成员码。
 *
 * 合并语义下不再区分「新建空间」与「接入已有空间」：本地任务推上去，服务器的活跃集
 * 拉下来，两边取并集——没有任何本地内容会被覆盖丢失，所以也不需要破坏性确认。
 */
export async function adoptMemberId(memberId: string): Promise<void> {
  applySyncConfig({ ...readSyncConfig(), memberId: memberId.trim() })
  await loadSyncMeta()
  await runSyncNow()
}

/** 仅供测试重置接线层状态。 */
export function resetSyncBridgeForTests() {
  stopWatching?.()
  stopWatching = null
  probedServerUrl = null
  probeListeners.clear()
}
