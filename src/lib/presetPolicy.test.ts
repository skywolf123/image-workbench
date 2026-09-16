import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enforcePresetConfigPolicy, hasUsableApiConfig, isApiSettingsHidden, isPresetKeyLocked, setPresetConfig } from './presetConfig'
import type { AppSettings } from '../types'

/** 构建期开关由 import.meta.env 静态替换，测试里用 stubEnv + 动态导入来切换。 */
async function loadWithEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  return import('./presetConfig')
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'local-key',
    model: 'test-model',
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    customProviders: [],
    profiles: [{
      id: 'default-openai',
      name: '默认',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'local-key',
      model: 'test-model',
      imageGenerationModel: 'test-model',
      timeout: 600,
      apiMode: 'images',
      codexCli: false,
      apiProxy: false,
      streamImages: false,
      streamPartialImages: 0,
      transparentBackgroundMethod: 'api',
    }],
    activeProfileId: 'default-openai',
    ...overrides,
  } as AppSettings
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  setPresetConfig(null)
})

describe('默认不改变上游行为', () => {
  it('未注入任何开关时，隐藏与锁 Key 都不生效', async () => {
    const mod = await loadWithEnv({})
    expect(mod.isApiSettingsHidden()).toBe(false)
    expect(mod.hasBackendFallback()).toBe(false)
    expect(mod.hasUsableApiConfig({ apiKey: '' })).toBe(false)
  })

  it('上游的锁定开关行为不变', async () => {
    const mod = await loadWithEnv({})
    expect(mod.isPresetConfigOnlyEnabled()).toBe(false)
    expect(mod.isPresetConfigParamsLocked()).toBe(false)
    expect(mod.isPresetConfigDeletionPrevented()).toBe(false)
  })
})

describe('后端兜底只放宽校验，不参与锁定', () => {
  it('有后端兜底时，Key 为空也算可用', async () => {
    const mod = await loadWithEnv({ VITE_BACKEND_FALLBACK: 'true' })
    expect(mod.hasBackendFallback()).toBe(true)
    expect(mod.hasUsableApiConfig({ apiKey: '' })).toBe(true)
    expect(mod.hasUsableApiConfig({ apiKey: 'sk-own' })).toBe(true)
  })

  it('后端兜底不会连带锁住参数', async () => {
    const mod = await loadWithEnv({ VITE_BACKEND_FALLBACK: 'true' })
    mod.setPresetConfig({ customProviders: [], profiles: makeSettings().profiles })
    expect(mod.isPresetConfigParamsLocked()).toBe(false)
    expect(mod.isPresetConfigOnlyEnabled()).toBe(false)
  })
})

describe('LOCK_PRESET_KEY 只作用于预置配置的 Key', () => {
  it('开启后清空预置配置的本地 Key，让请求落到后端', async () => {
    const mod = await loadWithEnv({ VITE_LOCK_PRESET_KEY: 'true' })
    mod.setPresetConfig({ customProviders: [], profiles: makeSettings().profiles })
    expect(mod.isPresetKeyLocked('default-openai')).toBe(true)

    const settings = makeSettings()
    const next = mod.enforcePresetConfigPolicy(settings)
    expect(next.profiles[0].apiKey).toBe('')
    // 顶层兼容层与实际配置必须一起清。
    expect(next.apiKey).toBe('')
  })

  it('不开启时保留用户填的 Key', async () => {
    const mod = await loadWithEnv({})
    mod.setPresetConfig({ customProviders: [], profiles: makeSettings().profiles })

    const next = mod.enforcePresetConfigPolicy(makeSettings())
    expect(next.profiles[0].apiKey).toBe('local-key')
    expect(next.apiKey).toBe('local-key')
  })

  it('不锁预置配置之外的配置', async () => {
    const mod = await loadWithEnv({ VITE_LOCK_PRESET_KEY: 'true' })
    mod.setPresetConfig({ customProviders: [], profiles: makeSettings().profiles })

    const settings = makeSettings({
      profiles: [
        ...makeSettings().profiles,
        { ...makeSettings().profiles[0], id: 'mine', apiKey: 'my-own-key' },
      ],
    })
    const next = mod.enforcePresetConfigPolicy(settings)
    expect(next.profiles.find((p) => p.id === 'mine')?.apiKey).toBe('my-own-key')
  })

  it('没有预置配置时开关不生效', async () => {
    const mod = await loadWithEnv({ VITE_LOCK_PRESET_KEY: 'true' })
    mod.setPresetConfig(null)
    expect(mod.isPresetKeyLocked('default-openai')).toBe(false)
  })
})

describe('HIDE_API_SETTINGS 独立于 Key 锁定', () => {
  it('开启后隐藏配置页', async () => {
    const mod = await loadWithEnv({ VITE_HIDE_API_SETTINGS: 'true' })
    expect(mod.isApiSettingsHidden()).toBe(true)
  })

  it('只隐藏页面不会清空本地 Key', async () => {
    const mod = await loadWithEnv({ VITE_HIDE_API_SETTINGS: 'true' })
    mod.setPresetConfig({ customProviders: [], profiles: makeSettings().profiles })

    const next = mod.enforcePresetConfigPolicy(makeSettings())
    expect(next.profiles[0].apiKey).toBe('local-key')
  })
})
