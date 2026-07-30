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
fs.mkdirSync(path.join(casesRoot, '不是案件'), { recursive: true })
fs.mkdirSync(extra, { recursive: true })
fs.writeFileSync(path.join(casesRoot, '案件甲', 'README.md'), '# 案件甲\n')
fs.writeFileSync(
  path.join(dataDir, 'project-catalog.json'),
  JSON.stringify({
    groups: [{ id: 'cases', label: '全量案卷', marker: 'README.md', roots: [casesRoot], extras: [], exclusions: [] }],
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

test('扫描 marker 文件夹并按 realpath 回填已开项目房', () => {
  catalog.resetCatalogCache()
  const room = projectRoom('r1', path.join(casesRoot, '案件甲'))
  const groups = catalog.listCatalog([room])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'cases')
  assert.deepEqual(groups[0].entries, [{ name: '案件甲', path: path.join(casesRoot, '案件甲'), roomId: 'r1' }])
})

test('入组、出组、改名和新建分组均持久化且不动文件夹', () => {
  catalog.addMember('cases', extra)
  let group = catalog.listCatalog([])[0]
  assert.ok(group.entries.some((e) => e.path === extra))

  catalog.removeMember('cases', path.join(casesRoot, '案件甲'))
  group = catalog.listCatalog([])[0]
  assert.ok(!group.entries.some((e) => e.name === '案件甲'))
  assert.ok(fs.existsSync(path.join(casesRoot, '案件甲', 'README.md')), '出组不能删文件夹内容')

  assert.equal(catalog.renameGroup('cases', '在办案件').label, '在办案件')
  const created = catalog.createGroup('专项项目')
  const groups = catalog.listCatalog([])
  assert.ok(groups.some((g) => g.id === created.id && g.label === '专项项目'))
})
