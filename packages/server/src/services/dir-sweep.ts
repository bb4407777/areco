// Spotlight 零命中兜底：BFS 实扫可见目录反查同名目录（拖放定位 locate-dir 专用）。
// 为什么存在：mdfind 对新建目录有分钟级以上的索引滞后（2026-08-02 实证：桌面新建文件夹
// 连同其子文件 6 分钟后整棵子树仍不在索引），拖「刚建的文件夹」只靠 Spotlight 必空手。
// 边界：浅层优先（Desktop/Downloads/Documents 提前），跳过点目录/Library/node_modules，
// 深度/访问量/耗时三重上限；不追软链（Dirent.isDirectory 对软链为 false，天然无环）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SKIP_NAMES = new Set(['Library', 'node_modules'])
const PRIORITY = ['Desktop', 'Downloads', 'Documents']

export interface SweepOptions {
  /** 扫描根；缺省 = home 下全部可见一级目录（Desktop/Downloads/Documents 提前） */
  roots?: string[]
  /** 相对根的下钻层数上限，缺省 8 */
  maxDepth?: number
  /** readdir 目录数上限，缺省 40000 */
  maxVisited?: number
  /** 耗时上限毫秒，缺省 3500 */
  budgetMs?: number
  /** 凑满即止，缺省 8（与 locate-dir 返回上限一致） */
  maxMatches?: number
}

/**
 * 在可见目录树里找 basename === name（NFC 归一，磁盘常为 NFD）且首层含全部 samples
 * 的目录，浅层优先返回。全程异步 readdir，不阻塞事件循环；任何单目录读失败静默跳过。
 */
export async function sweepForDir(name: string, samples: string[], opts: SweepOptions = {}): Promise<string[]> {
  const nfcName = name.normalize('NFC')
  const { maxDepth = 8, maxVisited = 40_000, budgetMs = 3500, maxMatches = 8 } = opts
  const roots = opts.roots ?? (await defaultRoots())
  const deadline = Date.now() + budgetMs
  const matches: string[] = []
  // 根自身也可能就是目标（如 home 一级恰好同名的目录）
  for (const r of roots) {
    if (path.basename(r).normalize('NFC') === nfcName && (await hasSamples(r, samples))) matches.push(r)
  }
  const queue = roots.map((dir) => ({ dir, depth: 0 }))
  let head = 0 // 下标推进代替 shift()：队列上万时避免 O(n²)
  let visited = 0
  while (head < queue.length && matches.length < maxMatches) {
    if (Date.now() > deadline || ++visited > maxVisited) break
    const { dir, depth } = queue[head++]
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const en of entries) {
      if (!en.isDirectory() || en.name.startsWith('.') || SKIP_NAMES.has(en.name)) continue
      const p = path.join(dir, en.name)
      if (en.name.normalize('NFC') === nfcName && (await hasSamples(p, samples))) {
        matches.push(p)
        if (matches.length >= maxMatches) break
      }
      if (depth + 1 < maxDepth) queue.push({ dir: p, depth: depth + 1 })
    }
  }
  return matches
}

async function hasSamples(dir: string, samples: string[]): Promise<boolean> {
  for (const s of samples) {
    try {
      await fs.promises.access(path.join(dir, s))
    } catch {
      return false
    }
  }
  return true
}

async function defaultRoots(): Promise<string[]> {
  const home = os.homedir()
  try {
    const top = (await fs.promises.readdir(home, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_NAMES.has(d.name))
      .map((d) => d.name)
    return [...PRIORITY.filter((n) => top.includes(n)), ...top.filter((n) => !PRIORITY.includes(n))].map((n) =>
      path.join(home, n),
    )
  } catch {
    return []
  }
}
