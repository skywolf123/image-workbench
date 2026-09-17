#!/usr/bin/env node
/**
 * 自部署服务端。
 *
 * 一个零第三方依赖的 Node 进程，同时承担四件事：
 *
 * 1. 静态托管构建产物（含 SPA fallback）—— 取代上游容器里的 Nginx。
 * 2. `/api-proxy/*`：上游自带的代理功能，保持纯转发语义——前端自带 Key 原样透传，
 *    本进程不注入、不拦截，上游的 401 如实到达前端。
 * 3. `/api/gateway/*`：本部署的网关——转发到 GATEWAY_API_URL，前端没带 Key 时注入
 *    GATEWAY_API_KEY。是否可用只由 GATEWAY_API_KEY 决定，与 ENABLE_API_PROXY 无关。
 * 4. `/api/sync/*`：多设备同步的权威端（活跃集合并、回收站、图片仓库）。
 *
 * 网关与同步持有的秘密只存在于本进程的环境变量（或挂载文件）里，永远不会进入前端产物。
 *
 * 用法：node server/index.mjs
 */

import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemberLock, createSyncStore, isValidImageId, isValidMemberId, isValidTaskId } from './sync.mjs'

const defaultDistDir = fileURLToPath(new URL('../dist', import.meta.url))

const PROXY_PREFIX = '/api-proxy'
const GATEWAY_PREFIX = '/api/gateway'
const SYNC_PREFIX = '/api/sync'
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

