// project-db 单测：send/history 回环 + 落盘持久（临时 ARECO_ROOT，先于 import 设置）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-pdb-'))
process.env.ARECO_ROOT = root

const db = await import('./project-db')

test('send 落库并返回完整行', () => {
  const m = db.send('room-t1', 'Owner', 'all', '你好')
  assert.equal(m.team, 'room-t1')
  assert.equal(m.from, 'Owner')
  assert.equal(m.body, '你好')
  assert.ok(m.id > 0)
  assert.ok(m.createdAt.endsWith('Z'))
  assert.ok(fs.existsSync(path.join(root, 'data', 'projects.db')))
})

test('history 升序返回且按 limit 截尾', () => {
  db.send('room-t1', 'Echo-A', 'Owner', '回执 1')
  db.send('room-t1', 'Owner', 'Echo-A', '回执 2')
  const all = db.history('room-t1', 10)
  assert.deepEqual(all.map((m) => m.body), ['你好', '回执 1', '回执 2'])
  const tail = db.history('room-t1', 2)
  assert.deepEqual(tail.map((m) => m.body), ['回执 1', '回执 2'])
  assert.deepEqual(db.history('room-nope', 10), [])
})

test('空参数拒绝', () => {
  assert.throws(() => db.send('', 'a', 'b', 'x'))
  assert.throws(() => db.send('room-t1', 'a', 'b', '   '))
})
