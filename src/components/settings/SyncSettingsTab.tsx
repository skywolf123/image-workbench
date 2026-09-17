import { useEffect, useState } from 'react'
import { adoptMemberId, applySyncConfig, hasSyncServer } from '../../lib/syncBridge'
import { getSyncStatus, runSyncNow, subscribeSyncStatus, type SyncStatus } from '../../lib/syncEngine'
import { readSyncConfig, type SyncConfig } from '../../lib/syncConfig'
import { useStore } from '../../store'
import SyncTrashModal from './SyncTrashModal'

function formatTime(timestamp: number | null) {
  if (!timestamp) return '尚未同步'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const inputClassName = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'

export default function SyncSettingsTab() {
  const showToast = useStore((s) => s.showToast)
  const [config, setConfig] = useState<SyncConfig>(() => readSyncConfig())
  const [status, setStatus] = useState<SyncStatus>(() => getSyncStatus())
  const [busy, setBusy] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)

  useEffect(() => subscribeSyncStatus(setStatus), [])

  const requiresMemberId = !config.memberId
  const syncDisabled = requiresMemberId

  /** 配置一旦改动就立即生效，客户端后续请求会带上新值。 */
  const persist = (next: SyncConfig) => {
    setConfig(next)
    applySyncConfig(next)
  }

  /**
   * 切换成员码。
   *
   * 合并语义没有破坏性：本地任务推上去、服务器的活跃集拉下来，两边取并集。
   * 服务器上有这个码就接着用，没有就自动新建，不需要任何「覆盖本地」确认。
   */
  const commitMemberId = (nextMemberId: string) => {
    const trimmed = nextMemberId.trim()
    if (!trimmed || trimmed === config.memberId) return

    setBusy(true)
    void adoptMemberId(trimmed)
      .then(() => showToast('成员码已启用，数据已同步。', 'success'))
      .catch(() => {
        // 失败原因已经写入状态并在面板上展示；定时同步会自动重试。
      })
      .finally(() => setBusy(false))
  }

  const syncNow = () => {
    setBusy(true)
    void runSyncNow()
      .then((outcome) => {
        if (outcome) showToast('同步完成。', 'success')
      })
      .finally(() => setBusy(false))
  }

  const running = busy || status.running
  const serverReady = hasSyncServer() && !requiresMemberId

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-gray-50/80 p-4 border border-gray-200/60 dark:bg-white/[0.02] dark:border-white/[0.05] flex items-start gap-3">
        <svg className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <div className="text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
          填写成员码后，任务与图片会在本设备和服务器之间自动同步：每次操作后、每分钟、以及页面关闭前都会同步。会话、收藏夹与设置只保存在本机。
        </div>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] space-y-4 shadow-sm">
        <div className="block">
          <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">成员码</span>
          <input
            value={config.memberId}
            onChange={(e) => setConfig({ ...config, memberId: e.target.value })}
            onBlur={(e) => commitMemberId(e.target.value)}
            disabled={running}
            placeholder="例如 wb-8f3a2c91"
            className={inputClassName}
          />
          <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
            {requiresMemberId
              ? '服务器上用于区分成员的数据空间的名字，请向部署者索取，或自己新建一个。'
              : '修改成员码会切换数据空间：两边的内容会合并，删除过的任务可以在服务器回收站里找回。'}
          </div>
        </div>

        <div className="rounded-xl bg-gray-50/80 px-3 py-2.5 dark:bg-white/[0.03]">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            <div>上次同步：{formatTime(status.lastSuccessAt)}</div>
            {running && <div className="mt-1">正在处理：{status.done} / {status.total}</div>}
            {!running && status.message && <div className="mt-1">{status.message}</div>}
            {status.error && <div className="mt-1 text-red-500">{status.error}</div>}
          </div>
        </div>

        {syncDisabled && (
          <div data-selectable-text className="text-xs text-amber-600 dark:text-amber-400">
            填写成员码后，本设备的内容会自动同步到服务器。
          </div>
        )}

        <button
          type="button"
          onClick={syncNow}
          disabled={syncDisabled || running}
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
            '立即同步'
          )}
        </button>

        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          disabled={!serverReady}
          className="w-full rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50 disabled:hover:bg-gray-100/80 disabled:hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white dark:disabled:hover:bg-white/[0.06] dark:disabled:hover:text-gray-300"
        >
          回收站
        </button>
      </div>

      {trashOpen && <SyncTrashModal onClose={() => setTrashOpen(false)} />}
    </div>
  )
}
