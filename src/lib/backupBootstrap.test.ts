import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBackupConfig,
  createMemberId,
  detectBackupServer,
  isBackupServerProbed,
  needsMemberIdOnboarding,
  resetBackupServerProbe,
} from './backupBridge'
import { DEFAULT_BACKUP_CONFIG, readBackupConfig } from './backupConfig'

// backupBridge 会把 store 与存储层一起拖进来，这里只验证引导与探测这两层的可观察行为。
vi.mock('../store', () => ({
  useStore: {
    getState: () => ({ showToast: () => {}, setSettings: () => {}, setState: () => {}, setTasks: () => {} }),
    setState: () => {},
    subscribe: () => () => {},
  },
}))
vi.mock('./db', () => ({
  getAllImageIds: async () => [],
  getAllTasks: async () => [],
  getImage: async () => undefined,
  putImage: async () => {},
  putTask: async () => {},
  clearImages: async () => {},
  clearTasks: async () => {},
  clearAgentConversations: async () => {},
  setImageStoredHook: () => {},
}))
vi.mock('./persistedState', () => ({ normalizePersistedState: () => null }))

/** 用内存 Map 顶替 localStorage，断言的是「配置真的被写下来了」。 */
function installMemoryStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  })
  return store
}

/** 服务器在 / 不在的两种世界，用同一个替身切换。 */
function stubServerReachable(reachable: boolean) {
  vi.stubGlobal('fetch', async () => reachable
    ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('nope', { status: 404 }))
}

beforeEach(() => {
  installMemoryStorage()
  vi.stubGlobal('window', { location: { origin: 'http://nas.local:3000' }, crypto: globalThis.crypto })
  resetBackupServerProbe()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetBackupServerProbe()
})

describe('成员码生成', () => {
  it('生成足够长的随机码，且不含容易看错的字符', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createMemberId()))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(id).toHaveLength(12)
      expect(id).not.toMatch(/[0O1lIo]/)
      expect(id).toMatch(/^[a-z2-9]+$/)
    }
  })
})

describe('服务器探测', () => {
  it('探测到服务器时返回可用，并把结果缓存下来', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    expect(await detectBackupServer()).toBe(true)
    expect(await detectBackupServer()).toBe(true)
    expect(calls).toBe(1)
  })

  it('探测不到时返回不可用，不抛错', async () => {
    stubServerReachable(false)

    expect(await detectBackupServer()).toBe(false)
    expect(isBackupServerProbed()).toBe(true)
  })

  it('服务器地址填了但连不上时也不抛错', async () => {
    applyBackupConfig({ memberId: 'member-a' })
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })

    expect(await detectBackupServer()).toBe(false)
  })
})

describe('备份地址由部署决定，不是用户设置', () => {
  it('始终按当前站点探测——应用与备份服务同源', async () => {
    let requested = ''
    vi.stubGlobal('fetch', async (url: string) => {
      requested = url
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    expect(await detectBackupServer()).toBe(true)
    expect(requested).toBe('http://nas.local:3000/api/backup/ping')
  })

  it('用户配置里根本没有地址这一项', () => {
    expect(Object.keys(DEFAULT_BACKUP_CONFIG)).toEqual(['memberId'])
  })
})

describe('首次引导的出现条件', () => {
  it('探到服务器且没有成员码时出现', async () => {
    stubServerReachable(true)
    await detectBackupServer()

    expect(needsMemberIdOnboarding()).toBe(true)
  })

  it('探不到服务器时永不出现——纯静态部署下这套 UI 不该露面', async () => {
    stubServerReachable(false)
    await detectBackupServer()

    expect(needsMemberIdOnboarding()).toBe(false)
  })

  it('探测还没回来时不出现，避免弹窗闪一下又消失', () => {
    expect(isBackupServerProbed()).toBe(false)
    expect(needsMemberIdOnboarding()).toBe(false)
  })

  it('已有成员码时不再引导', async () => {
    stubServerReachable(true)
    applyBackupConfig({ memberId: 'already-set' })
    await detectBackupServer()

    expect(needsMemberIdOnboarding()).toBe(false)
  })
})
