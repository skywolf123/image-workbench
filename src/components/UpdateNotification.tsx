import { useEffect, useState } from 'react'

export default function UpdateNotification() {
  const [showUpdate, setShowUpdate] = useState(false)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      setRegistration(reg)
      setShowUpdate(true)
    }

    navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            handleUpdate(reg)
          }
        })
      })
    })

    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })
  }, [])

  const handleRefresh = () => {
    if (!registration?.waiting) return
    registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  if (!showUpdate) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-blue-600 text-white px-4 py-3 flex items-center justify-between shadow-lg">
      <div className="flex items-center gap-2">
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span className="text-sm font-medium">发现新版本</span>
      </div>
      <button
        onClick={handleRefresh}
        className="bg-white text-blue-600 px-4 py-1.5 rounded-md text-sm font-semibold hover:bg-blue-50 transition-colors"
      >
        立即更新
      </button>
    </div>
  )
}
