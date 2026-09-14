/**
 * 备份用的存储层：一个哑巴 blob 仓库。
 *
 * 它不解析任务、不理解提示词、没有用户系统、没有事务。只有三个概念：
 * 列举、按 id 存取图片字节、整份状态快照。
 *
 * 关键性质：
 * - 图片 id 就是内容哈希，所以同 id 即同内容，同步退化成集合求并，没有冲突要解决。
 * - **只增不删**：任何客户端操作都不会删掉已上传的图片。
 * - 图片落盘存的是解码后的原始字节（不是 base64 文本），比浏览器里省约三分之一空间。
 * - 状态快照用「写临时文件 + rename」保证原子性，进程被杀不会留下半个文件。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 成员码只作为命名空间标识，不承担凭证职责，因此只做格式约束。 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 图片 id 由内容哈希决定；crypto.subtle 不可用时上游会退化为 `fallback-<hex>`。 */
const IMAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATE_FILE = 'state.json'
const STATE_TMP_FILE = 'state.json.tmp'

export function isValidMemberId(value) {
  return MEMBER_ID_PATTERN.test(String(value ?? ''))
}

export function isValidImageId(value) {
  return IMAGE_ID_PATTERN.test(String(value ?? '')) && !String(value).includes('..')
}

export function createBackupStore(dataDir) {
  function memberDir(memberId) {
    return join(dataDir, memberId)
  }

  function imagesDir(memberId) {
    return join(memberDir(memberId), 'images')
  }

  /** 按哈希前缀分目录，避免单目录堆积数万个文件。 */
  function imagePath(memberId, imageId) {
    return join(imagesDir(memberId), imageId.slice(0, 2), imageId)
  }

  return {
    dataDir,
    memberDir,
    imagesDir,
    imagePath,

    /** 首次出现的成员码即建立命名空间，没有预置白名单。 */
    ensureMember(memberId) {
      mkdirSync(imagesDir(memberId), { recursive: true })
    },

    listImageIds(memberId) {
      const root = imagesDir(memberId)
      if (!existsSync(root)) return []
      const ids = []
      for (const prefix of readdirSync(root)) {
        const dir = join(root, prefix)
        if (!statSync(dir).isDirectory()) continue
        for (const name of readdirSync(dir)) ids.push(name)
      }
      return ids.sort()
    },

    /** 存在性检查是廉价的：不读图片内容。 */
    hasImage(memberId, imageId) {
      return existsSync(imagePath(memberId, imageId))
    },

    readImage(memberId, imageId) {
      const path = imagePath(memberId, imageId)
      if (!existsSync(path)) return null
      return readFileSync(path)
    },

    /** 重复上传同一个 id 不产生第二份数据，也不算错误。 */
    writeImage(memberId, imageId, bytes) {
      const path = imagePath(memberId, imageId)
      if (existsSync(path)) return { created: false }
      mkdirSync(join(imagesDir(memberId), imageId.slice(0, 2)), { recursive: true })
      writeFileSync(path, bytes)
      return { created: true }
    },

    readState(memberId) {
      const path = join(memberDir(memberId), STATE_FILE)
      if (!existsSync(path)) return null
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'))
        if (!parsed || typeof parsed !== 'object') return null
        return parsed
      } catch (error) {
        // 快照损坏时按「没有快照」处理，避免把应用整个弄坏。
        console.warn(`[backup] 状态快照无法解析，已忽略：${path}`, error.message)
        return null
      }
    },

    /**
     * 写入状态快照。服务端自增版本号；expectedVersion 不匹配时返回 { conflict: true }。
     */
    writeState(memberId, data, expectedVersion) {
      const current = this.readState(memberId)
      const currentVersion = current?.version ?? 0
      if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== currentVersion) {
        return { conflict: true, current }
      }

      const next = {
        version: currentVersion + 1,
        updatedAt: Date.now(),
        data,
      }
      const dir = memberDir(memberId)
      mkdirSync(dir, { recursive: true })
      // 先写临时文件再 rename：rename 在同一文件系统内是原子的，进程被杀不会留下半个文件。
      const tmpPath = join(dir, STATE_TMP_FILE)
      writeFileSync(tmpPath, JSON.stringify(next))
      renameSync(tmpPath, join(dir, STATE_FILE))
      return { conflict: false, state: next }
    },

    /** 仅测试与运维使用：真实运行路径里没有任何自动删除。 */
    removeMember(memberId) {
      rmSync(memberDir(memberId), { recursive: true, force: true })
    },
  }
}
