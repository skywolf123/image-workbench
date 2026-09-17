import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { readFileSync as readFile } from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './index.mjs'
import { createSyncStore } from './sync.mjs'

const GATEWAY_KEY = 'gateway-secret-key'

let tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeDist() {
  const root = makeTempDir('server-root-')
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>工作台</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'const k="__VITE_DEFAULT_API_URL_PLACEHOLDER__";')
  return dist
}

/** 上游替身：记录收到的请求，按调用方给出的响应生成器回答。 */
async function startUpstream(handler) {
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      handler(req, res, received[received.length - 1])
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    received,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** HTTPS 上游替身：用自签证书起一个 https 服务，验证转发会按协议选传输模块。 */
async function startHttpsUpstream(handler) {
  const received = []
  const keyPath = join(makeTempDir('server-tls-'), 'key.pem')
  const certPath = join(makeTempDir('server-tls-'), 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' })

  const server = https.createServer(
    { key: readFile(keyPath), cert: readFile(certPath) },
    (req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
        handler(req, res, received[received.length - 1])
      })
    },
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    received,
    certPath,
    origin: `https://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 直接发原始 HTTP，用于测试未经规范化的请求路径。 */
function rawRequest(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function startPlatform(options = {}) {
  const instance = await createServer({
    host: '127.0.0.1',
    port: 0,
    distDir: options.distDir ?? makeDist(),
    dataDir: options.dataDir ?? makeTempDir('server-data-'),
    apiUrl: options.apiUrl ?? '',
    gatewayApiUrl: options.gatewayApiUrl ?? '',
    gatewayApiKey: options.gatewayApiKey === undefined ? GATEWAY_KEY : options.gatewayApiKey,
    env: options.env ?? {},
  })
  await instance.listen()
  return {
    ...instance,
    origin: `http://127.0.0.1:${instance.port}`,
  }
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id ?? 'task0001abcdef',
    prompt: overrides.prompt ?? '一只猫',
    params: { model: 'gpt-image-1' },
    status: 'done',
    error: null,
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_500,
    elapsed: 500,
    inputImageIds: overrides.inputImageIds ?? [],
    outputImages: overrides.outputImages ?? [],
    ...overrides,
  }
}

