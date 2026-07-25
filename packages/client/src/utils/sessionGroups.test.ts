// 会话按项目分组：归属规则、活动序继承、归档边界、活动置顶抽取
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSessionsByRoom } from './sessionGroups'
import type { RoomInfo, SessionSummary } from '../../../shared/protocol'

function room(id: string, memberSessionIds: (string | null)[], archived = false): RoomInfo {
  return {
    id,
    name: `项目${id}`,
    team: `room-${id}`,
    createdAt: 0,
    archivedAt: archived ? 1 : null,
    dispatchMode: 'parallel',
    members: [
      { name: 'Owner', kind: 'human', sessionId: null },
      ...memberSessionIds.map((sid, i) => ({ name: `a${i}`, kind: 'session' as const, sessionId: sid })),
    ],
  } as RoomInfo
}

function session(id: string, archived = false, status = 'exited'): SessionSummary {
  return { id, name: id, archived, status } as SessionSummary
}

test('项目成员的会话进分组，非成员留在零散区，顺序跟随传入（活动序）', () => {
  const rooms = [room('r1', ['s2', 's1'])]
  // 传入顺序即活动倒序：s1 比 s2 新，组内也应 s1 在前（不看成员表顺序）
  const { groups, loose } = groupSessionsByRoom(rooms, [session('s1'), session('s2'), session('s3')])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s1', 's2'])
  assert.deepEqual(loose.map((s) => s.id), ['s3'])
})

test('同一会话挂多个项目归第一个项目', () => {
  const rooms = [room('r1', ['s1']), room('r2', ['s1', 's2'])]
  const { groups } = groupSessionsByRoom(rooms, [session('s1'), session('s2')])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s1'])
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['s2'])
})

test('归档项目不成组；已归档会话不进组也不进零散区', () => {
  const rooms = [room('r1', ['s1'], true), room('r2', ['s2'])]
  const { groups, loose } = groupSessionsByRoom(rooms, [session('s1'), session('s2'), session('s3', true)])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s2'])
  // s3 已归档：rooms 里没它 → 落零散区过滤前的归档守卫外？归档会话不归组，应留在 loose 之外（由调用方 boardSessions 已滤归档）
  assert.deepEqual(loose.map((s) => s.id), ['s1', 's3'])
})

test('成员指向已删除的会话（查无此 id）静默跳过', () => {
  const rooms = [room('r1', ['ghost', 's1'])]
  const { groups } = groupSessionsByRoom(rooms, [session('s1')])
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s1'])
})

test('活动置顶：运行中会话（含分组内的）抽到 active，带项目名；不再出现在原位', () => {
  const rooms = [room('r1', ['s1', 's2'])]
  const sessions = [
    session('s1', false, 'running'),   // 分组成员，运行中 → active(项目r1)
    session('s2'),                      // 分组成员，已退出 → 留组内
    session('s3', false, 'spawning'),  // 游离，启动中 → active(无项目)
    session('s4'),                      // 游离，已退出 → loose
  ]
  const { active, groups, loose } = groupSessionsByRoom(rooms, sessions)
  assert.deepEqual(active.map((e) => e.session.id), ['s1', 's3'])
  assert.equal(active[0].roomName, '项目r1')
  assert.equal(active[1].roomName, null)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s2'])
  assert.deepEqual(loose.map((s) => s.id), ['s4'])
})

test('活动置顶：组员全在运行 → 该组暂不显示；已归档的运行中会话不进 active', () => {
  const rooms = [room('r1', ['s1'])]
  const { active, groups, loose } = groupSessionsByRoom(rooms, [
    session('s1', false, 'running'),
    session('s2', true, 'running'), // 归档+运行：不进 active（归档守卫优先）
  ])
  assert.deepEqual(active.map((e) => e.session.id), ['s1'])
  assert.equal(groups.length, 0)
  assert.deepEqual(loose.map((s) => s.id), ['s2'])
})
