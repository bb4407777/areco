// 项目目录册：根目录扫描、房间绑定、入组/出组和分组改名。
// 隔离：先于 import 设置 ARECO_ROOT，配置与扫描素材只落临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RoomInfo } from '../../../shared/protocol'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-project-catalog-'))
process.env.ARECO_ROOT = root
const dataDir = path.join(root, 'data')
const casesRoot = path.join(root, 'cases')
const extra = path.join(root, 'manual', '补充项目')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(casesRoot, '案件甲'), { recursive: true })
fs.mkdirSync(path.join(casesRoot, '案件乙'), { recursive: true })
fs.mkdirSync(path.join(casesRoot, '不是案件'), { recursive: true })
fs.mkdirSync(extra, { recursive: true })
fs.writeFileSync(path.join(casesRoot, '案件甲', 'README.md'), '# 案件甲\n')
fs.writeFileSync(path.join(casesRoot, '案件乙', 'PROJECT.md'), '# 案件乙\n')
// 路径派生素材：类目/项目 两层 + 已归档 三层 + 散件直挂 base + 噪音目录（参考）+ 类目夹自带 marker（民事案件/PROJECT.md）
const treeRoot = path.join(root, 'tree')
fs.mkdirSync(path.join(treeRoot, '民事案件', '案A'), { recursive: true })
fs.writeFileSync(path.join(treeRoot, '民事案件', '案A', 'README.md'), '# 案A\n')
fs.writeFileSync(path.join(treeRoot, '民事案件', 'PROJECT.md'), '# 类目说明\n')
fs.mkdirSync(path.join(treeRoot, '已归档', '民事案件', '案B'), { recursive: true })
fs.writeFileSync(path.join(treeRoot, '已归档', '民事案件', '案B', 'PROJECT.md'), '# 案B\n')
fs.mkdirSync(path.join(treeRoot, '参考', '杂项'), { recursive: true })
fs.writeFileSync(path.join(treeRoot, '参考', '杂项', 'README.md'), '# 杂项\n')
fs.mkdirSync(path.join(treeRoot, '散件'), { recursive: true })
fs.writeFileSync(path.join(treeRoot, '散件', 'README.md'), '# 散件\n')
fs.writeFileSync(
  path.join(dataDir, 'project-catalog.json'),
  JSON.stringify({
    pathGroups: [
      {
        base: treeRoot,
        markers: ['README.md', 'PROJECT.md'],
        maxDepth: 3,
        excludeTopDirs: ['参考'],
        excludeEntries: ['民事案件'],
      },
    ],
    groups: [{ id: 'cases', label: '全量案卷', markers: ['README.md', 'PROJECT.md'], roots: [casesRoot], extras: [], exclusions: [] }],
  })
)

const catalog = await import('./project-catalog')

function projectRoom(id: string, rootPath: string): RoomInfo {
  return {
    id,
    name: path.basename(rootPath),
    team: `room-${id}`,
    kind: 'project',
    createdAt: 1,
    archivedAt: null,
    rootPath,
    members: [{ name: 'Owner', kind: 'human', sessionId: null }],
  }
}

test('扫描 markers 多标记文件夹（README.md/PROJECT.md 任一命中）并按 realpath 回填已开项目房', () => {
  catalog.resetCatalogCache()
  const room = projectRoom('r1', path.join(casesRoot, '案件甲'))
  const groups = catalog.listCatalog([room])
  const casesGroup = groups.find((g) => g.id === 'cases')
  assert.ok(casesGroup)
  assert.deepEqual(casesGroup.entries, [
    { name: '案件甲', path: path.join(casesRoot, '案件甲'), roomId: 'r1' },
    { name: '案件乙', path: path.join(casesRoot, '案件乙'), roomId: null },
  ])
})

test('路径派生分组：组名=父目录绝对路径，derived 只读，排除规则生效', () => {
  catalog.resetCatalogCache()
  const groups = catalog.listCatalog([])
  const derived = groups.filter((g) => g.derived)
  const byLabel = new Map(derived.map((g) => [g.label, g]))
  assert.deepEqual(
    [...byLabel.keys()].sort(),
    [path.join(treeRoot, '民事案件'), path.join(treeRoot, '已归档', '民事案件'), treeRoot].sort(),
  )
  assert.deepEqual(byLabel.get(path.join(treeRoot, '民事案件'))!.entries.map((e) => e.name), ['案A'])
  assert.deepEqual(byLabel.get(path.join(treeRoot, '已归档', '民事案件'))!.entries.map((e) => e.name), ['案B'])
  assert.deepEqual(byLabel.get(treeRoot)!.entries.map((e) => e.name), ['散件'])
  assert.ok(derived.every((g) => g.id.startsWith('path:')), '派生组带 path: 前缀稳定 id')
  // 派生组排在人工组之前
  assert.ok(groups.findIndex((g) => g.derived) < groups.findIndex((g) => g.id === 'cases'))
})

test('入组、出组、改名和新建分组均持久化且不动文件夹', () => {
  catalog.addMember('cases', extra)
  let group = catalog.listCatalog([]).find((g) => g.id === 'cases')!
  assert.ok(group.entries.some((e) => e.path === extra))

  catalog.removeMember('cases', path.join(casesRoot, '案件甲'))
  group = catalog.listCatalog([]).find((g) => g.id === 'cases')!
  assert.ok(!group.entries.some((e) => e.name === '案件甲'))
  assert.ok(fs.existsSync(path.join(casesRoot, '案件甲', 'README.md')), '出组不能删文件夹内容')

  assert.equal(catalog.renameGroup('cases', '在办案件').label, '在办案件')
  const created = catalog.createGroup('专项项目')
  const groups = catalog.listCatalog([])
  assert.ok(groups.some((g) => g.id === created.id && g.label === '专项项目'))
})
