import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './index.mjs'
import { createBackupStore } from './backup.mjs'

const API_KEY = 'backend-secret-key'
const API_URL = 'https://upstream.invalid/v1'

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
    apiUrl: options.apiUrl ?? API_URL,
    apiKey: options.apiKey === undefined ? API_KEY : options.apiKey,
    env: options.env ?? {},
  })
  await instance.listen()
  return {
    ...instance,
    origin: `http://127.0.0.1:${instance.port}`,
  }
}

beforeEach(() => {
  tempDirs = []
})

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('服务端：接管 API 代理', () => {
  it('前端没带 Key 时补上后端持有的 Key，并转发到部署配置的上游地址', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const platform = await startPlatform({ apiUrl: `${upstream.origin}/v1` })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '一只猫' }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(upstream.received).toHaveLength(1)
      expect(upstream.received[0].headers.authorization).toBe(`Bearer ${API_KEY}`)
      expect(upstream.received[0].url).toBe('/v1/images/generations')
      expect(upstream.received[0].body.toString()).toBe('{"prompt":"一只猫"}')
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前端带了自己的 Key 时原样转发，后端不覆盖', async () => {
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

  it('前端发出空 Key 时也视为没带，用后端的补上', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ apiUrl: `${upstream.origin}/v1` })

    try {
      // Key 为空时前端仍会发出 `Bearer `，不能按「头存在」判断。
      await fetch(`${platform.origin}/api-proxy/images/generations`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' },
        body: '{}',
      })

      expect(upstream.received[0].headers.authorization).toBe(`Bearer ${API_KEY}`)
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('把上游的错误状态与响应体如实透传，前端能看到真实错误', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '额度不足' } }))
    })
    const platform = await startPlatform({ apiUrl: upstream.origin })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/responses`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: { message: '额度不足' } })
    } finally {
      await platform.close()
      await upstream.close()
    }
  })

  it('前后端都没有 Key 时拒绝代理请求并给出可定位的提示', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'))
    const platform = await startPlatform({ apiUrl: upstream.origin, apiKey: null })

    try {
      const response = await fetch(`${platform.origin}/api-proxy/images/generations`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(503)
      expect((await response.json()).error.type).toBe('api_key_missing')
      expect(upstream.received).toHaveLength(0)
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
    const platform = await startPlatform()

    try {
      const response = await fetch(`${platform.origin}/api-proxy/`, { method: 'POST', body: '{}' })

      expect(response.status).toBe(503)
    } finally {
      await platform.close()
    }
  })

  it('未配置上游地址时给出可定位的错误，而不是让进程崩溃', async () => {
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

  it('后端持有 Key 时告诉前端可以留空，用户填了仍然优先', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'fallback.js'), 'const f="__VITE_BACKEND_FALLBACK_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, apiKey: 'backend-secret-key' })

    try {
      expect(readFileSync(join(dist, 'assets', 'fallback.js'), 'utf-8')).toContain('const f="true"')
    } finally {
      await platform.close()
    }
  })

  it('后端没有 Key 时前端照旧必须自己填', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'fallback.js'), 'const f="__VITE_BACKEND_FALLBACK_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, apiKey: null })

    try {
      expect(readFileSync(join(dist, 'assets', 'fallback.js'), 'utf-8')).toContain('const f="false"')
    } finally {
      await platform.close()
    }
  })

  it('隐藏配置页与锁定 Key 由各自的开关决定，不会因为配了 Key 就自动生效', async () => {
    const dist = makeDist()
    writeFileSync(join(dist, 'assets', 'switch.js'), 'const h="__VITE_HIDE_API_SETTINGS_PLACEHOLDER__";const l="__VITE_LOCK_PRESET_KEY_PLACEHOLDER__";')
    const platform = await startPlatform({ distDir: dist, apiKey: 'backend-secret-key' })

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
})

describe('备份 blob 仓库', () => {
  it('上传、下载、列举三者对同一 id 往返一致', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])

    try {
      const put = await fetch(`${platform.origin}/api/backup/images/abc123`, { method: 'PUT', headers, body: bytes })
      expect(put.status).toBe(201)

      const head = await fetch(`${platform.origin}/api/backup/images/abc123`, { method: 'HEAD', headers })
      expect(head.status).toBe(200)

      const get = await fetch(`${platform.origin}/api/backup/images/abc123`, { headers })
      expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true)

      const manifest = await fetch(`${platform.origin}/api/backup/manifest`, { headers })
      expect(await manifest.json()).toEqual({ images: ['abc123'], state: null })
    } finally {
      await platform.close()
    }
  })

  it('重复上传同一个 id 不产生第二份数据，也不算错误', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }
    const dataDir = platform.config.dataDir

    try {
      const first = await fetch(`${platform.origin}/api/backup/images/dup`, { method: 'PUT', headers, body: Buffer.from('first') })
      const second = await fetch(`${platform.origin}/api/backup/images/dup`, { method: 'PUT', headers, body: Buffer.from('second') })

      expect(first.status).toBe(201)
      expect(second.status).toBe(200)
      expect(readFileSync(createBackupStore(dataDir).imagePath('member-a', 'dup'), 'utf-8')).toBe('first')
      expect(readdirSync(join(dataDir, 'member-a', 'images', 'du'))).toEqual(['dup'])
    } finally {
      await platform.close()
    }
  })

  it('按哈希前缀分目录，且落盘的是原始字节而不是 base64 文本', async () => {
    const platform = await startPlatform()
    const payload = Buffer.from('原始图片字节')

    try {
      await fetch(`${platform.origin}/api/backup/images/ab12cd34`, {
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

  it('成员之间数据严格隔离，互不可见', async () => {
    const platform = await startPlatform()

    try {
      await fetch(`${platform.origin}/api/backup/images/shared-id`, {
        method: 'PUT',
        headers: { 'X-Member-Id': 'member-a' },
        body: Buffer.from('a 的图'),
      })

      const otherMember = await fetch(`${platform.origin}/api/backup/manifest`, { headers: { 'X-Member-Id': 'member-b' } })
      expect(await otherMember.json()).toEqual({ images: [], state: null })

      const otherImage = await fetch(`${platform.origin}/api/backup/images/shared-id`, { headers: { 'X-Member-Id': 'member-b' } })
      expect(otherImage.status).toBe(404)
    } finally {
      await platform.close()
    }
  })

  it('成员码不在名单中时按首次使用建立命名空间，没有白名单', async () => {
    const platform = await startPlatform()

    try {
      const firstUse = await fetch(`${platform.origin}/api/backup/images/first-of-new-member`, {
        method: 'PUT',
        headers: { 'X-Member-Id': 'brand-new-member' },
        body: Buffer.from('x'),
      })

      expect(firstUse.status).toBe(201)
      expect(existsSync(join(platform.config.dataDir, 'brand-new-member', 'images', 'fi'))).toBe(true)
    } finally {
      await platform.close()
    }
  })

  it('ping 不需要成员码，用于探测部署是否带服务端', async () => {
    const platform = await startPlatform()
    try {
      const response = await fetch(`${platform.origin}/api/backup/ping`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    } finally {
      await platform.close()
    }
  })

  it('缺失或非法的成员码被拒绝', async () => {
    const platform = await startPlatform()

    try {
      const missing = await fetch(`${platform.origin}/api/backup/manifest`)
      expect(missing.status).toBe(400)

      const illegal = await fetch(`${platform.origin}/api/backup/manifest`, { headers: { 'X-Member-Id': '../escape' } })
      expect(illegal.status).toBe(400)
    } finally {
      await platform.close()
    }
  })

  it('状态快照服务端自增版本，If-Match 不匹配时拒绝覆盖', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a', 'Content-Type': 'application/json' }

    try {
      const first = await fetch(`${platform.origin}/api/backup/state`, { method: 'PUT', headers, body: JSON.stringify({ data: { settings: { a: 1 } } }) })
      expect(first.status).toBe(200)
      expect((await first.json()).version).toBe(1)

      const stale = await fetch(`${platform.origin}/api/backup/state`, {
        method: 'PUT',
        headers: { ...headers, 'If-Match': '0' },
        body: JSON.stringify({ data: { settings: { a: 2 } } }),
      })
      expect(stale.status).toBe(409)

      const read = await fetch(`${platform.origin}/api/backup/state`, { headers })
      expect((await read.json()).data).toEqual({ settings: { a: 1 } })
    } finally {
      await platform.close()
    }
  })

  it('状态快照写入中断后旧快照仍可读且有效', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a', 'Content-Type': 'application/json' }
    const dataDir = platform.config.dataDir

    try {
      await fetch(`${platform.origin}/api/backup/state`, { method: 'PUT', headers, body: JSON.stringify({ data: { settings: { a: 1 } } }) })
      // 模拟进程在 rename 之前被杀：只留下半个临时文件。
      writeFileSync(join(dataDir, 'member-a', 'state.json.tmp'), '{"version":2,"data":{"settings":')

      const read = await fetch(`${platform.origin}/api/backup/state`, { headers })
      const state = await read.json()

      expect(read.status).toBe(200)
      expect(state.version).toBe(1)
      expect(state.data).toEqual({ settings: { a: 1 } })
    } finally {
      await platform.close()
    }
  })

  it('服务器只增不删：没有任何客户端操作能删掉已上传的图片', async () => {
    const platform = await startPlatform()
    const headers = { 'X-Member-Id': 'member-a' }

    try {
      await fetch(`${platform.origin}/api/backup/images/keep-me`, { method: 'PUT', headers, body: Buffer.from('x') })

      const del = await fetch(`${platform.origin}/api/backup/images/keep-me`, { method: 'DELETE', headers })
      expect(del.status).toBe(405)

      const response = await fetch(`${platform.origin}/api/backup/images/keep-me`, { headers })
      expect(response.status).toBe(200)
    } finally {
      await platform.close()
    }
  })
})

describe('服务端：后端持有地址与 Key 的取值优先级', () => {
  it('API_PROXY_URL 是主变量，API_URL 只作旧配置兜底', async () => {
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

  it('用 API_PROXY_URL 部署不会触发旧变量迁移提示', async () => {
    const instance = await createServer({
      host: '127.0.0.1',
      port: 0,
      distDir: makeDist(),
      dataDir: makeTempDir('server-data-'),
      env: { API_PROXY_URL: 'https://proxy.example.com/v1' },
    })
    try {
      expect(instance.config.bundleValues.dockerLegacyApiUrlUsed).toBe('false')
    } finally {
      await instance.close()
    }
  })

  it('DEFAULT_API_KEY 及其文件形式都能提供后端 Key', async () => {
    const keyFile = join(makeTempDir('server-key-'), 'key.txt')
    writeFileSync(keyFile, 'key-from-file\n')

    const fromEnv = await createServer({
      host: '127.0.0.1', port: 0, distDir: makeDist(), dataDir: makeTempDir('server-data-'),
      env: { DEFAULT_API_KEY: 'key-from-env' },
    })
    const fromFile = await createServer({
      host: '127.0.0.1', port: 0, distDir: makeDist(), dataDir: makeTempDir('server-data-'),
      env: { DEFAULT_API_KEY_FILE: keyFile },
    })

    try {
      expect(fromEnv.config.apiKey).toBe('key-from-env')
      expect(fromFile.config.apiKey).toBe('key-from-file')
      expect(fromEnv.config.bundleValues.backendFallback).toBe('true')
      expect(fromFile.config.bundleValues.backendFallback).toBe('true')
    } finally {
      await fromEnv.close()
      await fromFile.close()
    }
  })
})
