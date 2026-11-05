// 生成提示词模板缩略图：下载模板库引用的全部示例图，压缩为 256px WebP 存入 public/templates/。
// 图片清单直接取运行时导出的 BUILT_IN_PROMPT_TEMPLATES（经过去重与排除），文件名取 thumbnailUrl，
// 与 src/lib/promptTemplates.ts 的 getTemplateThumbnailUrl() 天然同步，不再重复实现哈希。
// 用法：node scripts/generateTemplateThumbs.mjs [--force]
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { createServer } from 'vite'

const proxyUrl = process.env.https_proxy || process.env.http_proxy || process.env.ALL_PROXY
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public', 'templates')
const THUMB_SIZE = 256
const THUMB_QUALITY = 78
const CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 30_000
const FORCE = process.argv.includes('--force')

// 用 Vite 的 SSR 加载器读 TS 模块，避免在脚本里重复实现模板数据的拼装规则
async function loadTemplates() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const mod = await server.ssrLoadModule('/src/lib/promptTemplates.ts')
    return mod.BUILT_IN_PROMPT_TEMPLATES
  } finally {
    await server.close()
  }
}

function collectEntries(templates) {
  const entries = new Map()
  for (const template of templates) {
    if (!template.imageUrl || !template.thumbnailUrl) continue
    entries.set(path.basename(template.thumbnailUrl), template.imageUrl)
  }
  return [...entries].map(([filename, url]) => ({ filename, url }))
}

// jsdmirror 镜像不稳时回退 raw.githubusercontent.com
function toRawGithubUrl(url) {
  const match = url.match(/^https:\/\/cdn\.jsdmirror\.com\/gh\/([^/]+)\/([^@]+)@([^/]+)\/(.+)$/)
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}` : null
}

async function download(url) {
  const fetchFn = proxyDispatcher ? (u, opts) => undiciFetch(u, { dispatcher: proxyDispatcher, ...opts }) : fetch
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (err) {
    const rawUrl = toRawGithubUrl(url)
    if (!rawUrl) throw err
    const response = await fetchFn(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}（镜像与 raw 均失败）`)
    return Buffer.from(await response.arrayBuffer())
  }
}

async function mapPool(items, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await worker(item)
    }
  })
  await Promise.all(runners)
}

const entries = collectEntries(await loadTemplates())
if (entries.length === 0) {
  console.warn('没有从 BUILT_IN_PROMPT_TEMPLATES 读到任何示例图，请检查模板数据。')
  process.exit(1)
}

await mkdir(OUT_DIR, { recursive: true })

const keptFiles = new Set()
const failures = []
let downloaded = 0
let skipped = 0

console.log(`共 ${entries.length} 张原图，输出目录 ${path.relative(ROOT, OUT_DIR)}/`)

await mapPool(entries, async ({ filename, url }) => {
  const dest = path.join(OUT_DIR, filename)
  keptFiles.add(filename)

  if (!FORCE && existsSync(dest)) {
    skipped += 1
    return
  }

  try {
    const buffer = await download(url)
    await sharp(buffer)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
      .webp({ quality: THUMB_QUALITY })
      .toFile(dest)
    downloaded += 1
  } catch (err) {
    // 单张失败不致命：运行时该模板会先加载缩略图、再回退原图
    failures.push(`${url}\n    ${err.message}`)
  }
})

// 清理不再被引用的旧缩略图
let removed = 0
for (const file of await readdir(OUT_DIR)) {
  if (file.endsWith('.webp') && !keptFiles.has(file)) {
    await rm(path.join(OUT_DIR, file))
    removed += 1
  }
}

let totalBytes = 0
for (const file of await readdir(OUT_DIR)) {
  if (file.endsWith('.webp')) totalBytes += (await stat(path.join(OUT_DIR, file))).size
}

console.log(`完成：新下载 ${downloaded}，已存在跳过 ${skipped}，失败 ${failures.length}，清理旧文件 ${removed}。`)
console.log(`缩略图总体积 ${(totalBytes / 1024 / 1024).toFixed(2)} MB。`)

if (failures.length > 0) {
  console.warn(`\n以下 ${failures.length} 张下载失败（运行时会回退加载原图，可稍后用 --force 重试）：`)
  for (const message of failures) console.warn(`  - ${message}`)
}
