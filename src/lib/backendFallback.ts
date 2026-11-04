import { readRuntimeEnv } from './runtimeEnv'

/**
 * 部署端在后端持有 Key（GATEWAY_API_KEY）时置真。
 *
 * 单独成模块而不是放在 presetConfig 里：vite.config.ts 需要这份判定，经 presetConfig
 * 会连带把 apiProfiles、字体资源拖进配置打包上下文。
 */
const BACKEND_FALLBACK = readRuntimeEnv(import.meta.env?.VITE_BACKEND_FALLBACK) === 'true'

export function hasBackendFallback() {
  return BACKEND_FALLBACK
}
