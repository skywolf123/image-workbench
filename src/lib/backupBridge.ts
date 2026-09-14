import { getAllImages, getAllTasks, getImage, putImage, putTask, setImageStoredHook } from './db'
import { normalizePersistedState } from './persistedState'
import {
  bindBackupSources,
  configureBackup,
  enqueueImageBackup,
  scheduleSnapshotBackup,
  setBackupNotifier,
  setPendingImageReader,
  type BackupSource,
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

  bindBackupSources({
    provider: () => {
      const state = useStore.getState()
      return {
        images: [],
        tasks: state.tasks,
        settings: state.settings,
        params: state.params,
        favoriteCollections: state.favoriteCollections,
        defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
        agentConversations: state.agentConversations,
      } satisfies BackupSource
    },
    sink: {
      async getExistingImageIds() {
        return new Set((await getAllImages()).map((image) => image.id))
      },
      async putImage(id, dataUrl) {
        // 调用方已经过滤过缺失的 id，这里直接写回。
        await putImage({ id, dataUrl, createdAt: Date.now(), source: 'generated' })
      },
      async getExistingTaskIds() {
        return new Set((await getAllTasks()).map((task) => task.id))
      },
      async putTasks(tasks) {
        const state = useStore.getState()
        const existingIds = new Set(state.tasks.map((task) => task.id))
        const freshTasks = tasks.filter((task) => !existingIds.has(task.id))
        for (const task of freshTasks) await putTask(task)
        // 一次交回全部缺失任务：落库后再合并进内存列表，让恢复结果立刻可见。
        if (freshTasks.length > 0) useStore.getState().setTasks([...state.tasks, ...freshTasks])
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
        // 会话只在本地没有时才补：恢复语义是只补缺失，绝不覆盖本地已有的整理结果。
        if (state.agentConversations.length === 0 && payload.agentConversations.length > 0) {
          useStore.setState({ agentConversations: payload.agentConversations })
        }
      },
    },
  })

  setImageStoredHook((image) => enqueueImageBackup(image))
  setPendingImageReader(getImage)
  setBackupNotifier((message, type) => useStore.getState().showToast(message, type))
  watchForBackupableChanges()
}

/** 配置变更后重新接线；成员码变化属于切换命名空间，由调用方负责提示用户手动同步。 */
export function applyBackupConfig(next: BackupConfig) {
  saveBackupConfig(next)
  configureBackup(next)
  watchForBackupableChanges()
}

function watchForBackupableChanges() {
  stopWatching?.()
  let previousState = useStore.getState()
  stopWatching = useStore.subscribe((state) => {
    if (!readBackupConfig().enabled) return
    const changed = state.tasks !== previousState.tasks ||
      state.settings !== previousState.settings ||
      state.favoriteCollections !== previousState.favoriteCollections ||
      state.agentConversations !== previousState.agentConversations
    previousState = state
    if (changed) scheduleSnapshotBackup()
  })
}
