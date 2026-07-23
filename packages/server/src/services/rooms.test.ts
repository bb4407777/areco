// parseMentions 单测：成员名含空格/括号（模板名），靠"@ 位置最长前缀匹配"而非空白切词
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RoomMember } from '../../../shared/protocol'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-rooms-'))
process.env.ARECO_ROOT = root

const { parseMentions, RoomStore } = await import('./rooms')

const members: RoomMember[] = [
  { name: 'Owner', kind: 'human', sessionId: null },
  { name: 'Kimi K3', kind: 'session', sessionId: 'a' },
  { name: 'Claude Code (Fable5)', kind: 'session', sessionId: 'b' },
  { name: 'Kimi K3·2', kind: 'session', sessionId: 'c' },
]

test('无 mention 返回空', () => {
  assert.deepEqual(parseMentions('大家好，随便聊聊', members), { targets: [], all: false })
})

test('单个 mention：含空格的成员名完整匹配', () => {
  const r = parseMentions('@Kimi K3 看一下这个报错', members)
  assert.deepEqual(r.targets, ['Kimi K3'])
  assert.equal(r.all, false)
})

test('最长优先：Kimi K3·2 不能被 Kimi K3 截胡', () => {
  const r = parseMentions('@Kimi K3·2 接力', members)
  assert.deepEqual(r.targets, ['Kimi K3·2'])
})

test('括号成员名', () => {
  const r = parseMentions('请 @Claude Code (Fable5) 复核', members)
  assert.deepEqual(r.targets, ['Claude Code (Fable5)'])
})

test('多个 mention 去重', () => {
  const r = parseMentions('@Kimi K3 和 @Claude Code (Fable5) 都看，@Kimi K3 先说', members)
  assert.deepEqual(r.targets, ['Kimi K3', 'Claude Code (Fable5)'])
})

test('@all 广播（大小写不敏感）', () => {
  assert.deepEqual(parseMentions('@all 开会', members), { targets: [], all: true })
  assert.deepEqual(parseMentions('@All 都来看看', members), { targets: [], all: true })
})

test('@all 后紧跟字母不算广播', () => {
  const r = parseMentions('@alloy 是成员名前缀的情况', members)
  assert.equal(r.all, false)
})

test('词中 @ 不算 mention（邮箱/路径）', () => {
  const r = parseMentions('发到 dev@Kimi K3 看看', members)
  assert.deepEqual(r.targets, [])
})

test('中文标点后 @ 有效', () => {
  const r = parseMentions('总结一下。@Kimi K3 补充', members)
  assert.deepEqual(r.targets, ['Kimi K3'])
})

test('中文正文后紧邻 @ 有效', () => {
  const r = parseMentions('你看下@gpt-5.6-sol', [
    ...members,
    { name: 'gpt-5.6-sol', kind: 'session', sessionId: 'd' },
  ])
  assert.deepEqual(r.targets, ['gpt-5.6-sol'])
  assert.equal(r.all, false)
})

test('ASCII 标识符和路径内部的 @ 不算 mention', () => {
  assert.deepEqual(parseMentions('see@Kimi K3', members).targets, [])
  assert.deepEqual(parseMentions('/@Kimi K3', members).targets, [])
})

test('项目归档保留元数据并可恢复，旧数据缺 archivedAt 时自动迁移', () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create('归档测试')
  assert.equal(room.archivedAt, null)
  assert.equal(room.rootPath, null)

  const archived = rooms.archive(room.id)
  assert.equal(typeof archived.archivedAt, 'number')
  assert.equal(new RoomStore('Owner').get(room.id).archivedAt, archived.archivedAt, '归档状态应持久化')

  const restored = rooms.unarchive(room.id)
  assert.equal(restored.archivedAt, null)

  const legacyPath = path.join(root, 'data', 'rooms.json')
  fs.writeFileSync(legacyPath, JSON.stringify([{ ...room, archivedAt: undefined }]), 'utf8')
  assert.equal(new RoomStore('Owner').get(room.id).archivedAt, null)
})

test('项目文件根目录持久化，旧项目缺字段时迁移为 null', () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create('文件根测试')
  rooms.setRootPath(room.id, '/tmp/case-root')
  assert.equal(new RoomStore('Owner').get(room.id).rootPath, '/tmp/case-root')

  const legacyPath = path.join(root, 'data', 'rooms.json')
  fs.writeFileSync(legacyPath, JSON.stringify([{ ...room, rootPath: undefined }]), 'utf8')
  assert.equal(new RoomStore('Owner').get(room.id).rootPath, null)
})

test('归档项目禁止改成员', () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create('只读归档测试')
  rooms.archive(room.id)
  assert.throws(
    () => rooms.addMember(room.id, { name: 'A', kind: 'session', sessionId: 'sa' }),
    /已归档/
  )
})
