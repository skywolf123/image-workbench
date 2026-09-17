import { describe, expect, it, vi } from 'vitest'
import { buildApiUrl, normalizeBaseUrl, resolveApiTransport } from './devProxy'
import type { DevProxyConfig } from './devProxy'

const mocks = vi.hoisted(() => ({ backendFallback: false }))

// hasBackendFallback 在模块加载时读运行期占位符，这里替身成可控开关。
vi.mock('./presetConfig', () => ({ hasBackendFallback: () => mocks.backendFallback }))

const ENABLED_PROXY: DevProxyConfig = {
  enabled: true,
  prefix: '/api-proxy',
  target: 'http://api.example.com/v1',
  changeOrigin: true,
  secure: false,
}

describe('normalizeBaseUrl', () => {
  it('preserves a trailing slash used for direct endpoint joining', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com/')
    expect(normalizeBaseUrl('api.example.com/custom/')).toBe('https://api.example.com/custom/')
    expect(normalizeBaseUrl('https://api.example.com/custom///')).toBe('https://api.example.com/custom/')
  })

  it('keeps the existing normalization when there is no trailing slash', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('https://api.example.com/custom')).toBe('https://api.example.com/custom/v1')
  })
})

describe('buildApiUrl', () => {
  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy/images/edits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy/images/generations',
    )
  })

  it('uses a configured proxy prefix when one is available', () => {
    expect(
      buildApiUrl(
        'http://api.example.com/v1',
        'responses',
        {
          enabled: true,
          prefix: '/openai-proxy',
          target: 'http://api.example.com/v1',
          changeOrigin: true,
          secure: false,
        },
        true,
      ),
    ).toBe('/openai-proxy/responses')
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })

  it('joins the endpoint directly when the API URL ends with a slash', () => {
    expect(buildApiUrl('https://api.example.com/', '/custom/image-tasks', null, false)).toBe(
      'https://api.example.com/custom/image-tasks',
    )
  })

  it('preserves a base path when directly joining an API URL', () => {
    expect(buildApiUrl('api.example.com/custom/', 'tasks/123', null, false)).toBe(
      'https://api.example.com/custom/tasks/123',
    )
  })

  it('normalizes an API URL before directly joining an endpoint', () => {
    expect(buildApiUrl('https://user:password@api.example.com/', 'responses', null, false)).toBe(
      'https://api.example.com/responses',
    )
  })

  it('directly joins an OpenAI endpoint when its API URL ends with a slash', () => {
    expect(buildApiUrl('https://api.example.com/', 'responses', null, false)).toBe(
      'https://api.example.com/responses',
    )
  })

  it('网关档返回同源 /api/gateway 前缀，与 baseUrl 无关', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/generations', null, 'gateway')).toBe(
      '/api/gateway/images/generations',
    )
    expect(buildApiUrl('', 'responses', null, 'gateway')).toBe('/api/gateway/responses')
  })
})

describe('resolveApiTransport', () => {
  it('空 Key 且后端持有网关 Key 时走网关', () => {
    mocks.backendFallback = true
    try {
      expect(resolveApiTransport({ apiKey: '' }, ENABLED_PROXY)).toBe('gateway')
      expect(resolveApiTransport({ apiKey: '  ' }, ENABLED_PROXY)).toBe('gateway')
    } finally {
      mocks.backendFallback = false
    }
  })

  it('网关优先于代理：老部署预置配置（空 Key + 锁代理）在新部署上被网关接住', () => {
    mocks.backendFallback = true
    try {
      expect(resolveApiTransport({ apiProxy: true, apiKey: '' }, ENABLED_PROXY)).toBe('gateway')
    } finally {
      mocks.backendFallback = false
    }
  })

  it('前端填了 Key 就不走网关——计费主体跟着用户', () => {
    mocks.backendFallback = true
    try {
      expect(resolveApiTransport({ apiKey: 'user-key' }, ENABLED_PROXY)).toBe('direct')
      expect(resolveApiTransport({ apiProxy: true, apiKey: 'user-key' }, ENABLED_PROXY)).toBe('proxy')
    } finally {
      mocks.backendFallback = false
    }
  })

  it('没有网关时退回代理档，再退直连', () => {
    expect(resolveApiTransport({ apiProxy: true, apiKey: '' }, ENABLED_PROXY)).toBe('proxy')
    expect(resolveApiTransport({ apiKey: '' }, ENABLED_PROXY)).toBe('direct')
    expect(resolveApiTransport({ apiKey: '' }, null)).toBe('direct')
  })
})
