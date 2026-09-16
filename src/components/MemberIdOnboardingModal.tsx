import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { useStore } from '../store'
import { adoptMemberId, createMemberId, needsMemberIdOnboarding, subscribeBackupServerProbe } from '../lib/backupBridge'

/**
 * 首次打开时的成员码引导。
 *
 * 成员码是这台设备在服务器上的数据空间名字，需要用户看到并告知同组成员，所以在这里
 * **展示**而不是静默生成。确认后：服务器上已有这个码就同步一次把数据取回来，没有就
 * 新建并把本地内容备份到这个码下。
 *
 * 只有探到备份服务器时才会出现——探不到说明是纯静态部署，这套东西不该露面。
 */
export default function MemberIdOnboardingModal() {
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [dismissed, setDismissed] = useState(false)
  const [visible, setVisible] = useState(() => needsMemberIdOnboarding())
  const [memberId, setMemberId] = useState(() => createMemberId())
  const [submitting, setSubmitting] = useState(false)

  // 探测是异步的：结果回来时才知道该不该显示。
  useEffect(() => subscribeBackupServerProbe(() => setVisible(needsMemberIdOnboarding())), [])

  if (dismissed || !visible) return null

  const done = (message: string) => {
    setConfirmDialog({ title: '已开始使用', message, confirmText: '知道了', showCancel: false, icon: 'info', action: () => {}, cancelAction: () => {} })
    setDismissed(true)
  }

  const confirm = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await adoptMemberId(memberId)
      done(result === 'synced'
        ? '成员码已启用，服务器上的数据已同步到本地。'
        : '成员码已启用，设备上的内容已备份到这个码下。')
    } catch {
      // 同步失败的细节会以 toast 与设置面板里的状态呈现，这里只说明下一步该做什么。
      done('成员码已保存，但服务器同步失败。可稍后在设置的备份标签页点「同步」重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div data-no-drag-select className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="absolute right-4 top-4 shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          aria-label="稍后设置"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        <h3 className="mb-3 pr-8 text-base font-bold text-gray-800 dark:text-gray-100 leading-snug">开始使用</h3>
        <div className="text-[13px] text-gray-500 dark:text-gray-400 mb-5 leading-relaxed">
          这是你在服务器上的数据空间名称。把它告诉同组成员，大家用同一个码，图片与任务就会备份到同一处。
        </div>

        <input
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          disabled={submitting}
          autoFocus
          onFocus={(e) => e.target.select()}
          className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-center font-mono text-sm tracking-wide text-gray-700 outline-none transition focus:border-blue-300 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        <div data-selectable-text className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
          可以保留这个随机码，也可以改成自己好记的。改成服务器上已有的码会同步那个空间的数据过来。
        </div>

        <button
          onClick={confirm}
          disabled={submitting || !memberId.trim()}
          className="mt-5 w-full py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition shadow-sm shadow-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '正在检查服务器…' : '开始使用'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
