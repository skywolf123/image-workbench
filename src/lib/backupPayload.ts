import type { AgentConversation, ApiProfile, AppSettings, FavoriteCollection, TaskRecord } from '../types'
import type { TaskParams } from '../types'

/**
 * 备份载荷：平台上自动备份与恢复所用的数据结构。
 *
 * 它与用户手动导出的 ZIP 是两回事：这里只承载「用户数据」，平台级配置（上游地址、
 * API Key、模型、Codex 开关）在打包前就被剥离，永不离开浏览器去服务器。
 */
export interface BackupPayload {
  settings: AppSettings
  params: TaskParams
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  agentConversations: AgentConversation[]
}

/** 任务与状态在服务器上按整份快照存放，恢复时只补本地缺失的记录。 */
export interface BackupSnapshot {
  tasks: TaskRecord[]
  payload: BackupPayload
}

function stripDeploymentProfile(profile: ApiProfile): ApiProfile {
  const stripped: ApiProfile = { ...profile, baseUrl: '', apiKey: '', model: '', codexCli: false }
  if (!profile.providerDrafts) return stripped

  const drafts = { ...profile.providerDrafts }
  for (const provider of Object.keys(drafts) as Array<keyof typeof drafts>) {
    const draft = drafts[provider]
    if (draft) drafts[provider] = { ...draft, baseUrl: undefined, model: undefined, codexCli: undefined }
  }
  stripped.providerDrafts = drafts
  return stripped
}

/**
 * 剥离平台级配置。
 *
 * ⚠️ 平台配置同时存在于两处：settings 的顶层字段，**以及** profiles 数组里每一项的
 * 同名字段。两处都必须处理，漏掉后者会让 key 从数组里漏进备份。
 */
export function stripDeploymentConfig(settings: AppSettings): AppSettings {
  return {
    ...settings,
    baseUrl: '',
    apiKey: '',
    model: '',
    codexCli: false,
    profiles: settings.profiles.map(stripDeploymentProfile),
  }
}

export function createBackupPayload(
  settings: AppSettings,
  source: Omit<BackupPayload, 'settings'>,
): BackupPayload {
  return { ...source, settings: stripDeploymentConfig(settings) }
}
