// 项目目录册（2026-07-27 维护者定）：项目 tab 侧栏不是"每类一个大房间"，而是
// 分组标题（全量案卷/全量 skills…）→ 组内每个文件夹一栏；点某栏才为该文件夹按需开房。
// 成员构成 = roots 扫描（marker 判定）+ extras 手动入组 − exclusions 手动出组：
// 扫描让新案件夹自动出现，入组/出组给人工调整留口子；分组可重命名/新建（2026-07-27 维护者补）。
// 配置在 data/project-catalog.json（本机私有，gitignore 的 data/ 下），原子写同 rooms.json 惯例。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectCatalogGroup, RoomInfo } from '../../../shared/protocol'
import { DATA_DIR } from '../config'
import { createLogger } from '../logger'

const log = createLogger('project-catalog')

const CATALOG_PATH = path.join(DATA_DIR, 'project-catalog.json')
/** 目录扫描缓存 TTL：目录册是文件系统快照，30s 内重复请求直接复用 */
const SCAN_TTL_MS = 30_000

export interface CatalogSourceGroup {
  id: string
  label: string
  /** roots 扫描的成员判定文件（案件夹 README.md / skill 夹 SKILL.md）；纯手动组可无 roots */
  marker: string
  roots: string[]
  /** 手动入组的文件夹（绝对路径） */
  extras: string[]
  /** 手动出组的文件夹（绝对路径，对 roots 扫描与 extras 都生效） */
  exclusions: string[]
}

interface ScanCache {
  at: number
  configMtime: number
  /** groupId → 扫描出的 entries（未合并 extras/exclusions） */
  scanned: Map<string, { name: string; path: string; real: string }[]>
}

let cache: ScanCache | null = null

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
}

function normalizeGroup(g: Partial<CatalogSourceGroup>): CatalogSourceGroup | null {
  if (typeof g?.label !== 'string' || !g.label.trim()) return null
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    id: typeof g.id === 'string' && g.id ? g.id : crypto.randomUUID().slice(0, 8),
    label: g.label.trim(),
    marker: typeof g.marker === 'string' && g.marker ? g.marker : 'README.md',
    roots: arr(g.roots),
    extras: arr(g.extras),
    exclusions: arr(g.exclusions),
  }
}

function load(): { groups: CatalogSourceGroup[]; mtime: number } {
  try {
    const st = fs.statSync(CATALOG_PATH)
    const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as { groups?: unknown }
    const groups = Array.isArray(parsed.groups)
      ? (parsed.groups as Partial<CatalogSourceGroup>[]).map(normalizeGroup).filter((g): g is CatalogSourceGroup => !!g)
      : []
    return { groups, mtime: st.mtimeMs }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('project-catalog.json 读取失败，按未配置处理', err)
    return { groups: [], mtime: 0 }
  }
}

function save(groups: CatalogSourceGroup[]) {
  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true })
  atomicWrite(CATALOG_PATH, JSON.stringify({ groups }, null, 2) + '\n')
  cache = null // 配置变了，扫描缓存作废（mtime 双保险之外的显式失效）
}

function scanGroup(g: CatalogSourceGroup): { name: string; path: string; real: string }[] {
  const out: { name: string; path: string; real: string }[] = []
  for (const root of g.roots) {
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue // 根不存在/不可读：跳过该根，不炸整个目录册
    }
    for (const d of dirents) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue
      const dir = path.join(root, d.name)
      if (!fs.existsSync(path.join(dir, g.marker))) continue
      out.push({ name: d.name, path: dir, real: realpathSafe(dir) })
    }
  }
  return out
}

/** 是否已配置目录册（未配置时前端给引导文案而非空白） */
export function catalogConfigured(): boolean {
  return load().groups.length > 0
}

/**
 * 目录册快照 + 房间绑定：entries[].roomId 按「项目房 rootPath 的 realpath == 文件夹 realpath」回填。
 * 目录扫描走 TTL + 配置 mtime 双失效缓存；extras/exclusions 合并每次现算（量小）。
 */
