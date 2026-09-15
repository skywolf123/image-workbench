import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../types'
import { readRuntimeEnv } from './runtimeEnv'

const RAW_SHOW_PRESET_CONFIG_ONLY = readRuntimeEnv(import.meta.env.VITE_SHOW_PRESET_CONFIG_ONLY)
const SHOW_PRESET_CONFIG_ONLY = (RAW_SHOW_PRESET_CONFIG_ONLY || readRuntimeEnv(import.meta.env.VITE_SHOW_DEFAULT_CONFIG_ONLY)) === 'true'
const LOCK_PRESET_CONFIG_PARAMS = readRuntimeEnv(import.meta.env.VITE_LOCK_PRESET_CONFIG_PARAMS) === 'true'
const PREVENT_PRESET_CONFIG_DELETION = readRuntimeEnv(import.meta.env.VITE_PREVENT_PRESET_CONFIG_DELETION) === 'true'

/**
 * 平台模式的构建期开关。
 *
 * 它只决定界面的形态（隐藏哪些字段、放宽哪些校验），不承载平台配置本身的数据——
 * 上游地址与模型仍走预置配置 JSON，平台 Key 只存在于服务端进程里。因此它不违反
 * 「同一份构建产物支持两种部署形态」这条约束。
 */
const PLATFORM_MODE = readRuntimeEnv(import.meta.env.VITE_PLATFORM_MODE) === 'true'

let platformModeOverride: boolean | null = null

/** 只供测试覆盖，让不经过构建期开关的用例也能验证平台模式分支。 */
export function setPlatformModeForTests(value: boolean | null) {
  platformModeOverride = value
}

/**
 * 平台模式的唯一出口。其余代码只读这个函数，不各自判断环境变量，回退路径只需要在这一处验证。
 * 平台模式在上游锁定机制上叠加一档更硬的锁定，而不是与之并行的第二套体系。
 */
export function isPlatformMode() {
  return platformModeOverride ?? PLATFORM_MODE
}

/**
 * 这份配置能不能直接拿去发请求。
 *
 * 非平台模式下要求用户填过 Key，否则提交按钮会引导去设置页；平台模式下 Key 由服务端在
 * 代理时注入，前端恒为空，再按 Key 判断就会永远认为「未配置」而挡住生成。
 */
export function hasUsableApiConfig(profile: Pick<ApiProfile, 'apiKey'>) {
  return isPlatformMode() || Boolean(profile.apiKey)
}

let presetProfiles: ApiProfile[] = []
let presetProviders: CustomProviderDefinition[] = []
let presetProfileFields: Record<string, string[]> | undefined
let defaultPresetProfileId: string | null = null

export function setPresetConfig(settings: Pick<AppSettings, 'customProviders' | 'profiles'> & {
  presetProfileFields?: Record<string, string[]>
} | null) {
  presetProfiles = settings?.profiles.map((profile) => ({ ...profile })) ?? []
  presetProviders = settings?.customProviders.map((provider) => ({ ...provider })) ?? []
  presetProfileFields = settings?.presetProfileFields
  defaultPresetProfileId = presetProfiles.length === 1
    ? presetProfiles[0].id
    : presetProfiles.find((profile) => profile.isDefault === true)?.id ?? null
}

export function getPresetProfileIds() {
  return new Set(presetProfiles.map((profile) => profile.id))
}

export function getPresetProfileDescription(id: string) {
  return presetProfiles.find((profile) => profile.id === id)?.description
}

export function getPresetProviderIds() {
  return new Set(presetProviders.map((provider) => provider.id))
}

export function getPresetConfig() {
  if (presetProfiles.length === 0 && presetProviders.length === 0) return null
  return {
    customProviders: presetProviders.map((provider) => ({ ...provider })),
    profiles: presetProfiles.map((profile) => ({ ...profile })),
    presetProfileFields,
  }
}

export function getDefaultPresetProfileId() {
  return defaultPresetProfileId
}

export function getDefaultPresetBaseUrl() {
  const profile = presetProfiles.find((profile) => profile.id === defaultPresetProfileId)
  if (!profile || profile.provider === 'fal') return ''
  return profile.baseUrl
}

export function isPresetProfile(id: string) {
  return presetProfiles.some((profile) => profile.id === id)
}

export function isPresetProvider(id: string) {
  return presetProviders.some((provider) => provider.id === id)
}

export function isPresetConfigOnlyEnabled() {
  return (SHOW_PRESET_CONFIG_ONLY || PLATFORM_MODE) && presetProfiles.length > 0
}

