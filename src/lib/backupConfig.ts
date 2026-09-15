import { STORAGE_NAME } from './storageNamespace'

/**
 * 备份配置属于用户数据，保存在 localStorage 里，不进 store（store 已过大）。
 *
 * 只有成员码一个字段：服务器地址由部署决定（应用与备份服务同源），不是用户设置项。
 * 也没有「启用 / 停用」开关——填了成员码备份就是生效的，多一个开关只会多出一个
 * 「填了成员码但没开」的中间状态，让用户不确定自己的东西到底备份了没。
 *
 * 成员码只是服务器上的命名空间标识，不承担凭证职责：它不参与认证，平台 Key 也不在
 * 备份里，所以即便被别人猜到，后果也仅止于「看到该成员的图片」。
 */
export interface BackupConfig {
  memberId: string
}

const BACKUP_CONFIG_KEY = `${STORAGE_NAME}.backup-config`

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  memberId: '',
}

export function normalizeBackupConfig(input: unknown): BackupConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_BACKUP_CONFIG }
  const record = input as Record<string, unknown>
  return {
    memberId: typeof record.memberId === 'string' ? record.memberId.trim() : '',
  }
}

export function readBackupConfig(): BackupConfig {
  try {
    const raw = localStorage.getItem(BACKUP_CONFIG_KEY)
    return raw ? normalizeBackupConfig(JSON.parse(raw)) : { ...DEFAULT_BACKUP_CONFIG }
  } catch {
    // localStorage 不可用（或内容损坏）时按未配置处理。
    return { ...DEFAULT_BACKUP_CONFIG }
  }
}

export function saveBackupConfig(config: BackupConfig) {
  try {
    localStorage.setItem(BACKUP_CONFIG_KEY, JSON.stringify(normalizeBackupConfig(config)))
  } catch {
    // localStorage 不可用时只保留当前会话状态。
  }
}
