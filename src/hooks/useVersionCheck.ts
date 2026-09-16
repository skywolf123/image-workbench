import { useState, useEffect } from 'react'
import { compareVersions } from '../lib/versionCompare'

const REPO = 'skywolf123/image-workbench'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export interface LatestRelease {
  tag: string
  url: string
}

/**
 * 检查 GitHub 最新 Release 版本。
 * - 仅当最新 Release 版本高于当前 __APP_VERSION__ 时提示。
 * - 用户点击后调用 dismiss()，本次浏览期间不再提示（sessionStorage）。
 * - 刷新页面后重新检查。
 */
export function useVersionCheck() {
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null)
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('version-dismissed') === 'true',
  )

  useEffect(() => {
    let cancelled = false

    fetch(API_URL, { headers: { Accept: 'application/vnd.github.v3+json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const tag: string = data.tag_name ?? ''
        const version = tag.replace(/^v/, '')
        if (version && compareVersions(version, __APP_VERSION__) > 0) {
          setLatestRelease({
            tag,
            url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
          })
        }
      })
      .catch(() => {
        /* 静默失败，不影响正常使用 */
      })

    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('version-dismissed', 'true')
  }

  const hasUpdate = latestRelease !== null && !dismissed

  return { hasUpdate, latestRelease, dismiss }
}