export function isPresetConfigParamsLocked() {
  return (LOCK_PRESET_CONFIG_PARAMS || PLATFORM_MODE) && presetProfiles.length > 0
}

export function isPresetConfigDeletionPrevented() {
  return (PREVENT_PRESET_CONFIG_DELETION || SHOW_PRESET_CONFIG_ONLY || PLATFORM_MODE) && presetProfiles.length > 0
}

export function isPresetProfileLocked(id: string) {
  return isPresetConfigParamsLocked() && isPresetProfile(id)
}

export function isPresetProviderLocked(id: string) {
  return isPresetConfigParamsLocked() && isPresetProvider(id)
}

export function isPresetProviderDeletionPrevented(id: string, profiles: ApiProfile[]) {
  if (!isPresetProvider(id)) return false
  if (isPresetConfigDeletionPrevented()) return true
  return profiles.some((profile) => profile.provider === id && isPresetProfileLocked(profile.id))
}

export function enforcePresetConfigPolicy(
  settings: AppSettings,
  options: { dismissedPresetProviderIds?: string[] } = {},
): AppSettings {
  const presetConfigOnly = isPresetConfigOnlyEnabled()
  const paramsLocked = isPresetConfigParamsLocked()
  if (presetProfiles.length === 0) return settings

  const dismissedProviderIds = new Set(options.dismissedPresetProviderIds ?? [])
  const profileIds = getPresetProfileIds()
  const presetProfilesById = new Map(presetProfiles.map((profile) => [profile.id, profile]))
  const presetProvidersById = new Map(presetProviders.map((provider) => [provider.id, provider]))
  const profiles = settings.profiles.map((profile) => {
    const preset = presetProfilesById.get(profile.id)
    if (!preset) return profile.isDefault ? { ...profile, isDefault: undefined } : profile
    return {
      ...(paramsLocked ? preset : profile),
      apiKey: profile.apiKey,
      provider: paramsLocked || presetConfigOnly ? preset.provider : profile.provider,
      isDefault: profile.id === defaultPresetProfileId ? true : undefined,
    }
  })
  if (isPresetConfigDeletionPrevented()) {
    for (const profile of presetProfiles) {
      if (!profiles.some((item) => item.id === profile.id)) profiles.push({ ...profile, isDefault: profile.id === defaultPresetProfileId ? true : undefined })
    }
  }
  const customProviders = settings.customProviders.filter((provider) => !dismissedProviderIds.has(provider.id)).map((provider) => {
    const preset = presetProvidersById.get(provider.id)
    return preset && paramsLocked ? preset : provider
  })
  for (const provider of presetProviders) {
    if (dismissedProviderIds.has(provider.id)) continue
    if (!customProviders.some((item) => item.id === provider.id)) customProviders.push(provider)
  }
  const activeProfileId = presetConfigOnly && !profileIds.has(settings.activeProfileId)
    ? defaultPresetProfileId ?? presetProfiles[0]?.id ?? settings.activeProfileId
    : settings.activeProfileId
  const agentTextProfileId = presetConfigOnly && (!settings.agentTextProfileId || !profileIds.has(settings.agentTextProfileId))
    ? presetProfiles.find((profile) => profile.provider === 'openai' && profile.apiMode === 'responses')?.id ?? null
    : settings.agentTextProfileId
  const agentImageProfileId = presetConfigOnly && (!settings.agentImageProfileId || !profileIds.has(settings.agentImageProfileId))
    ? defaultPresetProfileId ?? presetProfiles[0]?.id ?? null
    : settings.agentImageProfileId
  // 深度防御：平台模式下 Key 只应存在于服务端进程，预置配置里即便被人为塞入也会在这里被清空。
  const nextProfiles = stripDeploymentApiKeys(profiles)
  const active = nextProfiles.find((profile) => profile.id === activeProfileId)

  return {
    ...settings,
    // 顶层字段是旧版单配置的兼容层，实际请求以 active profile 为准，两者必须一起清。
    apiKey: active ? active.apiKey : settings.apiKey,
    customProviders,
    profiles: nextProfiles,
    activeProfileId,
    agentTextProfileId,
    agentImageProfileId,
  }
}

function stripDeploymentApiKeys(profiles: ApiProfile[]) {
  if (!isPlatformMode()) return profiles
  return profiles.map((profile) => (profile.apiKey ? { ...profile, apiKey: '' } : profile))
}
