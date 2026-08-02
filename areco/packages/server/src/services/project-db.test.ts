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
  assert.ok(fs.existsSync(path.join(root, 'data', 'tasks.db')))
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

test('correctMessageSender 改写 from_agent（冒名回执署名校正，2026-07-29）', () => {
  const m = db.send('room-t2', 'Glm5.2', 'Owner', '接手后的回执')
  db.correctMessageSender(m.id, 'hy3')
  const rows = db.history('room-t2', 10)
  assert.equal(rows[rows.length - 1].from, 'hy3', 'from_agent 应被改写')
  assert.equal(rows[rows.length - 1].body, '接手后的回执', '其余字段不动')
  assert.equal(db.messageById(m.id)?.from, 'hy3')
  assert.throws(() => db.correctMessageSender(m.id, '  '), /newFrom/)
})

test('双库路由（2026-08-02 定名分库）：项目房落 projects.db，任务房落 tasks.db，id 永不撞', () => {
  // rooms.json 声明 kind；写入后 mtime 变化触发缓存刷新
  fs.writeFileSync(
    path.join(root, 'data', 'rooms.json'),
    JSON.stringify([
      { id: 'p1', team: 'room-proj1', kind: 'project', name: '项目房' },
      { id: 't9', team: 'room-task9', kind: 'task', name: '任务房' },
    ])
  )
  const pm = db.send('room-proj1', 'Owner', 'all', '项目消息一号')
  const tm = db.send('room-task9', 'Owner', 'all', '任务消息一号')
  assert.ok(fs.existsSync(path.join(root, 'data', 'projects.db')), '项目库文件已建')
  // 项目库 id 从 10_000_000 seed 起步，与任务库天然错位
  assert.ok(pm.id > 10_000_000, `项目消息 id seed 起步（实得 ${pm.id}）`)
  assert.ok(tm.id < 10_000_000, `任务消息 id 自然增长（实得 ${tm.id}）`)
  // history 各回各库
  assert.deepEqual(db.history('room-proj1', 10).map((m) => m.body), ['项目消息一号'])
  assert.deepEqual(db.history('room-task9', 10).map((m) => m.body), ['任务消息一号'])
  // 按 id 跨库顺查
  assert.equal(db.messageById(pm.id)?.body, '项目消息一号')
  assert.equal(db.messageById(tm.id)?.body, '任务消息一号')
  // 跨库搜索合并
  const hits = db.search('消息一号', 10)
  assert.deepEqual(new Set(hits.map((m) => m.body)), new Set(['项目消息一号', '任务消息一号']))
  // lastMessageAts 两库并集
  const ats = db.lastMessageAts()
  assert.ok(ats['room-proj1'] && ats['room-task9'])
  // dispatch/delivery 跟随房间 kind 落库并可跨库按 id 查
  const { dispatch } = db.createDispatch('room-proj1', pm.id, 'serial')
  assert.ok(dispatch.id > 10_000_000, 'dispatch id 同样 seed 起步')
  const dels = db.addDeliveries(dispatch.id, [{ name: 'M1', sessionId: null }])
  assert.equal(dels.length, 1)
  assert.equal(db.dispatchById(dispatch.id)?.team, 'room-proj1')
  db.updateDelivery(dels[0].id, { status: 'injected' })
  assert.equal(db.deliveriesOf(dispatch.id)[0].status, 'injected')
  // 收尾清掉 rooms.json，不影响其它用例的兜底行为
  fs.rmSync(path.join(root, 'data', 'rooms.json'))
})
