#!/usr/bin/env node
/**
 * 自部署服务端。
 *
 * 一个零第三方依赖的 Node 进程，同时承担三件事：
 *
 * 1. 静态托管构建产物（含 SPA fallback）—— 取代上游容器里的 Nginx。
 * 2. 接管 `/api-proxy/*`，把请求转发到部署配置的上游地址。前端自带 Key 就用前端的，
 *    没带才补上本进程持有的 Key。前端一行不改：上游的代理路径构造已经完整，这里只是换了「谁接住」。
 * 3. 备份用的哑巴 blob 仓库（见下方 backup 段）。
 *
 * 后端持有的 Key 只存在于本进程的环境变量（或挂载文件）里，永远不会进入前端产物。
 *
 * 用法：node server/index.mjs
 */

import http from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackupStore, isValidImageId, isValidMemberId } from './backup.mjs'

const defaultDistDir = fileURLToPath(new URL('../dist', import.meta.url))

const PROXY_PREFIX = '/api-proxy'
const BACKUP_PREFIX = '/api/backup'
const ALLOWED_PROXY_METHODS = new Set(['POST', 'OPTIONS'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
}

// 构建产物里等待运行期替换的占位符，与 deploy/inject-api-url.sh 的替换清单保持一致。
const BUNDLE_PLACEHOLDERS = [
  ['__VITE_DEFAULT_API_URL_PLACEHOLDER__', 'defaultApiUrl'],
  ['__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__', 'apiProxyAvailable'],
  ['__VITE_API_PROXY_LOCKED_PLACEHOLDER__', 'apiProxyLocked'],
  ['__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__', 'dockerDeployment'],
  ['__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__', 'dockerLegacyApiUrlUsed'],
  ['__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__', 'showPresetConfigOnly'],
  ['__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__', 'presetConfigParamsLocked'],
  ['__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__', 'presetConfigDeletionPrevented'],
  ['__VITE_LOCK_PRESET_KEY_PLACEHOLDER__', 'presetKeyLocked'],
  ['__VITE_HIDE_API_SETTINGS_PLACEHOLDER__', 'apiSettingsHidden'],
  ['__VITE_BACKEND_FALLBACK_PLACEHOLDER__', 'backendFallback'],
]

function readText(value) {
  return String(value ?? '').trim()
}

function isTruthy(value) {
  return readText(value) === 'true'
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message, type) {
  sendJson(res, status, { error: { message, type } })
}

function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ===== 运行期配置 =====

function readApiKeyFile(path) {
  if (!existsSync(path)) {
    throw new Error(`DEFAULT_API_KEY_FILE 指向的文件不存在：${path}`)
  }
  const key = readFileSync(path, 'utf-8').trim()
  if (!key) {
    throw new Error(`DEFAULT_API_KEY_FILE 指向的文件为空：${path}`)
  }
  return key
}

async function resolveDefaultApiUrl(value) {
  const source = value.trim()
  if (!source) return ''

  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source)
    if (!url.pathname.toLowerCase().endsWith('.json')) return source
    const response = await fetch(source)
    if (!response.ok) throw new Error(`预置配置请求失败：HTTP ${response.status}`)
    return `embedded-config:${Buffer.from(await response.text()).toString('base64')}`
  }

  const path = source.startsWith('file://') ? fileURLToPath(source) : resolve(source)
  if (!existsSync(path)) {
    if (source.startsWith('file://') || source.toLowerCase().endsWith('.json')) {
      throw new Error(`预置配置文件不存在：${path}`)
    }
    return source
  }
  return `embedded-config:${readFileSync(path).toString('base64')}`
}

