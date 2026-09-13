// 项目 Files：只读、懒加载目录树与受限递归搜索。
// rootPath 必须先经 FileService.resolveDirectory；每个子项再 realpath 并限制在项目根内，挡 ../ 与软链逃逸。
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectFileList, ProjectFileNode } from '../../../shared/protocol'
import type { FileService } from './files'

const LIST_LIMIT = 500
const SEARCH_RESULT_LIMIT = 300
const SEARCH_SCAN_LIMIT = 8_000
const SEARCH_DEPTH_LIMIT = 24
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build'])

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

export class ProjectFileService {
  constructor(private files: FileService) {}

  bindRoot(input: string): string {
    return this.files.resolveDirectory(input)
  }

  private root(input: string): string {
    return this.files.resolveDirectory(input)
  }

  private directory(root: string, relative: string): string {
    if (path.isAbsolute(relative)) throw new Error('目录参数必须是相对路径')
    const joined = path.resolve(root, relative || '.')
    let real: string
    try {
      real = fs.realpathSync(joined)
    } catch {
      throw new Error('目录不存在')
    }
    if (!inside(root, real)) throw new Error('目录超出项目根目录')
    if (!fs.statSync(real).isDirectory()) throw new Error('不是目录')
    return real
  }

  private node(root: string, absolute: string): ProjectFileNode | null {
    let real: string
    try {
      real = fs.realpathSync(absolute)
    } catch {
      return null
    }
    if (!inside(root, real)) return null
    let st: fs.Stats
    try {
      st = fs.statSync(real)
    } catch {
      return null
    }
    if (!st.isDirectory() && !st.isFile()) return null
    return {
      name: path.basename(absolute),
      path: real,
      relativePath: path.relative(root, real),
      kind: st.isDirectory() ? 'directory' : 'file',
      size: st.isFile() ? st.size : null,
      mtimeMs: st.mtimeMs,
    }
  }

  list(rootInput: string, relative = ''): ProjectFileList {
    const root = this.root(rootInput)
    const dir = this.directory(root, relative)
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== '.DS_Store')
      .slice(0, LIST_LIMIT + 1)
    const items = entries
      .slice(0, LIST_LIMIT)
      .map((entry) => this.node(root, path.join(dir, entry.name)))
      .filter((item): item is ProjectFileNode => item !== null)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      })
    return { rootPath: root, directory: path.relative(root, dir), items, truncated: entries.length > LIST_LIMIT }
  }

  search(rootInput: string, query: string): ProjectFileList {
    const root = this.root(rootInput)
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return this.list(root)
    const items: ProjectFileNode[] = []
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
    let scanned = 0

    while (queue.length && items.length < SEARCH_RESULT_LIMIT && scanned < SEARCH_SCAN_LIMIT) {
      const current = queue.shift()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (++scanned > SEARCH_SCAN_LIMIT) break
        if (entry.name === '.DS_Store') continue
        const node = this.node(root, path.join(current.dir, entry.name))
        if (!node) continue
        if (node.relativePath.toLocaleLowerCase('zh-CN').includes(needle)) items.push(node)
        if (
          node.kind === 'directory' &&
          current.depth < SEARCH_DEPTH_LIMIT &&
          !SEARCH_SKIP_DIRS.has(entry.name)
        ) queue.push({ dir: node.path, depth: current.depth + 1 })
        if (items.length >= SEARCH_RESULT_LIMIT) break
      }
    }

    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }))
    return {
      rootPath: root,
      directory: '',
      items,
      truncated: items.length >= SEARCH_RESULT_LIMIT || scanned >= SEARCH_SCAN_LIMIT,
    }
  }
}
