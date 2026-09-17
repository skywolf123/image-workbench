import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '../icons'
import { useStore } from '../../store'
import { emptyServerTrash, fetchTrashEntries, restoreTrashEntry, type TrashEntrySummary } from '../../lib/syncEngine'
import { readSyncConfig } from '../../lib/syncConfig'

const inputClassName = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 服务器回收站弹窗：列出已删除任务，可逐条还原，或输入成员码清空全部。
 *
 * 清空需要输入成员码确认——这是不可恢复操作，值得一次打断式确认。
 */
export default function SyncTrashModal({ onClose }: { onClose: () => void }) {
  const showToast = useStore((s) => s.showToast)
  const [entries, setEntries] = useState<TrashEntrySummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [emptying, setEmptying] = useState(false)

  useEffect(() => {
    let alive = true
    fetchTrashEntries()
      .then((list) => {
        if (alive) setEntries(list)
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : '无法读取回收站')
      })
    return () => {
      alive = false
    }
  }, [])

  const restore = (entry: TrashEntrySummary) => {
    if (restoringId) return
    setRestoringId(entry.id)
    void restoreTrashEntry(entry.id)
      .then((restored) => {
        if (!restored) {
          showToast('这条任务已经不在回收站里了。', 'info')
        }
        // 还原后下一次同步会把它带回来，列表刷新后少一条。
        return fetchTrashEntries().then((list) => {
          setEntries(list)
          setError(null)
        })
      })
      .catch((err) => showToast(err instanceof Error ? err.message : '还原失败', 'error'))
      .finally(() => setRestoringId(null))
  }

  const empty = () => {
    if (emptying) return
    setEmptying(true)
    void emptyServerTrash()
      .then((removed) => {
        setEntries([])
        setConfirming(false)
        setConfirmInput('')
        showToast(`回收站已清空（${removed.tasks} 个任务）。`, 'success')
      })
      .catch((err) => showToast(err instanceof Error ? err.message : '清空失败', 'error'))
      .finally(() => setEmptying(false))
  }

  const memberId = readSyncConfig().memberId
  const confirmMatched = confirmInput.trim() === memberId

  return createPortal(
    <div data-no-drag-select className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" onClick={onClose} />
      <div
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-md w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          aria-label="关闭"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        {confirming ? (
          <>
            <h3 className="mb-3 pr-8 text-base font-bold text-gray-800 dark:text-gray-100 leading-snug">清空回收站</h3>
            <div className="text-[13px] text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
              将永久删除回收站里的 {entries?.length ?? 0} 个任务及其图片，任何设备都无法再还原。输入成员码确认。
            </div>
            <input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              disabled={emptying}
              autoFocus
              placeholder={memberId}
              className={`${inputClassName} text-center font-mono tracking-wide`}
            />
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false)
                  setConfirmInput('')
                }}
                disabled={emptying}
                className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={empty}
                disabled={!confirmMatched || emptying}
                className="flex-1 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {emptying ? '正在清空…' : '永久删除'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-3 pr-8 text-base font-bold text-gray-800 dark:text-gray-100 leading-snug">回收站</h3>
            {entries === null && !error && <div className="py-6 text-center text-sm text-gray-400">读取中…</div>}
            {error && <div className="py-6 text-center text-sm text-red-500">{error}</div>}
            {entries !== null && entries.length === 0 && (
              <div className="py-6 text-center text-sm text-gray-400">回收站是空的。删除的任务会先回到这里，在彻底清空前随时可以还原。</div>
            )}
            {entries !== null && entries.length > 0 && (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 rounded-xl bg-gray-50/80 px-3 py-2.5 dark:bg-white/[0.03]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-gray-700 dark:text-gray-200">{entry.prompt || '（无提示词）'}</div>
                      <div className="mt-0.5 text-xs text-gray-400">
                        {entry.imageCount} 张图片 · {formatTime(entry.deletedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => restore(entry)}
                      disabled={restoringId !== null}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-blue-500 transition hover:bg-blue-500/10 disabled:opacity-50"
                    >
                      {restoringId === entry.id ? '还原中…' : '还原'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={entries === null || entries.length === 0}
                className="flex-1 rounded-xl bg-red-500/90 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                清空回收站
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
