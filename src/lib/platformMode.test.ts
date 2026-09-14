import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadPolicy() {
  const { createDefaultFalProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
  const policy = await import('./presetConfig')
  policy.setPresetConfig({
    customProviders: [],
    profiles: [createDefaultOpenAIProfile({ id: 'preset-a', isDefault: true }), createDefaultFalProfile({ id: 'preset-b' })],
  })
  return { policy, createDefaultFalProfile, createDefaultOpenAIProfile }
}

describe('platform mode', () => {
  it('is off by default so the upstream behavior stays byte-for-byte identical', async () => {
    const { policy } = await loadPolicy()

    expect(policy.isPlatformMode()).toBe(false)
    expect(policy.shouldHideApiKeyField()).toBe(false)
    expect(policy.requiresApiKey()).toBe(true)
    expect(policy.isPresetConfigOnlyEnabled()).toBe(false)
    expect(policy.isPresetConfigParamsLocked()).toBe(false)
    expect(policy.isPresetConfigDeletionPrevented()).toBe(false)
  })

  it('turns on through the build-time switch and hides the API key field', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const { policy } = await loadPolicy()

    expect(policy.isPlatformMode()).toBe(true)
    expect(policy.shouldHideApiKeyField()).toBe(true)
    expect(policy.requiresApiKey()).toBe(false)
  })

  it('drives the strongest lock level instead of competing with the upstream switches', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const { policy } = await loadPolicy()

    expect(policy.isPresetConfigOnlyEnabled()).toBe(true)
    expect(policy.isPresetConfigParamsLocked()).toBe(true)
    expect(policy.isPresetConfigDeletionPrevented()).toBe(true)
    expect(policy.isPresetProfileLocked('preset-a')).toBe(true)
    expect(policy.isPresetProfileLocked('user-profile')).toBe(false)
  })

  it('does not impose the lock level without preset profiles to lock', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const policy = await import('./presetConfig')
    policy.setPresetConfig(null)

    expect(policy.isPlatformMode()).toBe(true)
    expect(policy.isPresetConfigOnlyEnabled()).toBe(false)
    expect(policy.isPresetConfigParamsLocked()).toBe(false)
    expect(policy.isPresetConfigDeletionPrevented()).toBe(false)
  })
})

describe('platform mode API key policy', () => {
  it('accepts a profile without an API key', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const { validateApiProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    await import('./presetConfig')

    expect(validateApiProfile(createDefaultOpenAIProfile({ apiKey: '' }))).toBeNull()
  })

  it('keeps requiring the API key without platform mode', async () => {
    const { validateApiProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    await import('./presetConfig')

    expect(validateApiProfile(createDefaultOpenAIProfile({ apiKey: '' }))).toBe('缺少 API Key')
  })

  it('still reports the other missing fields in platform mode', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const { validateApiProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')
    await import('./presetConfig')

    expect(validateApiProfile(createDefaultOpenAIProfile({ apiKey: '', name: '' }))).toBe('缺少名称')
  })

  it('wipes a deployment API key out of both the top level and the profiles array', async () => {
    vi.stubEnv('VITE_PLATFORM_MODE', 'true')
    const { normalizeSettings } = await import('./apiProfiles')
    const policy = await import('./presetConfig')
    const { createDefaultFalProfile, createDefaultOpenAIProfile } = await import('./apiProfiles')

    policy.setPresetConfig({ customProviders: [], profiles: [createDefaultOpenAIProfile({ id: 'preset-a' })] })
    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      apiKey: 'sneaked-top-level-key',
      profiles: [
        createDefaultOpenAIProfile({ id: 'preset-a', apiKey: 'sneaked-in-preset' }),
        createDefaultFalProfile({ id: 'user-profile', apiKey: 'sneaked-in-user-profile' }),
      ],
    }))

    expect(enforced.apiKey).toBe('')
    expect(enforced.profiles.map((profile) => profile.apiKey)).toEqual(['', ''])
  })

  it('leaves the API keys untouched without platform mode', async () => {
    const { normalizeSettings, createDefaultOpenAIProfile } = await import('./apiProfiles')
    const policy = await import('./presetConfig')

    policy.setPresetConfig({ customProviders: [], profiles: [createDefaultOpenAIProfile({ id: 'preset-a' })] })
    const enforced = policy.enforcePresetConfigPolicy(normalizeSettings({
      profiles: [createDefaultOpenAIProfile({ id: 'preset-a', apiKey: 'user-key' })],
    }))

    expect(enforced.profiles[0].apiKey).toBe('user-key')
  })
})