export function listCatalog(rooms: RoomInfo[]): ProjectCatalogGroup[] {
  const cfg = load()
  const now = Date.now()
  if (!cache || cache.configMtime !== cfg.mtime || now - cache.at > SCAN_TTL_MS) {
    cache = { at: now, configMtime: cfg.mtime, scanned: new Map(cfg.groups.map((g) => [g.id, scanGroup(g)])) }
  }
  const byRoot = new Map<string, string>()
  for (const r of rooms) {
    if (r.kind === 'project' && r.rootPath) byRoot.set(realpathSafe(r.rootPath), r.id)
  }
  return cfg.groups.map((g) => {
    const excluded = new Set(g.exclusions.map(realpathSafe))
    const merged = new Map<string, { name: string; path: string }>()
    for (const e of cache!.scanned.get(g.id) ?? []) {
      if (!excluded.has(e.real)) merged.set(e.real, { name: e.name, path: e.path })
    }
    for (const p of g.extras) {
      const real = realpathSafe(p)
      if (!excluded.has(real) && !merged.has(real) && fs.existsSync(p)) merged.set(real, { name: path.basename(p), path: p })
    }
    const entries = [...merged.entries()]
      .map(([real, e]) => ({ name: e.name, path: e.path, roomId: byRoot.get(real) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return { id: g.id, label: g.label, entries }
  })
}

// ---- 分组管理（入组/出组/重命名/新建）：全部落盘 project-catalog.json ----

function mustFind(groups: CatalogSourceGroup[], id: string): CatalogSourceGroup {
  const g = groups.find((x) => x.id === id)
  if (!g) throw new Error(`分组不存在: ${id}`)
  return g
}

export function createGroup(label: string): CatalogSourceGroup {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const { groups } = load()
  if (groups.some((g) => g.label === trimmed)) throw new Error(`分组「${trimmed}」已存在`)
  const g: CatalogSourceGroup = { id: crypto.randomUUID().slice(0, 8), label: trimmed, marker: 'README.md', roots: [], extras: [], exclusions: [] }
  groups.push(g)
  save(groups)
  return g
}

export function renameGroup(id: string, label: string): CatalogSourceGroup {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const { groups } = load()
  const g = mustFind(groups, id)
  if (groups.some((x) => x.id !== id && x.label === trimmed)) throw new Error(`分组「${trimmed}」已存在`)
  g.label = trimmed
  save(groups)
  return g
}

/** 入组：目录必须存在；若之前被出组过则解除出组，否则记入 extras（roots 扫描命中的无需重复记） */
export function addMember(id: string, dir: string): void {
  const trimmed = dir.trim()
  if (!trimmed) throw new Error('缺少文件夹路径')
  if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isDirectory()) throw new Error(`不是有效文件夹: ${trimmed}`)
  const { groups } = load()
  const g = mustFind(groups, id)
  const real = realpathSafe(trimmed)
  g.exclusions = g.exclusions.filter((p) => realpathSafe(p) !== real)
  const scannedHit = scanGroup(g).some((e) => e.real === real)
  if (!scannedHit && !g.extras.some((p) => realpathSafe(p) === real)) g.extras.push(trimmed)
  save(groups)
}

/** 出组：extras 里的直接移除；roots 扫描出来的记入 exclusions。只影响分组归属，不动文件夹与房间 */
export function removeMember(id: string, dir: string): void {
  const { groups } = load()
  const g = mustFind(groups, id)
  const real = realpathSafe(dir)
  const beforeExtras = g.extras.length
  g.extras = g.extras.filter((p) => realpathSafe(p) !== real)
  const inScan = scanGroup(g).some((e) => e.real === real)
  if (inScan && !g.exclusions.some((p) => realpathSafe(p) === real)) g.exclusions.push(dir)
  if (beforeExtras === g.extras.length && !inScan) throw new Error('该文件夹不在本分组里')
  save(groups)
}

/** 测试用：清扫描缓存 */
export function resetCatalogCache() {
  cache = null
}
