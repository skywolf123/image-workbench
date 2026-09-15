import { clearAgentConversations, clearImages, clearTasks, getAllImageIds, getImage, putImage, putTask, setImageStoredHook } from './db'
import { normalizePersistedState } from './persistedState'
import {
  bindBackupSources,
  configureBackup,
  enqueueImageBackup,
  memberExistsOnServer,
  probeBackupServer,
  resolveBackupBaseUrl,
  runBackupNow,
  runRestore,
  isBackupActive,
  scheduleSnapshotBackup,
  setBackupNotifier,
  setBackupImageReader,
  type BackupSource,
  type RestoreSink,
} from './backupSync'
import { readBackupConfig, saveBackupConfig, type BackupConfig } from './backupConfig'
import { useStore } from '../store'

let stopWatching: (() => void) | null = null

/**
 * 把备份模块接到应用的存储与状态上。
 *
 * 这里只做接线，备份逻辑本身全在 `backupSync` 里：图片写入的统一入口在 `db.ts` 挂一个
 * 回调，快照来源与恢复出口由 store 提供，恢复写回本地时走与正常启动相同的归一化流程。
 */
export function initBackup() {
  configureBackup(readBackupConfig())
  backupSink = createBackupSink()
  bindBackupSources({
    provider: async () => {
      const state = useStore.getState()
      // 输入图、参考图与遮罩同样属于用户数据：它们不经过生成的统一入口，
      // 只靠落库时的回调会漏掉，所以全量备份时统一从存储层取。
      return {
        images: await getAllImageIds(),
        tasks: state.tasks,
        settings: state.settings,
        params: state.params,
        favoriteCollections: state.favoriteCollections,
        defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
        agentConversations: state.agentConversations,
      } satisfies BackupSource
    },
    sink: backupSink,
  })

  setImageStoredHook((image) => enqueueImageBackup(image))
  setBackupImageReader(getImage)
  setBackupNotifier((message, type) => useStore.getState().showToast(message, type))
  watchForBackupableChanges()
}

let backupSink: RestoreSink | null = null

function createBackupSink(): RestoreSink {
  return {
    async putImage(id, dataUrl) {
      // 同步前本地已被清空，这里直接写回。
      await putImage({ id, dataUrl, createdAt: Date.now(), source: 'generated' })
    },
    async getAvailableImageIds() {
      return new Set(await getAllImageIds())
    },
    async putTasks(tasks) {
      for (const task of tasks) await putTask(task)
      useStore.getState().setTasks(tasks)
    },
    async applyPayload(payload) {
      // 备份可能来自旧版本，必须走与正常启动相同的归一化流程再写入。
      const state = useStore.getState()
      const plan = normalizePersistedState(
        {
          settings: payload.settings,
          params: payload.params,
          favoriteCollections: payload.favoriteCollections,
          defaultFavoriteCollectionId: payload.defaultFavoriteCollectionId,
          appMode: state.appMode,
          dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
          dismissedPresetProfileIds: state.dismissedPresetProfileIds,
          dismissedPresetProviderIds: state.dismissedPresetProviderIds,
        },
        {
          settings: state.settings,
          params: state.params,
          dismissedPresetProfileIds: state.dismissedPresetProfileIds,
          dismissedPresetProviderIds: state.dismissedPresetProviderIds,
          dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
          favoriteCollections: state.favoriteCollections,
          defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
          agentConversations: state.agentConversations,
        },
      )
      if (!plan) return
      // 设置必须走 setSettings：它内部会再跑一遍预设配置策略，把被剥离的平台字段
      // 从预置配置里补齐，而不是让空 baseUrl / 空模型留在 profile 里。
      useStore.getState().setSettings(plan.state.settings)
      useStore.setState({
        params: plan.state.params,
        favoriteCollections: plan.state.favoriteCollections,
        defaultFavoriteCollectionId: plan.state.defaultFavoriteCollectionId,
      })
      // 同步是替换语义：会话也整套换成服务器上的，不留本地旧的。
      useStore.setState({
        agentConversations: payload.agentConversations,
        activeAgentConversationId: payload.agentConversations[0]?.id ?? null,
      })
    },
    async clearLocal() {
      // 存储层与内存要一起清，否则会出现「库里空了但界面上还在」的中间态。
      // agentConversations 的持久化订阅会把清空后的状态写回 IndexedDB，这里同步改内存即可。
      await Promise.all([clearImages(), clearTasks(), clearAgentConversations()])
      useStore.setState({
        tasks: [],
        agentConversations: [],
        activeAgentConversationId: null,
        agentInputDrafts: {},
      })
    },
  }
}


