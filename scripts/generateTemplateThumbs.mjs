// 生成提示词模板缩略图：下载数据文件里引用的全部示例图，压缩为 256px WebP 存入 public/templates/。
// 文件名由原图 URL 哈希决定，运行时 src/lib/promptTemplates.ts 的 getTemplateThumbnailUrl()
// 用同一哈希拼路径，因此改URL或哈希时两边必须同步修改。
// 用法：pnpm add -D sharp && node scripts/generateTemplateThumbs.mjs [--force]
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILES = [
  'src/lib/promptTemplateData.ts',
  'src/lib/houshifangPromptTemplates.ts',
  'src/lib/kkkmPromptTemplates.ts',
]
const OUT_DIR = path.join(ROOT, 'public', 'templates')
const THUMB_SIZE = 256
const THUMB_QUALITY = 78
const CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 30_000
const FORCE = process.argv.includes('--force')

// 与 src/lib/promptTemplates.ts 的 normalizeGithubImageUrl 保持一致
function normalizeGithubImageUrl(url) {
  const freestyleImagePrefix = 'https://cdn.jsdmirror.com/gh/freestylefly/awesome-gpt-image-2@main/images/'
  if (url.startsWith(freestyleImagePrefix)) {
    return url.replace('@main/images/', '@main/data/images/')
  }

  const rawPrefix = 'https://raw.githubusercontent.com/'
  if (url.startsWith(rawPrefix)) {
    const parts = url.slice(rawPrefix.length).split('/')
    const [owner, repo, branch, ...pathParts] = parts
    if (owner && repo && branch && pathParts.length > 0) {
      return `https://cdn.jsdmirror.com/gh/${owner}/${repo}@${branch}/${pathParts.join('/')}`
    }
  }

  const githubBlobMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (githubBlobMatch) {
    const [, owner, repo, branch, filePath] = githubBlobMatch
    return `https://cdn.jsdmirror.com/gh/${owner}/${repo}@${branch}/${filePath}`
  }

  return url
}

// 与运行时 getTemplateThumbnailHash 保持一致
function thumbFilename(url) {
  let hash = 0x811c9dc5
  for (let idx = 0; idx < url.length; idx += 1) {
    hash ^= url.charCodeAt(idx)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `t-${hash.toString(16)}-${url.length}.webp`
}

function collectUrls() {
  const urls = new Set()
  for (const relFile of DATA_FILES) {
    const text = readFileSync(path.join(ROOT, relFile), 'utf-8')
    // promptTemplateData.ts 里的完整 URL 字面量
    for (const match of text.matchAll(/["']imageUrl["']:\s*["']([^"']+)["']/g)) {
      urls.add(match[1])
    }
    // kkkm / houshifang 只有 imagePath 相对路径，拼上各自文件里的 IMAGE_BASE_URL 常量
    const baseMatch = text.match(/IMAGE_BASE_URL\s*=\s*["']([^"']+)["']/)
    if (baseMatch) {
      for (const match of text.matchAll(/["']?imagePath["']?:\s*["']([^"']+)["']/g)) {
        urls.add(`${baseMatch[1]}${match[1].replace(/^\/+/, '')}`)
      }
    }
  }
  return [...urls].map(normalizeGithubImageUrl)
}

// jsdmirror 镜像不稳时回退 raw.githubusercontent.com
function toRawGithubUrl(url) {
  const match = url.match(/^https:\/\/cdn\.jsdmirror\.com\/gh\/([^/]+)\/([^@]+)@([^/]+)\/(.+)$/)
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}` : null
}

async function download(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (err) {
    const rawUrl = toRawGithubUrl(url)
    if (!rawUrl) throw err
    const response = await fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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

const urls = collectUrls()
if (urls.length === 0) {
  console.warn('没有从数据文件中提取到任何图片 URL，请检查 DATA_FILES 的正则是否仍然匹配。')
  process.exit(1)
}

await mkdir(OUT_DIR, { recursive: true })

const keptFiles = new Set()
const failures = []
let downloaded = 0
let skipped = 0

console.log(`共 ${urls.length} 张原图，输出目录 ${path.relative(ROOT, OUT_DIR)}/`)

await mapPool(urls, async (url) => {
  const filename = thumbFilename(url)
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
    // 单张失败不致命：运行时该模板会直接加载原图
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
