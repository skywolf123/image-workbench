import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { requestPersistentStorage } from './lib/storagePersistence'
import { detectBackupServer, initBackup } from './lib/backupBridge'

installMobileViewportGuards()
initBackup()
// 探测是异步的：结果既决定首次引导弹窗出不出现，也决定设置页里有没有「备份」标签。
void detectBackupServer()

if (import.meta.env.PROD) {
  void requestPersistentStorage()
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
