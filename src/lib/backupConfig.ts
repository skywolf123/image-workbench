import { STORAGE_NAME } from './storageNamespace'

/**
 * 备份配置属于用户数据，保存在 localStorage 里，不进 store（store 已过大）。
 *
 * 成员码只是服务器上的命名空间标识，不承担凭证职责：它不参与认证，平台 Key 也不在
 * 备份里，所以即便被别人猜到，后果也仅止于「看到该成员的图片」。
 */
export interface BackupConfig {
  enabled: boolean
  /** 备份服务器地址，留空表示不启用。 */
  serverUrl: string
  memberId: string
}

const BACKUP_CONFIG_KEY = `${STORAGE_NAME}.backup-config`

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  serverUrl: '',
  memberId: '',
}

export function normalizeBackupConfig(input: unknown): BackupConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_BACKUP_CONFIG }
  const record = input as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl.trim().replace(/\/+$/, '') : '',
    memberId: typeof record.memberId === 'string' ? record.memberId.trim() : '',
  }
}

export function readBackupConfig(): BackupConfig {
  try {
    const raw = localStorage.getItem(BACKUP_CONFIG_KEY)
    return raw ? normalizeBackupConfig(JSON.parse(raw)) : { ...DEFAULT_BACKUP_CONFIG }
  } catch {
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
