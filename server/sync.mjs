/**
 * 同步用的存储与合并引擎。
 *
 * 服务端是活跃数据集的权威：客户端推送变更意图（改动的任务、删除的任务 id），
 * 服务器逐任务合并——内容相同跳过，不同则后写覆盖；删除移入回收站。
 * 回收站是删除的唯一坟墓：还原放回活跃集，清空才真正删除（外科式图片 GC）。
 *
 * 关键性质：
 * - 图片 id 就是内容哈希，图片存储退化成集合求并，没有冲突。
 * - 活跃集与回收站都走「写临时文件 + rename」，进程被杀不会留下半个文件。
 * - 同一成员的写操作经 createMemberLock 串行化，并发合并不会互相丢更新。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 成员码只作为命名空间标识，不承担凭证职责，因此只做格式约束。 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** 图片 id 由内容哈希决定；crypto.subtle 不可用时上游会退化为 `fallback-<hex>`。 */
const IMAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const STATE_FILE = 'state.json'
const STATE_TMP_FILE = 'state.json.tmp'
const TRASH_DIR = 'trash'

export function isValidMemberId(value) {
  return MEMBER_ID_PATTERN.test(String(value ?? ''))
}

export function isValidTaskId(value) {
  return TASK_ID_PATTERN.test(String(value ?? '')) && !String(value).includes('..')
}

export function isValidImageId(value) {
  return IMAGE_ID_PATTERN.test(String(value ?? '')) && !String(value).includes('..')
}

/**
 * 任务记录里指向图片的全部字段。
 *
 * 前端的 addTaskReferencedImageIds 是同一清单的来源，两边必须一起改：
 * GC 漏掉一个字段就会把还在使用的图片当垃圾删掉。
 */
const TASK_IMAGE_LIST_FIELDS = ['inputImageIds', 'outputImages', 'transparentOriginalImages', 'streamPartialImageIds']
const TASK_IMAGE_SINGLE_FIELDS = ['maskTargetImageId', 'maskImageId']

export function collectTaskImageIds(task) {
  const ids = new Set()
  for (const field of TASK_IMAGE_LIST_FIELDS) {
    const value = task[field]
    if (!Array.isArray(value)) continue
    for (const id of value) if (isValidImageId(id)) ids.add(id)
  }
  for (const field of TASK_IMAGE_SINGLE_FIELDS) {
    const id = task[field]
    if (isValidImageId(id)) ids.add(id)
  }
  return ids
}

