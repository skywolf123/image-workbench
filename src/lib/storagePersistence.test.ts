// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage } from './storagePersistence'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('requestPersistentStorage', () => {
  it('reports the browser decision when the permission is granted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', { storage: { persist } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns that local data is still evictable when the permission is denied', async () => {
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(false) } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(requestPersistentStorage()).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('持久化存储未获授权'))
  })

  it('reports an unknown result without throwing when the API is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(requestPersistentStorage()).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports an unknown result without throwing when the request fails', async () => {
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockRejectedValue(new Error('denied')) } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(requestPersistentStorage()).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