/** 配置变更后重新接线；成员码变化由设置面板负责走「同步」流程。 */
export function applyBackupConfig(next: BackupConfig) {
  saveBackupConfig(next)
  configureBackup(next)
  watchForBackupableChanges()
}

/**
 * 这次会话里探测到的备份服务器地址；null 表示还没探过。
 *
 * 探测只发生在两个地方：首次打开的引导，以及打开设置窗口。两处都按「当前站点」探——
 * 应用与备份同源部署，能探到就说明这个部署有服务端在提供备份能力。
 */
let probedServerUrl: string | null = null
const probeListeners = new Set<() => void>()

/** 让界面在探测结果回来后重新渲染。 */
export function subscribeBackupServerProbe(listener: () => void) {
  probeListeners.add(listener)
  return () => {
    probeListeners.delete(listener)
  }
}

/** 探测当前站点上有没有平台服务端；结果缓存在本次会话内，避免反复请求。 */
export async function detectBackupServer(): Promise<boolean> {
  if (probedServerUrl !== null) return probedServerUrl !== ''
  const reachable = await probeBackupServer()
  probedServerUrl = reachable ? resolveBackupBaseUrl() : ''
  for (const listener of probeListeners) listener()
  return reachable
}

/** 让设置页在用户改完地址后能重新探测。 */
export function resetBackupServerProbe() {
  probedServerUrl = null
  for (const listener of probeListeners) listener()
}

/** 探测是否已经完成（无论有没有探到）。界面用它区分「还没探完」与「探过但没有」。 */
export function isBackupServerProbed() {
  return probedServerUrl !== null
}

/** 探到备份服务器了吗。引导弹窗与设置页的备份标签都用它决定出不出现。 */
export function hasBackupServer() {
  return probedServerUrl !== null && probedServerUrl !== ''
}

/** 首次引导的出现条件：能探到服务器，且这台设备还没有成员码。 */
export function needsMemberIdOnboarding() {
  return hasBackupServer() && !readBackupConfig().memberId
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
 * 服务器上已经有这个码 → 同步一次，用那个空间的记录替换本地（新设备接上已有成员空间）。
 * 服务器上没有 → 这是新建一个成员空间，把本地内容备份到这个码下（本地的图片与任务
 * 仍然属于用户，没有理由丢掉）。
 */
export async function adoptMemberId(memberId: string): Promise<'synced' | 'created'> {
  const trimmed = memberId.trim()
  const base = readBackupConfig()
  applyBackupConfig({ ...base, memberId: trimmed })
  if (await memberExistsOnServer({ ...base, memberId: trimmed })) {
    await runRestore()
    return 'synced'
  }
  await runBackupNow()
  return 'created'
}

function watchForBackupableChanges() {
  stopWatching?.()
  let previousState = useStore.getState()
  stopWatching = useStore.subscribe((state) => {
    if (!isBackupActive()) return
    const changed = state.tasks !== previousState.tasks ||
      state.settings !== previousState.settings ||
      state.favoriteCollections !== previousState.favoriteCollections ||
      state.agentConversations !== previousState.agentConversations
    previousState = state
    if (changed) scheduleSnapshotBackup()
  })
}
