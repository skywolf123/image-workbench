import { readRuntimeEnv } from './runtimeEnv'
import { hasBackendFallback } from './presetConfig'

export interface DevProxyConfig {
  enabled: boolean
  prefix: string
  target: string
  changeOrigin: boolean
  secure: boolean
}

const DEFAULT_PROXY_PREFIX = '/api-proxy'
const GATEWAY_PREFIX = '/api/gateway'

/**
 * 请求走哪条路。判定顺序是迁移兼容的关键，见 ADR-0002：
 * 网关 > 上游代理 > 直连。
 */
export type ApiTransport = 'gateway' | 'proxy' | 'direct'

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`

    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0
      ? pathSegments.slice(0, v1Index + 1)
      : pathSegments.length
        ? [...pathSegments, 'v1']
        : []
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
    return `${url.origin}${pathname}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

export function normalizeDevProxyConfig(input: unknown): DevProxyConfig | null {
  if (!input || typeof input !== 'object') return null

  const record = input as Record<string, unknown>
  const target = normalizeBaseUrl(typeof record.target === 'string' ? record.target : '')
  if (!target) return null

  const rawPrefix = typeof record.prefix === 'string' ? record.prefix : DEFAULT_PROXY_PREFIX
  const trimmedPrefix = rawPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const prefix = trimmedPrefix ? `/${trimmedPrefix}` : DEFAULT_PROXY_PREFIX

  return {
    enabled: Boolean(record.enabled),
    prefix,
    target,
    changeOrigin: record.changeOrigin !== false,
    secure: Boolean(record.secure),
  }
}

/**
 * 组装请求地址。
 *
 * transport 为布尔时按旧签名兼容（true = 代理，false = 直连）；fal 等自带域名的
 * 调用点应显式传 'direct'，网关/代理只服务 OpenAI 兼容路径。
 */
export function buildApiUrl(
  baseUrl: string,
  path: string,
  proxyConfig?: DevProxyConfig | null,
  transport: ApiTransport | boolean = 'direct',
): string {
  const endpointPath = path.replace(/^\/+/, '')

  if (transport === 'gateway') return `${GATEWAY_PREFIX}/${endpointPath}`
  if (transport === true || transport === 'proxy') {
    return `${proxyConfig?.prefix ?? DEFAULT_PROXY_PREFIX}/${endpointPath}`
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl.trim())
  if (baseUrl.trim().endsWith('/')) {
    return `${normalizedBaseUrl.replace(/\/+$/, '')}/${endpointPath}`
  }

  const apiPath = normalizedBaseUrl.endsWith('/v1')
    ? endpointPath
    : ['v1', endpointPath].join('/')

  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}

/**
 * 三档传输判定。
 *
 * 网关只在「前端没填 Key 且后端持有 Key」时启用——网关的职责就是补空，填了 Key 的
 * 请求照直连/代理走，计费主体跟着用户。代理档维持上游语义：apiProxy 打开或被部署
 * 锁定。顺序是迁移兼容的关键：老部署的预置配置是「空 Key + 锁代理」，新部署上有
 * 网关时必须先被网关接住。
 */
export function resolveApiTransport(
  profile: { apiProxy?: boolean; apiKey: string },
  proxyConfig: DevProxyConfig | null = readClientDevProxyConfig(),
): ApiTransport {
  if (!profile.apiKey.trim() && hasBackendFallback()) return 'gateway'
  if (shouldUseApiProxy(profile.apiProxy ?? false, proxyConfig)) return 'proxy'
  return 'direct'
}

export function resolveDevProxyConfig(input: unknown, isDev: boolean): DevProxyConfig | null {
  if (!isDev) return null
  return normalizeDevProxyConfig(input)
}

export function readClientDevProxyConfig(): DevProxyConfig | null {
  return resolveDevProxyConfig(
    typeof __DEV_PROXY_CONFIG__ === 'undefined' ? null : __DEV_PROXY_CONFIG__,
    import.meta.env.DEV,
  )
}

export function isApiProxyAvailable(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true' || Boolean(proxyConfig?.enabled)
}

export function isApiProxyLocked(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return readRuntimeEnv(import.meta.env.VITE_API_PROXY_LOCKED) === 'true' && isApiProxyAvailable(proxyConfig)
}

export function shouldUseApiProxy(apiProxy: boolean, proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return isApiProxyAvailable(proxyConfig) && (apiProxy || isApiProxyLocked(proxyConfig))
}
