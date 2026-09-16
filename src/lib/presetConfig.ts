import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../types'
import { readRuntimeEnv } from './runtimeEnv'

const RAW_SHOW_PRESET_CONFIG_ONLY = readRuntimeEnv(import.meta.env.VITE_SHOW_PRESET_CONFIG_ONLY)
const SHOW_PRESET_CONFIG_ONLY = (RAW_SHOW_PRESET_CONFIG_ONLY || readRuntimeEnv(import.meta.env.VITE_SHOW_DEFAULT_CONFIG_ONLY)) === 'true'
const LOCK_PRESET_CONFIG_PARAMS = readRuntimeEnv(import.meta.env.VITE_LOCK_PRESET_CONFIG_PARAMS) === 'true'
const PREVENT_PRESET_CONFIG_DELETION = readRuntimeEnv(import.meta.env.VITE_PREVENT_PRESET_CONFIG_DELETION) === 'true'
const LOCK_PRESET_KEY = readRuntimeEnv(import.meta.env.VITE_LOCK_PRESET_KEY) === 'true'
const HIDE_API_SETTINGS = readRuntimeEnv(import.meta.env.VITE_HIDE_API_SETTINGS) === 'true'
const BACKEND_FALLBACK = readRuntimeEnv(import.meta.env.VITE_BACKEND_FALLBACK) === 'true'

/** 隐藏整个 API 配置页，让用户没有前端配置的入口。 */
export function isApiSettingsHidden() {
  return HIDE_API_SETTINGS
}

/**
 * 部署端在后端持有 Key 时置真。
 *
 * 前端据此放宽「必须填 Key」的校验：用户不填不是漏了，而是本来就该由后端在代理时补上。
 * 它不参与任何锁定——前端自己配了 Key 依然优先。
 */
export function hasBackendFallback() {
  return BACKEND_FALLBACK
}

/**
 * 这份配置能不能直接拿去发请求。
 *
 * 用户填过 Key 就算可用；没填时，若部署端在后端持有 Key 也不该拦——请求经代理时后端会
 * 补上，前端再按「必须填 Key」判断就会永远挡住生成。
 */
export function hasUsableApiConfig(profile: Pick<ApiProfile, 'apiKey'>) {
  return BACKEND_FALLBACK || Boolean(profile.apiKey)
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
  return SHOW_PRESET_CONFIG_ONLY && presetProfiles.length > 0
}

export function isPresetConfigParamsLocked() {
  return LOCK_PRESET_CONFIG_PARAMS && presetProfiles.length > 0
}

export function isPresetConfigDeletionPrevented() {
  return (PREVENT_PRESET_CONFIG_DELETION || SHOW_PRESET_CONFIG_ONLY) && presetProfiles.length > 0
}

/**
 * API Key 是否被部署端锁住。
 *
 * 与 isPresetProfileLocked 是一对互补的开关：那个锁住除 Key 外的全部参数，这个只锁 Key。
 * 两者都只作用于预置配置——用户自己新建的配置不受影响。
 */
export function isPresetKeyLocked(id: string) {
  return LOCK_PRESET_KEY && isPresetProfile(id)
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
      // 锁住 Key 时清空本地值：这不是「保留用户的 Key」，而是宣布前端的 Key 不作数，
      // 让请求落到后端持有的 Key 上。
      apiKey: isPresetKeyLocked(profile.id) ? '' : profile.apiKey,
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
  const active = profiles.find((profile) => profile.id === activeProfileId)

  return {
    ...settings,
    // 顶层字段是旧版单配置的兼容层，实际请求以 active profile 为准，两者必须一起走。
    apiKey: active ? active.apiKey : settings.apiKey,
    customProviders,
    profiles,
    activeProfileId,
    agentTextProfileId,
    agentImageProfileId,
  }
}
