import { useEffect, useRef, useState } from 'react'

const PULL_THRESHOLD = 80
const MAX_PULL = 120

export default function PullToRefresh() {
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const startY = useRef(0)
  const isDragging = useRef(false)

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop
      if (scrollTop === 0) {
        startY.current = e.touches[0].clientY
        isDragging.current = true
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return

      const currentY = e.touches[0].clientY
      const distance = currentY - startY.current

      if (distance > 0) {
        e.preventDefault()
        const pull = Math.min(distance * 0.5, MAX_PULL)
        setPullDistance(pull)
      }
    }

    const handleTouchEnd = () => {
      if (!isDragging.current) return

      isDragging.current = false

      if (pullDistance >= PULL_THRESHOLD) {
        setIsRefreshing(true)
        setTimeout(() => {
          window.location.reload()
        }, 300)
      } else {
        setPullDistance(0)
      }
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true })
    document.addEventListener('touchmove', handleTouchMove, { passive: false })
    document.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [pullDistance])

  const opacity = Math.min(pullDistance / PULL_THRESHOLD, 1)
  const rotation = (pullDistance / MAX_PULL) * 360

  if (pullDistance === 0 && !isRefreshing) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 flex justify-center pointer-events-none z-[9998]"
      style={{ transform: `translateY(${Math.min(pullDistance - 40, 0)}px)` }}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-full p-3 shadow-lg"
        style={{ opacity }}
      >
        <svg
          className="h-6 w-6 text-blue-600 dark:text-blue-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          style={{
            transform: isRefreshing ? undefined : `rotate(${rotation}deg)`,
            animation: isRefreshing ? 'spin 1s linear infinite' : undefined,
          }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>
    </div>
  )
}