async function pushSync(origin, memberId, body) {
  const response = await fetch(`${origin}/api/sync`, {
    method: 'POST',
    headers: { 'X-Member-Id': memberId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  tempDirs = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('服务端：网关（后端出 Key 的转发）', () => {
  it('前端没带 Key 时注入 GATEWAY_API_KEY，并转发到 GATEWAY_API_URL', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const platform = await startPlatform({ gatewayApiUrl: `${upstream.origin}/v1` })

    try {
      const response = await fetch(`${platform.origin}/api/gateway/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '一只猫' }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(upstream.received).toHaveLength(1)
      expect(upstream.received[0].headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`)
      expect(upstream.received[0].url).toBe('/v1/images/generations')
      expect(upstream.received[0].body.toString()).toBe('{"prompt":"一只猫"}')
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前端带了自己的 Key 时原样转发，网关不覆盖', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ gatewayApiUrl: `${upstream.origin}/v1` })

    try {
      await fetch(`${platform.origin}/api/gateway/images/generations`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-supplied-key' },
        body: '{}',
      })

      expect(upstream.received[0].headers.authorization).toBe('Bearer user-supplied-key')
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前端发出空 Key 时也视为没带，注入网关 Key', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ gatewayApiUrl: `${upstream.origin}/v1` })

    try {
      // Key 为空时前端仍会发出 `Bearer `，不能按「头存在」判断。
      await fetch(`${platform.origin}/api/gateway/images/generations`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' },
        body: '{}',
      })

      expect(upstream.received[0].headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`)
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前后端都没有 Key 时拒绝网关请求并给出可定位的提示', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ gatewayApiUrl: upstream.origin, gatewayApiKey: null })

    try {
      const response = await fetch(`${platform.origin}/api/gateway/images/generations`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(503)
      expect((await response.json()).error.type).toBe('api_key_missing')
      expect(upstream.received).toHaveLength(0)
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('网关只转发到 GATEWAY_API_URL，与 API_PROXY_URL 完全无关', async () => {
    const proxyUpstream = await startUpstream((req, res) => res.end('proxy'))
    const gatewayUpstream = await startUpstream((req, res) => res.end('gateway'))
    const platform = await startPlatform({
      apiUrl: proxyUpstream.origin,
      gatewayApiUrl: gatewayUpstream.origin,
    })

    try {
      await fetch(`${platform.origin}/api/gateway/responses`, { method: 'POST', body: '{}' })

      expect(gatewayUpstream.received).toHaveLength(1)
      expect(proxyUpstream.received).toHaveLength(0)
    } finally {
      await platform.close()
      await proxyUpstream.close()
      await gatewayUpstream.close()
    }
  })

  it('未配置 GATEWAY_API_URL 时给出可定位的错误', async () => {
    const platform = await startPlatform({ gatewayApiKey: GATEWAY_KEY })

    try {
      const response = await fetch(`${platform.origin}/api/gateway/images/generations`, { method: 'POST', body: '{}' })
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.error.type).toBe('backend_upstream_missing')
      expect(body.error.message).toContain('GATEWAY_API_URL')
    } finally {
      await platform.close()
    }
  })

  it('把上游的错误状态与响应体如实透传', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '额度不足' } }))
    })
    const platform = await startPlatform({ gatewayApiUrl: upstream.origin })

    try {
      const response = await fetch(`${platform.origin}/api/gateway/responses`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: { message: '额度不足' } })
    } finally {
      await platform.close()
      await upstream.close()
    }
  })
})

describe('服务端：上游代理回归纯转发', () => {
  it('前端带的 Key 原样透传，服务端持有的网关 Key 不掺和', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ apiUrl: `${upstream.origin}/v1` })

    try {
      await fetch(`${platform.origin}/api-proxy/images/generations`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-supplied-key' },
        body: '{}',
      })

      expect(upstream.received[0].headers.authorization).toBe('Bearer user-supplied-key')
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前端没带 Key 时不拦截也不注入，上游会给出 401', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '未授权' } }))
    })
    const platform = await startPlatform({ apiUrl: `${upstream.origin}/v1` })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`, { method: 'POST', body: '{}' })

      // 纯转发语义：请求照达上游（没有 authorization 头），401 原样返回给前端。
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: { message: '未授权' } })
      expect(upstream.received[0].headers.authorization).toBeUndefined()
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('按上游一致的方法限制，拒绝非 POST 请求', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ apiUrl: upstream.origin })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`)

      expect(response.status).toBe(403)
      expect(upstream.received).toHaveLength(0)
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('代理根路径为空时拒绝请求', async () => {
    const platform = await startPlatform({ apiUrl: 'https://upstream.invalid/v1' })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(503)
    } finally {
      await platform.close()
    }
  })

  it('未配置 API_PROXY_URL 时给出可定位的错误，而不是让进程崩溃', async () => {
    const platform = await startPlatform({ apiUrl: '' })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`, { method: 'POST', body: '{}' })
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.error.type).toBe('backend_upstream_missing')
      expect(body.error.message).toContain('API_PROXY_URL')
    } finally {
      await platform.close()
    }
  })

  it('上游是 https 时用 https 模块发起请求，而不是同步抛异常', async () => {
    // 此前固定用 node:http 的 request，遇到 https 会同步抛
    // ERR_INVALID_PROTOCOL；同步异常接不到 'error' 事件上，进程会被直接带崩。
    // 这里用自签证书，预期的失败是 TLS 校验失败（502），而不是进程死掉。
    const upstream = await startHttpsUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ apiUrl: `${upstream.origin}/v1` })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(502)
      const body = await response.json()
      expect(body.error.type).toBe('upstream_unreachable')
      // 走到 TLS 校验才失败，说明确实是用 https 模块发的请求，
      // 而不是在构造 ClientRequest 时就抛 ERR_INVALID_PROTOCOL。
      expect(body.error.message).toMatch(/certificate|self.signed/i)

      // 关键：这条请求之后进程仍活着，能继续服务。
      const alive = await fetch(`${platform.origin}/api/sync/ping`)
      expect(alive.status).toBe(200)
    } finally {
      await platform.close()
      await upstream.close()
    }
  })
})

