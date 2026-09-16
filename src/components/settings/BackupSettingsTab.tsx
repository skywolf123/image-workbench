import { useEffect, useState } from 'react'
import { adoptMemberId, applyBackupConfig } from '../../lib/backupBridge'
import {
  getBackupStatus,
  memberExistsOnServer,
  runRestore,
  subscribeBackupStatus,
  type BackupStatus,
} from '../../lib/backupSync'
import { readBackupConfig, type BackupConfig } from '../../lib/backupConfig'
import { useStore } from '../../store'

function formatTime(timestamp: number | null) {
  if (!timestamp) return '尚未成功备份'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const inputClassName = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'

export default function BackupSettingsTab() {
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [config, setConfig] = useState<BackupConfig>(() => readBackupConfig())
  const [status, setStatus] = useState<BackupStatus>(() => getBackupStatus())
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeBackupStatus(setStatus), [])

  const requiresMemberId = !config.memberId
  const backupDisabled = requiresMemberId

  /** 配置一旦改动就立即生效，客户端后续请求会带上新值。 */
  const persist = (next: BackupConfig) => {
    setConfig(next)
    applyBackupConfig(next)
  }

  const syncFromServer = async () => {
    setBusy(true)
    try {
      const outcome = await runRestore()
      showToast(`同步完成：${outcome.images} 张图片、${outcome.tasks} 个任务`, 'success')
    } catch {
      // 失败原因已经写入状态并在面板上展示。
    } finally {
      setBusy(false)
    }
  }

  /**
   * 切换成员码，必须让用户知情后再动作。
   *
   * 服务器上已有这个码 → 同步一次，用那个空间的记录替换本地。
   * 服务器上没有 → 新建一个成员空间，把本地内容备份到这个码下（本地的东西没有理由丢掉）。
   */
  const commitMemberId = async (nextMemberId: string) => {
    const trimmed = nextMemberId.trim()
    if (!trimmed || trimmed === config.memberId) return

    setConfig({ ...config, memberId: trimmed })
    setBusy(true)
    let exists = false
    try {
      exists = await memberExistsOnServer({ ...config, memberId: trimmed })
    } catch {
      // 探测不到服务器时不能猜：猜错会要么白清本地、要么该同步的没同步。
      showToast('无法确认服务器上是否有这个成员码，请检查备份服务器地址。', 'error')
      setConfig(config)
      setBusy(false)
      return
    }
    setBusy(false)

    const next = { ...config, memberId: trimmed }
    const adopt = () => {
      setBusy(true)
      void adoptMemberId(trimmed)
        .then((result: 'synced' | 'created') => showToast(result === 'synced' ? '已同步服务器上的数据到本地。' : '已把本地内容备份到这个成员码下。', 'success'))
        .catch(() => {
          // 失败原因已经写入状态并在面板上展示。
        })
        .finally(() => setBusy(false))
    }

    setConfirmDialog(exists
      ? {
          title: '同步到已有成员码',
          message: `服务器上已经有「${trimmed}」这个成员码，它有自己的图片和任务记录。\n\n确认后会用服务器上的记录替换本地，本地未备份的内容将丢失。`,
          confirmText: '覆盖本地并同步',
          tone: 'warning',
          icon: 'info',
          action: () => { persist(next); adopt() },
          cancelAction: () => setConfig(config),
        }
      : {
          title: '新建成员码',
          message: `服务器上还没有「${trimmed}」这个成员码，确认后将新建一个成员空间，并把本设备现有的图片与任务备份到这个码下。\n\n本地内容不会被删除。`,
          confirmText: '新建并备份',
          tone: 'warning',
          icon: 'info',
          action: () => { persist(next); adopt() },
          cancelAction: () => setConfig(config),
        })
  }

  const confirmSync = () => {
    setConfirmDialog({
      title: '同步',
      message: '同步会用服务器上的数据替换本地数据，本地未备份的内容将丢失。\n\n备份到服务器上的内容不受影响。',
      confirmText: '覆盖本地并同步',
      tone: 'warning',
      icon: 'info',
      action: () => { void syncFromServer() },
      cancelAction: () => {},
    })
  }

  const running = busy || status.running

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-gray-50/80 p-4 border border-gray-200/60 dark:bg-white/[0.02] dark:border-white/[0.05] flex items-start gap-3">
        <svg className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <div className="text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
          新生成的图片与任务会在后台自动备份到服务器。浏览器清理站点数据后，用同一个成员码即可取回。服务器上的备份只增不删。
        </div>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] space-y-4 shadow-sm">
        <div className="block">
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">成员码</span>
          <input
            value={config.memberId}
            onChange={(e) => setConfig({ ...config, memberId: e.target.value })}
            onBlur={(e) => { void commitMemberId(e.target.value) }}
            disabled={running}
            placeholder="例如 wb-8f3a2c91"
            className={inputClassName}
          />
          <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
            {requiresMemberId
              ? '服务器上用于区分成员的数据空间的名字，请向部署者索取，或自己新建一个。'
              : '修改成员码会切换数据空间。服务器上没有这个码时会新建，并把本设备的内容备份过去；已有时会用服务器上的记录覆盖本地。'}
          </div>
        </div>

        <div className="rounded-xl bg-gray-50/80 px-3 py-2.5 dark:bg-white/[0.03]">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            <div>最后成功备份：{formatTime(status.lastSuccessAt)}</div>
            {running && <div className="mt-1">正在处理：{status.done} / {status.total}</div>}
            {!running && status.message && <div className="mt-1">{status.message}</div>}
            {status.error && <div className="mt-1 text-red-500">{status.error}</div>}
          </div>
        </div>

        {backupDisabled && (
          <div data-selectable-text className="text-xs text-amber-600 dark:text-amber-400">
            填写成员码后，本设备的内容会自动备份到服务器。
          </div>
        )}

        <button
          type="button"
          onClick={confirmSync}
          disabled={backupDisabled || running}
          className="w-full rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50 disabled:hover:bg-gray-100/80 disabled:hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white dark:disabled:hover:bg-white/[0.06] dark:disabled:hover:text-gray-300 flex items-center justify-center gap-2"
        >
          {running ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              同步中...
            </>
          ) : (
            '同步'
          )}
        </button>

        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          「同步」会用服务器上的数据整体替换本地数据，本地未备份的内容会丢失。
        </div>
      </div>
    </div>
  )
}
