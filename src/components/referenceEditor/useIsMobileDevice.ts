import { useEffect, useState } from 'react'

export function useIsMobileDevice() {
  const getIsMobileDevice = () => {
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    const isIpadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua) || isIpadOS
  }
  const [isMobileDevice, setIsMobileDevice] = useState(getIsMobileDevice)
  useEffect(() => {
    const update = () => setIsMobileDevice(getIsMobileDevice())
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return isMobileDevice
}