describe('服务端：静态托管与运行期注入', () => {
  it('深链接回退到 index.html，静态资源带长期缓存', async () => {
    const platform = await startPlatform()

    try {
      const deepLink = await fetch(`${platform.origin}/some/deep/link`)
      expect(deepLink.status).toBe(200)
      expect(await deepLink.text()).toContain('工作台')

      const asset = await fetch(`${platform.origin}/assets/app.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('cache-control')).toContain('immutable')
    } finally {
      await platform.close()
    }
  })

  it('拒绝越出构建产物目录的路径', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, '..', 'secret.txt'), '不该被读到')
    const platform = await startPlatform({ distDir: dist })

    try {
      // 用原始 HTTP 发送未经规范化的路径，fetch 会在客户端就把 `..` 折叠掉。
      const response = await rawRequest(platform.port, '/../secret.txt')

      expect(response.status).toBe(200)
      expect(response.body).toContain('工作台')
      expect(response.body).not.toContain('不该被读到')
    } finally {
      await platform.close()
    }
  })

  it('网关持有 Key 时告诉前端可以留空，用户填了仍然优先', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'fallback.js'), 'const f="__VITE_BACKEND_FALLBACK_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, gatewayApiKey: GATEWAY_KEY })

    try {
      expect(readFileSync(join(dist, 'assets', 'fallback.js'), 'utf-8')).toContain('const f="true"')
    } finally {
      await platform.close()
    }
  })

  it('网关没有 Key 时前端照旧必须自己填', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'fallback.js'), 'const f="__VITE_BACKEND_FALLBACK_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, gatewayApiKey: null })

    try {
      expect(readFileSync(join(dist, 'assets', 'fallback.js'), 'utf-8')).toContain('const f="false"')
    } finally {
      await platform.close()
    }
  })

  it('隐藏配置页与锁定 Key 由各自的开关决定，不会因为配了 Key 就自动生效', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'switch.js'), 'const h="__VITE_HIDE_API_SETTINGS_PLACEHOLDER__";const l="__VITE_LOCK_PRESET_KEY_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, gatewayApiKey: GATEWAY_KEY })

    try {
      // 只配了 Key 时两个开关都该保持关闭——前端配置路线不受影响。
      expect(readFileSync(join(dist, 'assets', 'switch.js'), 'utf-8')).toContain('const h="false";const l="false"')
    } finally {
      await platform.close()
    }
  })

  it('启动时把构建产物里的占位符替换成运行期取值', async () => {
    const dist = makeDist()
    const platform = await startPlatform({ distDir: dist, env: { DEFAULT_API_URL: 'https://preset.example.com/v1' } })

    try {
      const bundle = readFileSync(join(dist, 'assets', 'app.js'), 'utf-8')
      expect(bundle).toContain('https://preset.example.com/v1')
      expect(bundle).not.toContain('__VITE_DEFAULT_API_URL_PLACEHOLDER__')
    } finally {
      await platform.close()
    }
  })

  it('检测到旧 DEFAULT_API_KEY 时提示改名，而不是静默迁移', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      gatewayApiKey: null,
      env: { DEFAULT_API_KEY: 'legacy-key' },
    })
    try {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GATEWAY_API_KEY'))
      expect(instance.config.gatewayApiKey).toBeNull()
      expect(instance.config.bundleValues.backendFallback).toBe('false')
    } finally {
      await instance.close()
    }
  })
})

describe('服务端：同步——图片仓库', () => {
  it('上传、下载、列举三者对同一 id 往返一致', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])

    try {
      const put = await fetch(`${platform.origin}/api/sync/images/abc123`, { method: 'PUT', headers, body: bytes })
      expect(put.status).toBe(201)

      const head = await fetch(`${platform.origin}/api/sync/images/abc123`, { method: 'HEAD', headers })
      expect(head.status).toBe(200)

      const get = await fetch(`${platform.origin}/api/sync/images/abc123`, { headers })
      expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true)

      const manifest = await fetch(`${platform.origin}/api/sync/manifest`, { headers })
      const body = await manifest.json()
      expect(body.images).toEqual(['abc123'])
      expect(body.version).toBe(0)
    } finally {
      await platform.close()
    }
  })

  it('重复上传同一个 id 不产生第二份数据，也不算错误', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }
    const dataDir = platform.config.dataDir

    try {
      const first = await fetch(`${platform.origin}/api/sync/images/dup`, { method: 'PUT', headers, body: Buffer.from('first') })
      const second = await fetch(`${platform.origin}/api/sync/images/dup`, { method: 'PUT', headers, body: Buffer.from('second') })

      expect(first.status).toBe(201)
      expect(second.status).toBe(200)
      expect(readFileSync(createSyncStore(dataDir).imagePath('member-a', 'dup'), 'utf-8')).toBe('first')
      expect(readdirSync(join(dataDir, 'member-a', 'images', 'du'))).toEqual(['dup'])
    } finally {
      await platform.close()
    }
  })

  it('按哈希前缀分目录，且落盘的是原始字节而不是 base64 文本', async () => {
    const platform = await startPlatform()
    const payload = Buffer.from('原始图片字节')

    try {
      await fetch(`${platform.origin}/api/sync/images/ab12cd34`, {
        method: 'PUT',
        headers: { 'X-Member-Id': 'member-a' },
        body: payload,
      })

      const path = join(platform.config.dataDir, 'member-a', 'images', 'ab', 'ab12cd34')
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path).equals(payload)).toBe(true)
      expect(readFileSync(path, 'utf-8')).not.toBe(payload.toString('base64'))
    } finally {
      await platform.close()
    }
  })

  it('服务器只增不删：没有任何同步客户端操作能删掉已上传的图片', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }

    try {
      await fetch(`${platform.origin}/api/sync/images/keep-me`, { method: 'PUT', headers, body: Buffer.from('x') })

      const del = await fetch(`${platform.origin}/api/sync/images/keep-me`, { method: 'DELETE', headers })
      expect(del.status).toBe(405)

      const response = await fetch(`${platform.origin}/api/sync/images/keep-me`, { headers })
      expect(response.status).toBe(200)
    } finally {
      await platform.close()
    }
  })
})

describe('服务端：同步——活跃集合并', () => {
  it('推送变更任务后合并进活跃集，第二个客户端同步即拉到', async () => {
    const platform = await startPlatform()

    try {
      const first = await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask()] })
      expect(first.status).toBe(200)
      expect(first.body.version).toBe(1)
      expect(first.body.tasks).toHaveLength(1)

      const second = await pushSync(platform.origin, 'member-b', {})
      expect(second.body.tasks).toHaveLength(0)

      const back = await pushSync(platform.origin, 'member-a', {})
      expect(back.body.tasks).toEqual(first.body.tasks)
      // 没有变更时不 bump 版本：重复同步是幂等的。
      expect(back.body.version).toBe(1)
    } finally {
      await platform.close()
    }
  })

  it('同一任务后推送者覆盖先推送者（任务级 LWW）', async () => {
    const platform = await startPlatform()

    try {
      // LWW 发生在同一成员的两台设备之间；member 码就是服务端身份。
      await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask({ prompt: '第一版' })] })
      const result = await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask({ prompt: '第二版' })] })

      expect(result.body.tasks).toHaveLength(1)
      expect(result.body.tasks[0].prompt).toBe('第二版')
      expect(result.body.version).toBe(2)
    } finally {
      await platform.close()
    }
  })

  it('删除把任务整条移入回收站，图片字节原地保留', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }

    try {
      await fetch(`${platform.origin}/api/sync/images/img0001`, { method: 'PUT', headers, body: Buffer.from('图片字节') })
      await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask({ id: 'task0001abcdef', outputImages: ['img0001'] })] })

      const deleted = await pushSync(platform.origin, 'member-a', { deletedTaskIds: ['task0001abcdef'] })
      expect(deleted.body.tasks).toHaveLength(0)

      const trash = await fetch(`${platform.origin}/api/sync/trash`, { headers })
      const { items } = await trash.json()
      expect(items).toEqual([
        { id: 'task0001abcdef', prompt: '一只猫', deletedAt: expect.any(Number), imageCount: 1 },
      ])

      // 回收站里的任务，其图片仍在仓库里。
      const manifest = await fetch(`${platform.origin}/api/sync/manifest`, { headers })
      expect((await manifest.json()).images).toEqual(['img0001'])
    } finally {
      await platform.close()
    }
  })

  it('删除一个服务器上不存在的任务是幂等的 no-op', async () => {
    const platform = await startPlatform()

    try {
      const result = await pushSync(platform.origin, 'member-a', { deletedTaskIds: ['tasknotexist123'] })
      expect(result.status).toBe(200)
      expect(result.body.version).toBe(0)
      expect(result.body.tasks).toHaveLength(0)
    } finally {
      await platform.close()
    }
  })

  it('非法的同步请求体被拒绝', async () => {
    const platform = await startPlatform()

    try {
      const badTask = await pushSync(platform.origin, 'member-a', { changedTasks: [{ prompt: '没有 id' }] })
      expect(badTask.status).toBe(400)
      expect(badTask.body.error.type).toBe('sync_task_invalid')

      const badList = await pushSync(platform.origin, 'member-a', { changedTasks: 'not-an-array' })
      expect(badList.status).toBe(400)
      expect(badList.body.error.type).toBe('sync_body_invalid')

      const badDeleted = await pushSync(platform.origin, 'member-a', { deletedTaskIds: ['../escape'] })
      expect(badDeleted.status).toBe(400)
    } finally {
      await platform.close()
    }
  })

  it('成员之间数据严格隔离，互不可见', async () => {
    const platform = await startPlatform()

    try {
      await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask()] })

      const otherMember = await pushSync(platform.origin, 'member-b', {})
      expect(otherMember.body.tasks).toHaveLength(0)

      const trash = await fetch(`${platform.origin}/api/sync/trash`, { headers: { 'X-Member-Id': 'member-b' } })
      expect((await trash.json()).items).toHaveLength(0)
    } finally {
      await platform.close()
    }
  })

  it('成员码不在名单中时按首次使用建立命名空间，没有白名单', async () => {
    const platform = await startPlatform()

    try {
      const result = await pushSync(platform.origin, 'brand-new-member', { changedTasks: [makeTask()] })
      expect(result.status).toBe(200)
      expect(existsSync(join(platform.config.dataDir, 'brand-new-member', 'state.json'))).toBe(true)
    } finally {
      await platform.close()
    }
  })

  it('ping 不需要成员码，用于探测部署是否带服务端', async () => {
    const platform = await startPlatform()
    try {
      const response = await fetch(`${platform.origin}/api/sync/ping`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    } finally {
      await platform.close()
    }
  })

  it('缺失或非法的成员码被拒绝', async () => {
    const platform = await startPlatform()

    try {
      const missing = await fetch(`${platform.origin}/api/sync/manifest`)
      expect(missing.status).toBe(400)

      const illegal = await fetch(`${platform.origin}/api/sync/manifest`, { headers: { 'X-Member-Id': '../escape' } })
      expect(illegal.status).toBe(400)
    } finally {
      await platform.close()
    }
  })

  it('活跃集写入中断后旧状态仍可读且有效', async () => {
    const platform = await startPlatform()
    const dataDir = platform.config.dataDir

    try {
      await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask()] })
      // 模拟进程在 rename 之前被杀：只留下半个临时文件。
      writeFileSync(join(dataDir, 'member-a', 'state.json.tmp'), '{"version":99,"tasks":')

      const read = await pushSync(platform.origin, 'member-a', {})
      expect(read.body.version).toBe(1)
      expect(read.body.tasks).toHaveLength(1)
    } finally {
      await platform.close()
    }
  })
})

describe('服务端：同步——回收站', () => {
  it('还原把任务放回活跃集，回收站条目消失', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }

    try {
      await pushSync(platform.origin, 'member-a', { changedTasks: [makeTask()] })
      await pushSync(platform.origin, 'member-a', { deletedTaskIds: ['task0001abcdef'] })

      const restore = await fetch(`${platform.origin}/api/sync/trash/task0001abcdef/restore`, { method: 'POST', headers })
      expect(restore.status).toBe(200)

      const back = await pushSync(platform.origin, 'member-a', {})
      expect(back.body.tasks).toHaveLength(1)
      expect(back.body.tasks[0].prompt).toBe('一只猫')

      const trash = await fetch(`${platform.origin}/api/sync/trash`, { headers })
      expect((await trash.json()).items).toHaveLength(0)
    } finally {
      await platform.close()
    }
  })

  it('还原不存在的回收站条目返回 404', async () => {
    const platform = await startPlatform()

    try {
      const restore = await fetch(`${platform.origin}/api/sync/trash/tasknotexist123/restore`, {
        method: 'POST',
        headers: { 'X-Member-Id': 'member-a' },
      })
      expect(restore.status).toBe(404)
    } finally {
      await platform.close()
    }
  })

  it('清空回收站做外科式 GC：被清任务独占的图片删除，活跃引用与无主上传图保留', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }

    try {
      // trash-task 独占 trash-only；active-task 与它共享 shared；lonely 谁都不引用（会话上传图场景）。
      for (const id of ['trash-only', 'shared', 'lonely']) {
        await fetch(`${platform.origin}/api/sync/images/${id}`, { method: 'PUT', headers, body: Buffer.from(id) })
      }
      await pushSync(platform.origin, 'member-a', {
        changedTasks: [
          makeTask({ id: 'task-trash00001', outputImages: ['trash-only', 'shared'] }),
          makeTask({ id: 'task-active001', outputImages: ['shared'] }),
        ],
      })
      await pushSync(platform.origin, 'member-a', { deletedTaskIds: ['task-trash00001'] })

      // 不带确认：拒绝。
      const noConfirm = await fetch(`${platform.origin}/api/sync/trash`, { method: 'DELETE', headers, body: JSON.stringify({}) })
      expect(noConfirm.status).toBe(400)
      expect((await noConfirm.json()).error.type).toBe('confirm_mismatch')

      const wrongConfirm = await fetch(`${platform.origin}/api/sync/trash`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ confirm: 'member-b' }),
      })
      expect(wrongConfirm.status).toBe(400)

      const emptied = await fetch(`${platform.origin}/api/sync/trash`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ confirm: 'member-a' }),
      })
      expect(emptied.status).toBe(200)
      expect(await emptied.json()).toEqual({ removed: { tasks: 1, images: 1 } })

      const manifest = await fetch(`${platform.origin}/api/sync/manifest`, { headers })
      // trash-only 被清掉；shared 被活跃任务引用保留；lonely 是无主上传图，外科 GC 不碰它。
      expect((await manifest.json()).images).toEqual(['lonely', 'shared'])

      const trash = await fetch(`${platform.origin}/api/sync/trash`, { headers })
      expect((await trash.json()).items).toHaveLength(0)
    } finally {
      await platform.close()
    }
  })

  it('同一成员的并发合并被锁串行化，不会互相丢更新', async () => {
    const platform = await startPlatform()

    try {
      const pushes = []
      for (let i = 0; i < 20; i++) {
        pushes.push(pushSync(platform.origin, 'member-a', { changedTasks: [makeTask({ id: `task${String(i).padStart(12, '0')}` })] }))
      }
      const results = await Promise.all(pushes)

      expect(results.every((result) => result.status === 200)).toBe(true)
      const final = await pushSync(platform.origin, 'member-a', {})
      expect(final.body.tasks).toHaveLength(20)
      expect(final.body.version).toBe(20)
    } finally {
      await platform.close()
    }
  })
})

describe('服务端：后端持有地址与 Key 的取值优先级', () => {
  it('API_PROXY_URL 是代理的主变量，API_URL 只作旧配置兜底', async () => {
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      env: { API_PROXY_URL: 'https://proxy.example.com/v1', API_URL: 'https://legacy.example.com/v1' },
    })
    try {
      expect(instance.config.apiUrl).toBe('https://proxy.example.com/v1')
    } finally {
      await instance.close()
    }
  })

  it('只有旧的 API_URL 时才回退到它，并标记为使用了旧变量', async () => {
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      env: { API_URL: 'https://legacy.example.com/v1' },
    })
    try {
      expect(instance.config.apiUrl).toBe('https://legacy.example.com/v1')
      expect(instance.config.bundleValues.dockerLegacyApiUrlUsed).toBe('true')
    } finally {
      await instance.close()
    }
  })

  it('GATEWAY_API_URL 与代理变量互不沾染', async () => {
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      env: {
        API_PROXY_URL: 'https://proxy.example.com/v1',
        GATEWAY_API_URL: 'https://gateway.example.com/v1',
      },
    })
    try {
      expect(instance.config.apiUrl).toBe('https://proxy.example.com/v1')
      expect(instance.config.gatewayApiUrl).toBe('https://gateway.example.com/v1')
    } finally {
      await instance.close()
    }
  })

  it('GATEWAY_API_KEY 及其文件形式都能提供网关 Key', async () => {
    const keyFile = join(makeTempDir('server-key-'), 'key.txt')
    writeFileSync(keyFile, 'key-from-file\n')

    const fromEnv = await createServer({
      host: '127.0.0.1', port: 0, distDir: makeDist(), dataDir: makeTempDir('server-data-'),
      env: { GATEWAY_API_KEY: 'key-from-env' },
    })
    const fromFile = await createServer({
      host: '127.0.0.1', port: 0, distDir: makeDist(), dataDir: makeTempDir('server-data-'),
      env: { GATEWAY_API_KEY_FILE: keyFile },
    })

    try {
      expect(fromEnv.config.gatewayApiKey).toBe('key-from-env')
      expect(fromFile.config.gatewayApiKey).toBe('key-from-file')
      expect(fromEnv.config.bundleValues.backendFallback).toBe('true')
      expect(fromFile.config.bundleValues.backendFallback).toBe('true')
    } finally {
      await fromEnv.close()
      await fromFile.close()
    }
  })

  it('配了网关 Key 但没配网关地址时给出启动警告', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      gatewayApiKey: GATEWAY_KEY,
    })
    try {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GATEWAY_API_URL'))
    } finally {
      await instance.close()
    }
  })
})