function readKeyFile(path, envName) {
  if (!existsSync(path)) {
    throw new Error(`${envName} 指向的文件不存在：${path}`)
  }
  const key = readFileSync(path, 'utf-8').trim()
  if (!key) {
    throw new Error(`${envName} 指向的文件为空：${path}`)
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
  // API_PROXY_URL 只属于上游的 /api-proxy，是「真实地址只存在于这里」的那个变量。
  const proxyApiUrl = readText(env.API_PROXY_URL)
  // 网关的地址与 Key 完全独立成套，不复用代理的任何变量。
  const gatewayApiUrl = readText(options.gatewayApiUrl ?? env.GATEWAY_API_URL)
  const gatewayKeyFile = readText(env.GATEWAY_API_KEY_FILE)
  const envGatewayKey = readText(env.GATEWAY_API_KEY)
  const gatewayApiKey = options.gatewayApiKey !== undefined
    ? options.gatewayApiKey
    : gatewayKeyFile ? readKeyFile(gatewayKeyFile, 'GATEWAY_API_KEY_FILE') : envGatewayKey || null
  const apiProxyEnabled = isTruthy(env.ENABLE_API_PROXY)

  // 旧变量改名失效：静默迁移会静默改变计费主体，只提示不代搬。
  const warnings = []
  if ((readText(env.DEFAULT_API_KEY) || readText(env.DEFAULT_API_KEY_FILE)) && !gatewayApiKey) {
    warnings.push('检测到 DEFAULT_API_KEY / DEFAULT_API_KEY_FILE：后端 Key 已改由 GATEWAY_API_KEY / GATEWAY_API_KEY_FILE 提供，请改名后重启。')
  }
  if (gatewayApiKey && !gatewayApiUrl) {
    warnings.push('已配置 GATEWAY_API_KEY 但未配置 GATEWAY_API_URL：网关请求会因缺少转发目标被拒绝。')
  }

  return {
    host: readText(options.host ?? env.HOST) || '0.0.0.0',
    port: Number(options.port ?? env.PORT ?? 3000),
    distDir: resolve(options.distDir ?? (readText(env.DIST_DIR) || defaultDistDir)),
    dataDir: resolve(options.dataDir ?? (readText(env.DATA_DIR) || '/data')),
    // 上游代理持有的转发地址，只服务 /api-proxy。
    apiUrl: readText(options.apiUrl) || proxyApiUrl || legacyApiUrl,
    gatewayApiUrl,
    gatewayApiKey,
    proxyTimeoutMs: Number(readText(env.PROXY_TIMEOUT_MS) || 600_000),
    warnings,
    bundleValues: {
      defaultApiUrl: await resolveDefaultApiUrl(readText(options.defaultApiUrl ?? env.DEFAULT_API_URL)),
      // 代理开关只由 ENABLE_API_PROXY 决定，与上游语义一致；网关配了 Key 不再隐式打开它。
      apiProxyAvailable: apiProxyEnabled ? 'true' : 'false',
      apiProxyLocked: apiProxyEnabled && isTruthy(env.LOCK_API_PROXY) ? 'true' : 'false',
      dockerDeployment: 'true',
      dockerLegacyApiUrlUsed: legacyApiUrl ? 'true' : 'false',
      showPresetConfigOnly: isTruthy(env.SHOW_PRESET_CONFIG_ONLY) || isTruthy(env.SHOW_DEFAULT_CONFIG_ONLY) ? 'true' : 'false',
      presetConfigParamsLocked: isTruthy(env.LOCK_PRESET_CONFIG_PARAMS) ? 'true' : 'false',
      presetConfigDeletionPrevented: isTruthy(env.PREVENT_PRESET_CONFIG_DELETION) ? 'true' : 'false',
      presetKeyLocked: isTruthy(env.LOCK_PRESET_KEY) ? 'true' : 'false',
      apiSettingsHidden: isTruthy(env.HIDE_API_SETTINGS) ? 'true' : 'false',
      // 网关持有 Key 时前端才可以留空。它只放宽校验，不参与锁定——前端填了 Key 依然优先。
      backendFallback: gatewayApiKey ? 'true' : 'false',
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

// ===== 转发（上游代理与网关共用传输层） =====

function buildUpstreamTarget(apiUrl, reqUrl, prefix, urlEnvName) {
  const rest = reqUrl.slice(prefix.length + 1)
  if (!rest) return { error: '转发路径不能为空' }
  try {
    const target = new URL(`${apiUrl.replace(/\/+$/, '')}/${rest}`)
    // 只支持 http/https：其他协议交给对应模块时会抛同步异常。
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return { error: `${urlEnvName} 的协议不受支持：${target.protocol}。请填写 http:// 或 https:// 开头的地址。` }
    }
    return { target }
  } catch {
    return { error: `未配置可用的上游地址，无法转发请求。请为服务端设置 ${urlEnvName} 后重启。（当前值：${apiUrl || '空'}）` }
  }
}

function readBearerToken(header) {
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.*)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

function filterForwardHeaders(headers, target, injectKey, remoteAddress) {
  const filtered = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'host' || name === 'authorization') continue
    filtered[name] = value
  }
  filtered.host = target.host
  if (injectKey) {
    // 网关：前端带了自己的 Key 就用它的，没带才注入后端持有的。
    // 注意空 Key 时前端仍会发出 `Bearer `，所以要按 token 是否为空判断，而不是按头是否存在。
    const forwardedToken = readBearerToken(headers.authorization)
    filtered.authorization = `Bearer ${forwardedToken || injectKey}`
  } else if (headers.authorization !== undefined) {
    // 纯代理：Authorization 原样透传，注入不是这里的事。
    filtered.authorization = headers.authorization
  }
  const forwardedFor = [headers['x-forwarded-for'], remoteAddress].filter(Boolean).join(', ')
  if (forwardedFor) filtered['x-forwarded-for'] = forwardedFor
  return filtered
}

function filterResponseHeaders(headers) {
  const filtered = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
    filtered[name] = value
  }
  return filtered
}

/**
 * 两个转发路由的公共实现。
 *
 * route.injectKey 为真值时是网关（前端 Key 优先，空则注入）；为空时是纯代理
 * （Authorization 原样透传，两边都没 Key 不拦，让上游的 401 如实到达前端）。
 */
