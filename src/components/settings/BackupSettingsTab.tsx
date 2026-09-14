import { useEffect, useState } from 'react'
import { applyBackupConfig } from '../../lib/backupBridge'
import {
  getBackupStatus,
  runBackupNow,
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
  const backupDisabled = !config.enabled || !config.serverUrl || requiresMemberId

  const persist = (next: BackupConfig) => {
    setConfig(next)
    applyBackupConfig(next)
  }

  /** 改成员码等于切换命名空间，必须让用户知情后再手动同步。 */
  const commitMemberId = (nextMemberId: string) => {
    const trimmed = nextMemberId.trim()
    if (trimmed === config.memberId) return
    if (!config.memberId) {
      persist({ ...config, memberId: trimmed })
      return
    }
    setConfirmDialog({
      title: '更换成员码',
      message: '成员码决定你在服务器上的数据空间。修改后需要手动触发一次同步，才能把新空间的数据取回本地。\n\n这次同步是单向的（服务器 → 本地），会以服务器数据更新本地，本地未备份的内容将丢失。\n\n确认要更换吗？',
      confirmText: '确认更换',
      icon: 'info',
      action: () => persist({ ...config, memberId: trimmed }),
      cancelAction: () => {},
    })
  }

  const triggerBackup = async () => {
    setBusy(true)
    try {
      const outcome = await runBackupNow()
      showToast(`备份完成：${outcome.images} 张图片（快照版本 ${outcome.version}）`, 'success')
    } catch {
      // 失败原因已经写入状态并在面板上展示。
    } finally {
      setBusy(false)
    }
  }

  const triggerRestore = async () => {
    setBusy(true)
    try {
      const outcome = await runRestore()
      showToast(`恢复完成：${outcome.images} 张图片、${outcome.tasks} 个任务`, 'success')
    } catch {
      // 同上。
    } finally {
      setBusy(false)
    }
  }

  const running = busy || status.running

  return (
    <div className="space-y-4">
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">启用自动备份</span>
          <button
            type="button"
            onClick={() => persist({ ...config, enabled: !config.enabled })}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${config.enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={config.enabled}
            aria-label="启用自动备份"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${config.enabled ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          开启后，新生成的图片与任务记录会在后台自动上传到备份服务器。浏览器存储被清空时，可以用下面的「立即恢复」取回数据。
        </div>
      </div>

      <div className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">备份服务器地址</span>
        <input
          value={config.serverUrl}
          onChange={(e) => setConfig({ ...config, serverUrl: e.target.value })}
          onBlur={(e) => persist({ ...config, serverUrl: e.target.value.trim() })}
          placeholder="http://nas.local:3000"
          className={inputClassName}
        />
        <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
          部署了平台服务端时的访问地址。留空表示不使用备份。
        </div>
      </div>

      <div className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">成员码</span>
        <input
          value={config.memberId}
          onChange={(e) => setConfig({ ...config, memberId: e.target.value })}
          onBlur={(e) => commitMemberId(e.target.value)}
          placeholder="例如 wb-8f3a2c91"
          className={inputClassName}
        />
        <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
          {requiresMemberId
            ? '首次使用请填写一个成员码，它只是服务器上区分家人的数据空间的名字，不会上传给任何第三方。建议用随机字符串，避免被猜到。'
            : '成员码决定你在服务器上的数据空间。修改后需要手动触发一次同步，这次同步是单向的（服务器 → 本地），会以服务器数据更新本地，本地未备份的内容将丢失。'}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200/60 bg-white/40 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="text-xs text-gray-600 dark:text-gray-300">
          <div>最后成功备份：{formatTime(status.lastSuccessAt)}</div>
          {running && <div className="mt-1">正在处理：{status.done} / {status.total}</div>}
          {!running && status.message && <div className="mt-1">{status.message}</div>}
          {status.error && <div className="mt-1 text-red-500">{status.error}</div>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={triggerBackup}
          disabled={backupDisabled || running}
          className="rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
        >
          立即备份
        </button>
        <button
          type="button"
          onClick={triggerRestore}
          disabled={backupDisabled || running}
          className="rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
        >
          立即恢复
        </button>
      </div>

      {backupDisabled && (
        <div data-selectable-text className="text-xs text-amber-600 dark:text-amber-400">
          {requiresMemberId
            ? '请先填写成员码，备份功能才会开始工作。未启用备份时，应用的其余功能不受影响。'
            : '请先开启自动备份并填写服务器地址，备份功能才会开始工作。'}
        </div>
      )}

      {!config.enabled && !requiresMemberId && (
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          备份已关闭。应用其余功能不受影响，本地数据仍只会保存在浏览器里。
        </div>
      )}

      <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
        恢复只会补上本地缺少的数据，不会覆盖或删除本地已有内容，因此重复执行是安全的。备份服务器上的图片只增不删。
      </div>
    </div>
  )
}
