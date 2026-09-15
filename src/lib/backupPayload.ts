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

/**
 * 把 Agent 会话里指向不存在图片的引用摘掉。
 *
 * Agent 的图片引用不经过任务，所以上面那份任务清理覆盖不到它们。备份与恢复都要过一遍：
 * 备份时防止把空引用存上去，恢复时防止渲染出加载不出来的空图。
 */
export function dropDanglingAgentImageReferences(
  conversations: AgentConversation[],
  availableImageIds: Set<string>,
): AgentConversation[] {
  return conversations.map((conversation) => {
    let changed = false
    const rounds = conversation.rounds.map((round) => {
      const inputImageIds = round.inputImageIds.filter((id) => availableImageIds.has(id))
      const keepMaskImage = !round.maskImageId || availableImageIds.has(round.maskImageId)
      const keepMaskTarget = !round.maskTargetImageId || availableImageIds.has(round.maskTargetImageId)
      // 遮罩是「输入图 + 遮罩」成对使用的，摘掉输入图后遮罩也就没有意义了。
      const keepMask = keepMaskImage && keepMaskTarget && inputImageIds.length > 0
      if (
        inputImageIds.length === round.inputImageIds.length &&
        keepMask === Boolean(round.maskImageId)
      ) return round
      changed = true
      return {
        ...round,
        inputImageIds,
        ...(keepMask ? {} : { maskImageId: null, maskTargetImageId: null }),
      }
    })
    if (!changed) return conversation
    return {
      ...conversation,
      rounds,
      messages: conversation.messages.map((message) => {
        if (!message.inputImageIds?.length) return message
        const inputImageIds = message.inputImageIds.filter((id) => availableImageIds.has(id))
        return inputImageIds.length === message.inputImageIds.length ? message : { ...message, inputImageIds }
      }),
    }
  })
}

/**
 * 把备份中仍处于运行中的 Agent 轮次收尾。
 *
 * 轮次的进度只存在于当前这次页面会话里，一旦离开这台浏览器（备份）或重进页面（恢复），
 * 它是死状态：界面会永远显示「正在生成回复」，Agent 的提交按钮也会一直卡在「停止生成」。
 * 消息本身没问题，只是轮次没有终态，所以标成 error 即可。
 */
export function dropInterruptedAgentRounds(conversations: AgentConversation[]): AgentConversation[] {
  return conversations.map((conversation) => {
    if (!conversation.rounds.some((round) => round.status === 'running')) return conversation
    const finishedAt = Date.now()
    return {
      ...conversation,
      rounds: conversation.rounds.map((round) => round.status === 'running'
        ? { ...round, status: 'error' as const, error: '请求中断（已从备份恢复）', finishedAt }
        : round),
    }
  })
}