function handleForward(req, res, config, route) {
  if (!ALLOWED_PROXY_METHODS.has(req.method)) {
    sendError(res, 403, '转发只接受 POST 请求', 'proxy_method_not_allowed')
    return
  }

  const { target, error } = buildUpstreamTarget(route.apiUrl, req.url, route.prefix, route.urlEnvName)
  if (error) {
    sendError(res, 503, error, 'backend_upstream_missing')
    return
  }

  const forwardedToken = readBearerToken(req.headers.authorization)
  // 缺 Key 的拦截只属于网关；纯代理不拦，让上游的 401 如实到达前端。
  if (route.requireKey && !route.injectKey && !forwardedToken) {
    sendError(
      res,
      503,
      `网关未收到可用的 API Key。请在设置页填写，或为服务端设置 ${route.keyEnvName} / ${route.keyEnvName}_FILE 后重启。`,
      'api_key_missing',
    )
    return
  }

  // 上游多是 https，node:http 的 request 遇到 https 协议会同步抛 ERR_INVALID_PROTOCOL，
  // 而同步异常接不到下面的 'error' 事件上，会直接把进程带崩，所以必须先按协议选模块。
  const transport = target.protocol === 'https:' ? https : http
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: filterForwardHeaders(req.headers, target, route.injectKey || null, req.socket.remoteAddress),
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

// ===== 同步 API =====

/**
 * 成员码只做格式校验后直接用作目录名。
 *
 * 它不承担凭证职责：没有白名单，首次出现的成员码即建立命名空间，后端 Key 也不在
 * 同步数据里，因此猜到别人的成员码的后果被限制在「看到该成员的数据」，不会升级为 Key 泄漏。
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

async function handleSync(req, res, store, runLocked) {
  const routePath = req.url.split('?')[0]
  const segments = routePath.slice(SYNC_PREFIX.length).split('/').filter(Boolean)

  const isSyncPush = segments.length === 0 || (segments[0] === 'sync' && segments.length === 1)
  // 能力探测：GET /api/sync 与 GET /api/sync/ping 等价。放在成员校验之前，
  // 因为「服务器在不在」与「你是哪个成员」是两回事；POST /api/sync 是同步推送主路径，不算探测。
  const isPing = (segments.length === 0 || segments[0] === 'ping') && !isSyncPush
  if (isPing) {
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

  if (segments[0] === 'manifest' && segments.length === 1) {
    if (req.method !== 'GET') {
      sendError(res, 405, '只支持 GET 请求', 'method_not_allowed')
      return
    }
    const state = store.readActive(memberId)
    sendJson(res, 200, {
      images: store.listImageIds(memberId),
      version: state.version,
      updatedAt: state.updatedAt,
    })
    return
  }

  if (isSyncPush) {
    if (req.method !== 'POST') {
      sendError(res, 405, '只支持 POST 请求', 'method_not_allowed')
      return
    }

    let body
    try {
      body = JSON.parse((await readRequestBody(req)).toString('utf-8') || '{}')
    } catch {
      sendError(res, 400, '同步请求不是合法的 JSON', 'sync_invalid_json')
      return
    }
    const changedTasks = body.changedTasks ?? []
    const deletedTaskIds = body.deletedTaskIds ?? []
    if (!Array.isArray(changedTasks) || !Array.isArray(deletedTaskIds)) {
      sendError(res, 400, 'changedTasks 与 deletedTaskIds 必须是数组', 'sync_body_invalid')
      return
    }
    for (const task of changedTasks) {
      if (!task || typeof task !== 'object' || !isValidTaskId(task.id)) {
        sendError(res, 400, '变更任务缺少合法的 id', 'sync_task_invalid')
        return
      }
    }
    for (const id of deletedTaskIds) {
      if (!isValidTaskId(id)) {
        sendError(res, 400, '删除列表里有非法的任务 id', 'sync_task_invalid')
        return
      }
    }

    const { state } = await runLocked(memberId, () => store.mergeSync(memberId, changedTasks, deletedTaskIds))
    sendJson(res, 200, { version: state.version, updatedAt: state.updatedAt, tasks: state.tasks })
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

  if (segments[0] === 'trash') {
    if (segments.length === 1) {
      if (req.method === 'GET') {
        const items = await runLocked(memberId, () => store.listTrash(memberId))
        sendJson(res, 200, { items })
        return
      }
      if (req.method === 'DELETE') {
        // 清空是不可逆操作，必须原样回输成员码确认。
        let body
        try {
          body = JSON.parse((await readRequestBody(req)).toString('utf-8') || '{}')
        } catch {
          body = null
        }
        if (!body || body.confirm !== memberId) {
          sendError(res, 400, '成员码确认不匹配，回收站未清空。', 'confirm_mismatch')
          return
        }
        const removed = await runLocked(memberId, () => store.emptyTrash(memberId))
        sendJson(res, 200, { removed })
        return
      }
      sendError(res, 405, '只支持 GET / DELETE 请求', 'method_not_allowed')
      return
    }

    if (segments.length === 3 && segments[2] === 'restore') {
      if (req.method !== 'POST') {
        sendError(res, 405, '只支持 POST 请求', 'method_not_allowed')
        return
      }
      const taskId = segments[1]
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, '非法的任务 id', 'task_id_invalid')
        return
      }
      const restored = await runLocked(memberId, () => store.restoreFromTrash(memberId, taskId))
      if (!restored) {
        sendError(res, 404, '回收站里没有这个任务', 'trash_entry_not_found')
        return
      }
      sendJson(res, 200, { ok: true, task: restored })
      return
    }
  }

  sendError(res, 404, `未知的同步接口：${routePath.slice(SYNC_PREFIX.length)}`, 'sync_route_not_found')
}

// ===== 服务实例 =====

export async function createServer(options = {}) {
  const config = await resolveServerConfig(options)
  for (const warning of config.warnings) console.warn(`[启动] ${warning}`)
  injectBundleConfig(config.distDir, config.bundleValues)
  const syncStore = options.syncStore ?? createSyncStore(config.dataDir)
  const runLocked = createMemberLock()

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0]
    if (urlPath === PROXY_PREFIX || urlPath.startsWith(`${PROXY_PREFIX}/`)) {
      // 兜住同步异常：转发出一个错不该把整个进程带走，其他请求还得继续服务。
      try {
        handleForward(req, res, config, { prefix: PROXY_PREFIX, apiUrl: config.apiUrl, injectKey: null, requireKey: false, urlEnvName: 'API_PROXY_URL', keyEnvName: 'GATEWAY_API_KEY' })
      } catch (error) {
        console.error('[proxy] 请求处理失败：', error)
        if (!res.headersSent) sendError(res, 502, `API 代理处理失败：${error.message}`, 'proxy_internal_error')
      }
      return
    }
    if (urlPath === GATEWAY_PREFIX || urlPath.startsWith(`${GATEWAY_PREFIX}/`)) {
      try {
        handleForward(req, res, config, { prefix: GATEWAY_PREFIX, apiUrl: config.gatewayApiUrl, injectKey: config.gatewayApiKey, requireKey: true, urlEnvName: 'GATEWAY_API_URL', keyEnvName: 'GATEWAY_API_KEY' })
      } catch (error) {
        console.error('[gateway] 请求处理失败：', error)
        if (!res.headersSent) sendError(res, 502, `网关处理失败：${error.message}`, 'gateway_internal_error')
      }
      return
    }
    if (urlPath === SYNC_PREFIX || urlPath.startsWith(`${SYNC_PREFIX}/`)) {
      handleSync(req, res, syncStore, runLocked).catch((error) => {
        console.warn('[sync] 请求处理失败：', error)
        if (!res.headersSent) sendError(res, 500, `同步请求处理失败：${error.message}`, 'sync_internal_error')
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
      console.log(`代理上游（/api-proxy）：${instance.config.apiUrl || '（未配置 API_PROXY_URL，代理请求会被拒绝）'}`)
      console.log(`网关上游（/api/gateway）：${instance.config.gatewayApiUrl || '（未配置 GATEWAY_API_URL，网关请求会被拒绝）'}`)
      console.log(`同步数据目录：${instance.config.dataDir}`)
    })
    .catch((error) => {
      console.error(`服务启动失败：${error.message}`)
      process.exit(1)
    })
}
