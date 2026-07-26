// 房间确定性调度（2026-07-22；2026-07-26 起串行是唯一模式）：串行轮转（首放/回复推进/超时/取消）、幂等建单。
// 隔离同 room-relay.test.ts：先于 import 设 ARECO_ROOT 到临时目录，project-db/rooms 落盘都在其下（不污染真库）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-dispatch-'))
process.env.ARECO_ROOT = root

const { RoomRelay } = await import('./room-relay')
const { RoomStore } = await import('./rooms')
const projectDb = await import('./project-db')

type Sent = Record<string, string[]>

/** 假 SessionManager：onceQuiet 立即执行（不等真实 quiet），sendline 记录到 sent[id]（同 room-relay.test.ts） */
function mockManager(runningIds: string[]): { manager: unknown; sent: Sent } {
  const sent: Sent = {}
  const sessions = runningIds.map((id) => ({ id, status: 'running' }))
  const manager = {
    list: () => sessions,
    get: (id: string) => ({
      onceQuiet: (fn: () => void) => fn(),
      sendline: (text: string) => {
        ;(sent[id] ??= []).push(text)
      },
      // 回显验证注入（injectNote）需要 EventEmitter 接口；测试里无输出事件 → echoed 恒 false，
      // isRunning:false 阻断重试链路（8s 验证定时器已 unref，不拖住测试进程）
      on: () => {},
      off: () => {},
      isRunning: false,
    }),
  }
  return { manager, sent }
}

let seq = 0
function setup(): {
  rooms: InstanceType<typeof RoomStore>
  roomId: string
  team: string
  name: string
} {
  const rooms = new RoomStore('Owner')
  const name = `dispatch${++seq}` // 每个 test 唯一项目名（rooms.json 在临时目录累积，防撞名）
  const room = rooms.create(name)
  rooms.addMember(room.id, { name: 'A', kind: 'session', sessionId: 'sa' })
  rooms.addMember(room.id, { name: 'B', kind: 'session', sessionId: 'sb' })
  return { rooms, roomId: room.id, team: room.team, name }
}

const tick = (relay: unknown) => (relay as { tick(): void }).tick()

test('serial：人类无 @ 发言只注入第一位成员，另一位 queued，三表记账正确', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家评审一下这个方案')

  assert.ok(sent['sa']?.length, '成员顺序第一位 A 应被注入')
  assert.equal(sent['sb'], undefined, 'B 应排队等待，不同时实施')

  const msg = projectDb.history(team, 1)[0]
  assert.deepEqual(projectDb.targetsOf(msg.id), ['A', 'B'], 'message_targets 广播应展开成具体成员名')

  const ds = projectDb.listDispatches(team)
  assert.equal(ds.length, 1, '本条消息应建一个 dispatch')
  const d = ds[0]
  assert.equal(d.mode, 'serial')
  assert.equal(d.state, 'active')
  assert.equal(d.rootMessageId, msg.id, 'root_message_id 应是本条消息')
  assert.equal(d.currentTarget, 'A', '当前放行位应是第一位成员')
  assert.ok(d.deadline, 'serial 放行应带回复 deadline')

  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(d.deliveries.length, 2)
  assert.equal(byName.A.status, 'injected')
  assert.ok(byName.A.correlationId, 'injected 应带注入 nonce 作 correlation_id')
  assert.equal(byName.A.attempt, 1)
  assert.equal(byName.B.status, 'queued')
})

test('serial：当前放行成员回复后自动放行下一位', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家评审一下这个方案')
  const sbBefore = sent['sb']
  assert.equal(sbBefore, undefined, 'A 回复前 B 不应被注入')

  relay.postMessage(roomId, 'A', '我这边看完了，没问题') // A 无 @ 回复：不广播，但应推进轮转
  assert.ok(sent['sb']?.length, 'A 回复后 B 应被放行注入')

  const d = projectDb.listDispatches(team)[0]
  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'done', 'A 的 delivery 应落定 done')
  assert.equal(byName.B.status, 'injected')
  assert.equal(d.currentTarget, 'B', '放行位应轮到 B')
})

test('serial：最后一名成员回复后 dispatch 收单 done', () => {
  const { rooms, roomId, team } = setup()
  const { manager } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '过一遍')
  relay.postMessage(roomId, 'A', 'A 完毕')
  relay.postMessage(roomId, 'B', 'B 完毕')

  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.state, 'done', '没有下一位应收单')
  assert.equal(d.currentTarget, null)
  assert.equal(d.deadline, null)
  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.B.status, 'done')
})

test('serial：当前成员超时未回复，置 timeout 并自动放下一位', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  // 超时时长传 0：deadline = 注入当下，下一个 tick 必过期
  const relay = new RoomRelay(rooms, manager as never, () => {}, { deliveryTimeoutMs: 0 })
  relay.postMessage(roomId, 'Owner', '限时回复')
  const sbBefore = sent['sb']
  assert.equal(sbBefore, undefined, '超时前 B 不应被注入')

  tick(relay) // tick 顺带扫超时
  assert.ok(sent['sb']?.length, 'A 超时后 B 应被放行注入')

  const d = projectDb.listDispatches(team)[0]
  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'timeout')
  assert.equal(byName.B.status, 'injected')
  assert.equal(d.currentTarget, 'B')
})

test('serial：cancelDispatch 后剩余 queued 全 cancelled，回复不再注入', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '先别动')
  const d = projectDb.listDispatches(team)[0]

  relay.cancelDispatch(roomId, d.id, '维护者叫停')
  const after = projectDb.listDispatches(team)[0]
  assert.equal(after.state, 'cancelled')
  assert.equal(after.cancelReason, '维护者叫停')
  const byName = Object.fromEntries(after.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.B.status, 'cancelled', '排队的 B 应被取消')

  relay.postMessage(roomId, 'A', '回复也不应再触发轮转')
  assert.equal(sent['sb'], undefined, '取消后不再注入任何人')
  // 幂等：再取消一次不报错不变状态
  relay.cancelDispatch(roomId, d.id)
  assert.equal(projectDb.listDispatches(team)[0].state, 'cancelled')
})

test('dispatch 幂等：同一 root_message_id 重复建单不产生重复行', () => {
  const { team } = setup()
  const msg = projectDb.send(team, 'Owner', 'all', '幂等测试')
  const members = [
    { name: 'A', sessionId: 'sa' },
    { name: 'B', sessionId: 'sb' },
  ]
  const first = projectDb.createDispatch(team, msg.id, 'serial')
  const second = projectDb.createDispatch(team, msg.id, 'serial')
  assert.equal(second.created, false, '重复建单应命中既有行')
  assert.equal(second.dispatch.id, first.dispatch.id)
  projectDb.addDeliveries(first.dispatch.id, members)
  projectDb.addDeliveries(first.dispatch.id, members) // 重复补录防重
  assert.equal(projectDb.deliveriesOf(first.dispatch.id).length, 2)
  assert.equal(projectDb.listDispatches(team).length, 1)
})

test('serial：显式 @ 单个成员只创建谁的 delivery', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '@B 你单独看下')

  assert.ok(sent['sb']?.length, '被 @ 的 B 应放行')
  assert.equal(sent['sa'], undefined, '未被 @ 的 A 不进本单')
  const msg = projectDb.history(team, 1)[0]
  assert.deepEqual(projectDb.targetsOf(msg.id), ['B'], '显式 @ 谁 message_targets 只记谁')
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.deliveries.length, 1)
  assert.equal(d.currentTarget, 'B')
})