export async function resolveServerConfig(options = {}) {
  const env = options.env ?? process.env
  // 旧版 Docker 变量 API_URL 作为兜底值，与上游 migrate-api-env 行为一致。
  const legacyApiUrl = readText(env.API_URL)
  // API_PROXY_URL 在上游就是「真实地址只存在于这里」的那个变量，容器 runtime 换成 Node 后
  // 由本进程接手，语义正好就是后端持有的上游地址。
  const proxyApiUrl = readText(env.API_PROXY_URL)
  const apiKeyFile = readText(env.DEFAULT_API_KEY_FILE)
  const envApiKey = readText(env.DEFAULT_API_KEY)
  const apiKey = options.apiKey !== undefined ? options.apiKey : apiKeyFile ? readApiKeyFile(apiKeyFile) : envApiKey || null
  const apiProxyEnabled = isTruthy(env.ENABLE_API_PROXY)

  return {
    host: readText(options.host ?? env.HOST) || '0.0.0.0',
    port: Number(options.port ?? env.PORT ?? 3000),
    distDir: resolve(options.distDir ?? (readText(env.DIST_DIR) || defaultDistDir)),
    dataDir: resolve(options.dataDir ?? (readText(env.DATA_DIR) || '/data')),
    // 后端持有的上游地址。主变量与上游一致，API_URL 只作旧配置的兜底，
    // 顺序反过来的话，照旧变量配的人会被当成「用了弃用变量」而收到迁移提示。
    apiUrl: readText(options.apiUrl) || proxyApiUrl || legacyApiUrl,
    apiKey,
    proxyTimeoutMs: Number(readText(env.PROXY_TIMEOUT_MS) || 600_000),
    bundleValues: {
      defaultApiUrl: await resolveDefaultApiUrl(readText(options.defaultApiUrl ?? env.DEFAULT_API_URL)),
      // 代理开关只由 ENABLE_API_PROXY 决定，与上游语义一致；后端配了 Key 不再隐式打开它。
      apiProxyAvailable: apiProxyEnabled ? 'true' : 'false',
      apiProxyLocked: apiProxyEnabled && isTruthy(env.LOCK_API_PROXY) ? 'true' : 'false',
      dockerDeployment: 'true',
      dockerLegacyApiUrlUsed: legacyApiUrl ? 'true' : 'false',
      showPresetConfigOnly: isTruthy(env.SHOW_PRESET_CONFIG_ONLY) || isTruthy(env.SHOW_DEFAULT_CONFIG_ONLY) ? 'true' : 'false',
      presetConfigParamsLocked: isTruthy(env.LOCK_PRESET_CONFIG_PARAMS) ? 'true' : 'false',
      presetConfigDeletionPrevented: isTruthy(env.PREVENT_PRESET_CONFIG_DELETION) ? 'true' : 'false',
      presetKeyLocked: isTruthy(env.LOCK_PRESET_KEY) ? 'true' : 'false',
      apiSettingsHidden: isTruthy(env.HIDE_API_SETTINGS) ? 'true' : 'false',
      // 后端持有 Key 时前端才可以留空。它只放宽校验，不参与锁定——前端填了 Key 依然优先。
      backendFallback: apiKey ? 'true' : 'false',
    },
  }
}

