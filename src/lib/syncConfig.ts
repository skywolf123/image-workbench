import { STORAGE_NAME } from './storageNamespace'

/**
 * 同步配置属于用户数据，保存在 localStorage 里，不进 store（store 已过大）。
 *
 * 只有成员码一个字段：服务器地址由部署决定（应用与同步服务同源），不是用户设置项。
 * 也没有「启用 / 停用」开关——填了成员码同步就是生效的，多一个开关只会多出一个
 * 「填了成员码但没开」的中间状态，让用户不确定自己的东西到底同步了没。
 *
 * 成员码只是服务器上的命名空间标识，不承担凭证职责：它不参与认证，后端 Key 也不在
 * 同步数据里，所以即便被别人猜到，后果也仅止于「看到该成员的数据」。
 */
export interface SyncConfig {
  memberId: string
}

const SYNC_CONFIG_KEY = `${STORAGE_NAME}.sync-config`
/** 旧备份机制的 localStorage 键；读到旧键时迁移，避免用户重新填成员码。 */
const LEGACY_BACKUP_CONFIG_KEY = `${STORAGE_NAME}.backup-config`

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  memberId: '',
}

export function normalizeSyncConfig(input: unknown): SyncConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SYNC_CONFIG }
  const record = input as Record<string, unknown>
  return {
    memberId: typeof record.memberId === 'string' ? record.memberId.trim() : '',
  }
}

export function readSyncConfig(): SyncConfig {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY) ?? localStorage.getItem(LEGACY_BACKUP_CONFIG_KEY)
    return raw ? normalizeSyncConfig(JSON.parse(raw)) : { ...DEFAULT_SYNC_CONFIG }
  } catch {
    // localStorage 不可用（或内容损坏）时按未配置处理。
    return { ...DEFAULT_SYNC_CONFIG }
  }
}

export function saveSyncConfig(config: SyncConfig) {
  try {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(normalizeSyncConfig(config)))
    // 新键写成功后清掉旧键，避免留下两份真相。
    if (localStorage.getItem(LEGACY_BACKUP_CONFIG_KEY) !== null) {
      localStorage.removeItem(LEGACY_BACKUP_CONFIG_KEY)
    }
  } catch {
    // localStorage 不可用时只保留当前会话状态。
  }
}
