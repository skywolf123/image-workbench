/**
 * 向浏览器申请持久化存储权限。
 *
 * 这只能降低被驱逐的概率，不是保证：浏览器可以拒绝，静默驱逐的威胁不会因此消失。
 * 返回 null 表示当前环境无法判断（API 不存在或调用失败）。
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') return null

  try {
    const granted = await navigator.storage.persist()
    if (!granted) {
      console.warn('[storage] 持久化存储未获授权，浏览器仍可能在磁盘紧张时清除本地数据，请依赖备份。')
    }
    return granted
  } catch (error) {
    console.warn('[storage] 持久化存储申请失败：', error)
    return null
  }
}
