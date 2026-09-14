import type { AgentConversation, ApiProfile, AppSettings, FavoriteCollection, TaskParams, TaskRecord } from '../types'

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

/**
 * 一致性处理：任务引用了本地不存在的图片时，把那些引用摘掉。
 *
 * 服务器是只增不删的，但本地可能清理过图片、备份也可能是在图片上传之前做的，
 * 于是恢复回来的任务会引用到不存在的 id。留着它们会让画廊里出现渲染不出内容的空任务，
 * 所以恢复时按本地实际存在的图片 id 过滤一遍引用。
 */
export function dropDanglingImageReferences(tasks: TaskRecord[], availableImageIds: Set<string>): TaskRecord[] {
  return tasks.map((task) => {
    const outputImages = (task.outputImages ?? []).filter((id) => availableImageIds.has(id))
    const inputImageIds = (task.inputImageIds ?? []).filter((id) => availableImageIds.has(id))
    const transparentOriginalImages = task.transparentOriginalImages?.filter((id) => !id || availableImageIds.has(id))
    const unchanged = outputImages.length === (task.outputImages?.length ?? 0) &&
      inputImageIds.length === (task.inputImageIds?.length ?? 0) &&
      transparentOriginalImages?.length === task.transparentOriginalImages?.length &&
      (!task.maskImageId || availableImageIds.has(task.maskImageId)) &&
      (!task.maskTargetImageId || availableImageIds.has(task.maskTargetImageId))
    if (unchanged) return task

    // 原本有输出、恢复后一张都不剩：把它标成错误任务，比留一个没有内容的「已完成」更诚实。
    const lostAllOutputs = task.status === 'done' && (task.outputImages?.length ?? 0) > 0 && outputImages.length === 0

    return {
      ...task,
      outputImages,
      inputImageIds,
      ...(transparentOriginalImages ? { transparentOriginalImages } : {}),
      ...(task.maskImageId && !availableImageIds.has(task.maskImageId) ? { maskImageId: null } : {}),
      ...(task.maskTargetImageId && !availableImageIds.has(task.maskTargetImageId) ? { maskTargetImageId: null } : {}),
      // 这两张表按图片 id 建键，同样要跟着清理，否则会留下孤儿条目。
      ...(task.actualParamsByImage ? { actualParamsByImage: pickAvailableKeys(task.actualParamsByImage, availableImageIds) } : {}),
      ...(task.revisedPromptByImage ? { revisedPromptByImage: pickAvailableKeys(task.revisedPromptByImage, availableImageIds) } : {}),
      ...(lostAllOutputs ? { status: 'error' as const, error: '输出图片在恢复时已不可用。' } : {}),
    }
  })
}

function pickAvailableKeys<T>(map: Record<string, T>, availableImageIds: Set<string>) {
  const next: Record<string, T> = {}
  for (const [id, value] of Object.entries(map)) {
    if (availableImageIds.has(id)) next[id] = value
  }
  return next
}