function escapeForJsString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[$`]/g, '\\$&')
}

/**
 * 把构建产物里的占位符换成运行期取值。
 *
 * 上游用 deploy/inject-api-url.sh 做同一件事；容器 runtime 换成 Node 后，这件事改由本进程
 * 在启动时完成，前端代码因此仍然一字不改。
 */
export function injectBundleConfig(distDir, values) {
  const assetsDir = join(distDir, 'assets')
  if (!existsSync(assetsDir)) return 0

  let replaced = 0
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith('.js')) continue
    const path = join(assetsDir, name)
    const original = readFileSync(path, 'utf-8')
    let next = original
    for (const [placeholder, key] of BUNDLE_PLACEHOLDERS) {
      if (!next.includes(placeholder)) continue
      next = next.split(placeholder).join(escapeForJsString(values[key] ?? ''))
    }
    if (next === original) continue
    writeFileSync(path, next)
    replaced++
  }
  return replaced
}

// ===== 静态托管 =====

function resolveStaticFile(distDir, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.split('?')[0].includes('\0')) return null

  const candidate = resolve(distDir, `.${decoded}`)
  // 拒绝越出 distDir 的路径，避免目录穿越。
  if (candidate !== distDir && !candidate.startsWith(`${distDir}/`)) return null
  if (!existsSync(candidate)) return null

  const stats = statSync(candidate)
  if (stats.isDirectory()) {
    const index = join(candidate, 'index.html')
    return existsSync(index) ? index : null
  }
  return stats.isFile() ? candidate : null
}

function sendFile(req, res, path, { immutable = false } = {}) {
  const headers = {
    'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path).pipe(res)
}

function handleStatic(req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, '只支持 GET / HEAD 请求', 'method_not_allowed')
    return
  }

  const urlPath = req.url.split('?')[0]
  const file = resolveStaticFile(config.distDir, urlPath)
  if (file && !file.endsWith('index.html')) {
    sendFile(req, res, file, { immutable: urlPath.startsWith('/assets/') })
    return
  }

  // SPA fallback：深链接交给前端路由。
  const indexHtml = join(config.distDir, 'index.html')
  if (!existsSync(indexHtml)) {
    sendError(res, 404, `构建产物不存在，请先运行构建或检查 DIST_DIR：${config.distDir}`, 'dist_missing')
    return
  }
  sendFile(req, res, indexHtml)
}

// ===== API 代理 =====

function buildUpstreamTarget(apiUrl, reqUrl) {
  const rest = reqUrl.slice(PROXY_PREFIX.length + 1)
  if (!rest) return { error: 'API 代理路径不能为空' }
  try {
    return { target: new URL(`${apiUrl.replace(/\/+$/, '')}/${rest}`) }
  } catch {
    return { error: `代理未配置可用的上游地址，无法转发请求。请为服务端设置 API_PROXY_URL 后重启。（当前值：${apiUrl || '空'}）` }
  }
}

function filterRequestHeaders(headers, target, apiKey, remoteAddress) {
  const filtered = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'host' || name === 'authorization') continue
    filtered[name] = value
  }
  filtered.host = target.host
  // 前端带了自己的 Key 就用它的；没带才用后端持有的，这是「前端优先」的落点。
  // 注意空 Key 时前端仍会发出 `Bearer `，所以要按 token 是否为空判断，而不是按头是否存在。
  const forwardedToken = readBearerToken(headers.authorization)
  filtered.authorization = `Bearer ${forwardedToken || apiKey}`
  const forwardedFor = [headers['x-forwarded-for'], remoteAddress].filter(Boolean).join(', ')
  if (forwardedFor) filtered['x-forwarded-for'] = forwardedFor
  return filtered
}

function readBearerToken(header) {
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.*)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

function filterResponseHeaders(headers) {
  const filtered = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
    filtered[name] = value
  }
  return filtered
}

function handleProxy(req, res, config) {
  if (!ALLOWED_PROXY_METHODS.has(req.method)) {
    sendError(res, 403, 'API 代理只接受 POST 请求', 'proxy_method_not_allowed')
    return
  }

  const { target, error } = buildUpstreamTarget(config.apiUrl, req.url)
  if (error) {
    sendError(res, 503, error, 'backend_upstream_missing')
    return
  }
  // 前端自带 Key 时后端不需要持有：这条代理只负责转发和补地址。
  if (!config.apiKey && !readBearerToken(req.headers.authorization)) {
    sendError(
      res,
      503,
      '代理未收到可用的 API Key。请在设置页填写，或为服务端设置 DEFAULT_API_KEY / DEFAULT_API_KEY_FILE 后重启。',
      'api_key_missing',
    )
    return
  }

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: filterRequestHeaders(req.headers, target, config.apiKey, req.socket.remoteAddress),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, filterResponseHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
    },
  )

  upstream.setTimeout(config.proxyTimeoutMs, () => {
    upstream.destroy(new Error('上游请求超时'))
  })
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendError(res, 502, `上游请求失败：${error.message}`, 'upstream_unreachable')
  })
  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

// ===== 备份 API =====

/**
 * 成员码只做格式校验后直接用作目录名。
 *
 * 它不承担凭证职责：没有白名单，首次出现的成员码即建立命名空间，后端 Key 也不在备份里，
 * 因此猜到别人的成员码的后果被限制在「看到该成员的图片」，不会升级为 Key 泄漏。
 */
function resolveMemberId(req) {
  const raw = req.headers['x-member-id']
  const memberId = Array.isArray(raw) ? raw[0] : raw
  if (!memberId || !isValidMemberId(memberId)) return null
  return memberId
}

function sendBytes(res, status, contentType, bytes) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  })
  res.end(bytes)
}

async function handleBackup(req, res, store) {
  // 能力探测：前端用它决定要不要显示成员码与同步。放在成员校验之前，
  // 因为「服务器在不在」与「你是哪个成员」是两回事。
  const routePath = req.url.split('?')[0]
  if (routePath === `${BACKUP_PREFIX}/ping`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, '只支持 GET 请求', 'method_not_allowed')
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }

  const memberId = resolveMemberId(req)
  if (!memberId) {
    sendError(res, 400, '缺少或非法的 X-Member-Id 请求头', 'member_id_invalid')
    return
  }

  const rest = req.url.split('?')[0].slice(BACKUP_PREFIX.length)
  const segments = rest.split('/').filter(Boolean)

  if (segments[0] === 'manifest' && segments.length === 1) {
    if (req.method !== 'GET') {
      sendError(res, 405, '只支持 GET 请求', 'method_not_allowed')
      return
    }
    const state = store.readState(memberId)
    sendJson(res, 200, {
      images: store.listImageIds(memberId),
      state: state ? { version: state.version, updatedAt: state.updatedAt } : null,
    })
    return
  }

  if (segments[0] === 'state' && segments.length === 1) {
    if (req.method === 'GET') {
      const state = store.readState(memberId)
      if (!state) {
        sendError(res, 404, '该成员还没有状态快照', 'state_not_found')
        return
      }
      sendJson(res, 200, state)
      return
    }
    if (req.method === 'PUT') {
      const expectedHeader = req.headers['if-match']
      const expectedVersion = expectedHeader === undefined
        ? null
        : Number(Array.isArray(expectedHeader) ? expectedHeader[0] : expectedHeader)
      if (expectedVersion !== null && !Number.isFinite(expectedVersion)) {
        sendError(res, 400, 'If-Match 必须是状态快照的版本号', 'if_match_invalid')
        return
      }

      let payload
      try {
        payload = JSON.parse((await readRequestBody(req)).toString('utf-8') || 'null')
      } catch {
        sendError(res, 400, '状态快照不是合法的 JSON', 'state_invalid_json')
        return
      }
      if (!payload || typeof payload !== 'object' || !('data' in payload)) {
        sendError(res, 400, '状态快照缺少 data 字段', 'state_invalid_shape')
        return
      }

      const result = store.writeState(memberId, payload.data, expectedVersion)
      if (result.conflict) {
        sendError(res, 409, '状态快照版本已变化，请先重新拉取', 'state_version_conflict')
        return
      }
      sendJson(res, 200, { version: result.state.version, updatedAt: result.state.updatedAt })
      return
    }
    sendError(res, 405, '只支持 GET / PUT 请求', 'method_not_allowed')
    return
  }

  if (segments[0] === 'images' && segments.length === 2) {
    const imageId = segments[1]
    if (!isValidImageId(imageId)) {
      sendError(res, 400, '非法的图片 id', 'image_id_invalid')
      return
    }

    if (req.method === 'HEAD') {
      store.ensureMember(memberId)
      res.writeHead(store.hasImage(memberId, imageId) ? 200 : 404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (req.method === 'GET') {
      const bytes = store.readImage(memberId, imageId)
      if (!bytes) {
        sendError(res, 404, '图片不存在', 'image_not_found')
        return
      }
      sendBytes(res, 200, 'application/octet-stream', bytes)
      return
    }
    if (req.method === 'PUT') {
      const bytes = await readRequestBody(req)
      if (bytes.length === 0) {
        sendError(res, 400, '图片内容为空', 'image_empty')
        return
      }
      const result = store.writeImage(memberId, imageId, bytes)
      sendJson(res, result.created ? 201 : 200, { id: imageId, created: result.created })
      return
    }
    sendError(res, 405, '只支持 HEAD / GET / PUT 请求', 'method_not_allowed')
    return
  }

  sendError(res, 404, `未知的备份接口：${rest}`, 'backup_route_not_found')
}

// ===== 服务实例 =====

export async function createServer(options = {}) {
  const config = await resolveServerConfig(options)
  injectBundleConfig(config.distDir, config.bundleValues)
  const backupStore = options.backupStore ?? createBackupStore(config.dataDir)

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0]
    if (urlPath === PROXY_PREFIX || urlPath.startsWith(`${PROXY_PREFIX}/`)) {
      handleProxy(req, res, config)
      return
    }
    if (urlPath === BACKUP_PREFIX || urlPath.startsWith(`${BACKUP_PREFIX}/`)) {
      handleBackup(req, res, backupStore).catch((error) => {
        console.warn('[backup] 请求处理失败：', error)
        if (!res.headersSent) sendError(res, 500, `备份请求处理失败：${error.message}`, 'backup_internal_error')
      })
      return
    }
    handleStatic(req, res, config)
  })
  server.requestTimeout = config.proxyTimeoutMs
  server.headersTimeout = 60_000

  return {
    server,
    config,
    listen() {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject)
          resolveListen()
        })
      })
    },
    get port() {
      const address = server.address()
      return address && typeof address === 'object' ? address.port : config.port
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  createServer()
    .then(async (instance) => {
      await instance.listen()
      console.log(`服务已启动：http://${instance.config.host === '0.0.0.0' ? 'localhost' : instance.config.host}:${instance.port}`)
      console.log(`上游地址：${instance.config.apiUrl || '（未配置，代理请求会被拒绝）'}`)
      console.log(`备份数据目录：${instance.config.dataDir}`)
    })
    .catch((error) => {
      console.error(`服务启动失败：${error.message}`)
      process.exit(1)
    })
}