/** 同一成员的写操作串行化：合并是「读-改-写」，并发跑会互相丢更新。 */
export function createMemberLock() {
  const locks = new Map()
  return function runLocked(memberId, fn) {
    const previous = locks.get(memberId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    // 锁链不向外传播失败，否则一次失败会堵死该成员后续所有写操作。
    locks.set(memberId, next.catch(() => {}))
    return next
  }
}

export function createSyncStore(dataDir) {
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

  function statePath(memberId) {
    return join(memberDir(memberId), STATE_FILE)
  }

  function trashDir(memberId) {
    return join(memberDir(memberId), TRASH_DIR)
  }

  function trashPath(memberId, taskId) {
    return join(trashDir(memberId), `${taskId}.json`)
  }

  function readTrashEntry(memberId, taskId) {
    const path = trashPath(memberId, taskId)
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.task) return null
      return parsed
    } catch (error) {
      console.warn(`[sync] 回收站条目无法解析，已忽略：${path}`, error.message)
      return null
    }
  }

  function writeTrashEntry(memberId, task) {
    mkdirSync(trashDir(memberId), { recursive: true })
    const next = { task, deletedAt: Date.now() }
    const tmpPath = `${trashPath(memberId, task.id)}.tmp`
    writeFileSync(tmpPath, JSON.stringify(next))
    renameSync(tmpPath, trashPath(memberId, task.id))
    return next
  }

  function readActive(memberId) {
    const path = statePath(memberId)
    if (!existsSync(path)) return { version: 0, updatedAt: 0, tasks: [] }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
        return { version: 0, updatedAt: 0, tasks: [] }
      }
      return {
        version: Number.isFinite(parsed.version) ? parsed.version : 0,
        updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        tasks: parsed.tasks,
      }
    } catch (error) {
      // 活跃集损坏时按空处理：客户端会把本地数据重新合并上来，比把应用整个弄坏强。
      console.warn(`[sync] 活跃集无法解析，已按空处理：${path}`, error.message)
      return { version: 0, updatedAt: 0, tasks: [] }
    }
  }

  function writeActive(memberId, tasks) {
    const current = readActive(memberId)
    const next = {
      version: current.version + 1,
      updatedAt: Date.now(),
      tasks,
    }
    mkdirSync(memberDir(memberId), { recursive: true })
    // 先写临时文件再 rename：rename 在同一文件系统内是原子的，进程被杀不会留下半个文件。
    const tmpPath = join(memberDir(memberId), STATE_TMP_FILE)
    writeFileSync(tmpPath, JSON.stringify(next))
    renameSync(tmpPath, statePath(memberId))
    return next
  }

  /**
   * 逐任务合并变更意图。
   *
   * changedTasks 里与现有内容完全相同的任务跳过；不同则后写覆盖（整个任务记录为单位，
   * 不做字段级合并）。被删除的任务整条移入回收站。什么都没变时不写盘、不 bump 版本，
   * 因此重复同步是幂等的。
   */
  function mergeSync(memberId, changedTasks, deletedTaskIds) {
    const current = readActive(memberId)
    const byId = new Map(current.tasks.map((task) => [task.id, task]))
    let changed = false

    for (const task of changedTasks) {
      const existing = byId.get(task.id)
      if (existing && JSON.stringify(existing) === JSON.stringify(task)) continue
      byId.set(task.id, task)
      changed = true
    }

    const trashedIds = []
    for (const id of deletedTaskIds) {
      const task = byId.get(id)
      if (!task) continue
      writeTrashEntry(memberId, task)
      byId.delete(id)
      trashedIds.push(id)
      changed = true
    }

    const state = changed ? writeActive(memberId, [...byId.values()]) : current
    return { state, trashedIds }
  }

  function listTrash(memberId) {
    const dir = trashDir(memberId)
    if (!existsSync(dir)) return []
    const items = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const entry = readTrashEntry(memberId, name.slice(0, -'.json'.length))
      if (!entry) continue
      items.push({
        id: entry.task.id,
        prompt: typeof entry.task.prompt === 'string' ? entry.task.prompt : '',
        deletedAt: entry.deletedAt ?? 0,
        imageCount: collectTaskImageIds(entry.task).size,
      })
    }
    return items.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** 还原回活跃集；活跃集已有同 id 时（几乎不可能）只清回收站条目。 */
  function restoreFromTrash(memberId, taskId) {
    const entry = readTrashEntry(memberId, taskId)
    if (!entry) return null
    const current = readActive(memberId)
    if (!current.tasks.some((task) => task.id === taskId)) {
      writeActive(memberId, [...current.tasks, entry.task])
    }
    rmSync(trashPath(memberId, taskId), { force: true })
    return entry.task
  }

  /**
   * 清空回收站并做外科式图片 GC。
   *
   * 删除候选 = 被清空任务引用的图片 − 活跃任务引用的图片。绝不全局扫描孤儿：
   * 会话等本地概念引用的图片没有任务引用，全局扫描会把它们误删。
   */
  function emptyTrash(memberId) {
    const dir = trashDir(memberId)
    const entries = []
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const entry = readTrashEntry(memberId, name.slice(0, -'.json'.length))
        if (entry) entries.push(entry)
      }
    }

    const candidates = new Set()
    for (const entry of entries) {
      for (const id of collectTaskImageIds(entry.task)) candidates.add(id)
    }
    const activeRefs = new Set()
    for (const task of readActive(memberId).tasks) {
      for (const id of collectTaskImageIds(task)) activeRefs.add(id)
    }

    let removedImages = 0
    for (const id of candidates) {
      if (activeRefs.has(id)) continue
      const path = imagePath(memberId, id)
      if (!existsSync(path)) continue
      rmSync(path, { force: true })
      removedImages++
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

    return { tasks: entries.length, images: removedImages }
  }

  /** 首次出现的成员码即建立命名空间，没有预置白名单。 */
  function ensureMember(memberId) {
    mkdirSync(imagesDir(memberId), { recursive: true })
  }

  function listImageIds(memberId) {
    const root = imagesDir(memberId)
    if (!existsSync(root)) return []
    const ids = []
    for (const prefix of readdirSync(root)) {
      const dir = join(root, prefix)
      if (!statSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) ids.push(name)
    }
    return ids.sort()
  }

  /** 存在性检查是廉价的：不读图片内容。 */
  function hasImage(memberId, imageId) {
    return existsSync(imagePath(memberId, imageId))
  }

  function readImage(memberId, imageId) {
    const path = imagePath(memberId, imageId)
    if (!existsSync(path)) return null
    return readFileSync(path)
  }

  /** 重复上传同一个 id 不产生第二份数据，也不算错误。 */
  function writeImage(memberId, imageId, bytes) {
    const path = imagePath(memberId, imageId)
    if (existsSync(path)) return { created: false }
    mkdirSync(join(imagesDir(memberId), imageId.slice(0, 2)), { recursive: true })
    writeFileSync(path, bytes)
    return { created: true }
  }

  return {
    dataDir,
    memberDir,
    imagesDir,
    imagePath,
    trashDir,

    ensureMember,
    listImageIds,
    hasImage,
    readImage,
    writeImage,

    readActive,
    mergeSync,
    listTrash,
    restoreFromTrash,
    emptyTrash,
  }
}
