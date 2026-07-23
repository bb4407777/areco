// 房间确定性调度（2026-07-22）：serial 串行轮转（首放/回复推进/超时/取消）、幂等建单、parallel 记账回归。
// 隔离同 room-relay.test.ts：先于 import 设 ARECO_ROOT 到临时目录，project-db/rooms 落盘都在其下（不污染真库）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
function setup(mode: 'parallel' | 'serial' | 'claim'): {
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
  if (mode !== 'serial') rooms.setDispatchMode(room.id, mode) // serial 为默认，其余模式显式切
  return { rooms, roomId: room.id, team: room.team, name }
}

/** tmpdir 里 git init 一个测试仓（一个初始提交），供绑房间/开工作区/兜底提交用 */
function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-claim-repo-'))
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git(['init'])
  git(['config', 'user.email', 'test@areco.local'])
  git(['config', 'user.name', 'areco-test'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n')
  git(['add', '-A'])
  git(['commit', '-m', 'init'])
  return dir
}

const gitOut = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim()

const tick = (relay: unknown) => (relay as { tick(): void }).tick()

test('serial：人类无 @ 发言只注入第一位成员，另一位 queued，三表记账正确', () => {
  const { rooms, roomId, team } = setup('serial')
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
  const { rooms, roomId, team } = setup('serial')
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
  const { rooms, roomId, team } = setup('serial')
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
  const { rooms, roomId, team } = setup('serial')
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
  const { rooms, roomId, team } = setup('serial')
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
  const { team } = setup('serial')
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

test('parallel：全员即注行为不变，deliveries 同步记 injected', () => {
  const { rooms, roomId, team } = setup('parallel')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家一起看')

  assert.ok(sent['sa']?.length && sent['sb']?.length, 'parallel 应全员同时注入')
  const msg = projectDb.history(team, 1)[0]
  assert.deepEqual(projectDb.targetsOf(msg.id), ['A', 'B'])
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.mode, 'parallel')
  assert.equal(d.currentTarget, null, 'parallel 无放行位')
  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'injected')
  assert.equal(byName.B.status, 'injected')
})

test('serial：显式 @ 单个成员只创建谁的 delivery', () => {
  const { rooms, roomId, team } = setup('serial')
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

// ---- claim 认领制（2026-07-22 第二阶段）：先报认领、原子批准唯一 Implementer、绑 repo 自动开工作区 ----

test('claim：人类发言全员收到第一阶段 note（先报认领/禁止改码），dispatch 进 claiming', () => {
  const { rooms, roomId, team } = setup('claim')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家一起评估这个方案')

  for (const sid of ['sa', 'sb']) {
    const note = sent[sid]?.[0] ?? ''
    assert.ok(note.includes('先报认领'), `${sid} 应收到「先报认领」指令`)
    assert.ok(note.includes('禁止改任何代码'), `${sid} 应收到「禁止改码」指令`)
    assert.ok(note.includes('[claim]'), `${sid} 应被告知认领前缀`)
  }
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.mode, 'claim')
  assert.equal(d.phase, 'claiming')
  assert.equal(d.implementer, null)
  assert.ok(d.claimDeadline, 'claiming 应带认领截止时间')
  const byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'injected')
  assert.equal(byName.B.status, 'injected')
})

test('claim：先到先得——第一个 [claim] 成 Implementer，第二个转 reviewer，重复认领不重复放行', () => {
  const { rooms, roomId, team } = setup('claim')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '做个调研')
  relay.postMessage(roomId, 'A', '[claim] 我负责这一块')

  let d = projectDb.listDispatches(team)[0]
  assert.equal(d.implementer, 'A', '第一个认领的 A 应赢')
  assert.equal(d.phase, 'implementing')
  assert.equal(d.state, 'active')
  let byName = Object.fromEntries(d.deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'working', '赢家 delivery 应置 working')
  assert.equal(byName.B.status, 'done', '输家 delivery 应落定 done')

  const winnerNote = sent['sa'].find((t) => t.includes('可动手'))
  assert.ok(winnerNote, '赢家应收到第二阶段「可动手」note')
  const loserNote = sent['sb'].find((t) => t.includes('已认领该任务'))
  assert.ok(loserNote?.includes('reviewer'), '输家应收到转 reviewer 的轻量 note')

  // B 迟到再认领：只补一条「认领已被 A 获得」note，状态不动
  relay.postMessage(roomId, 'B', '[claim] 我也想做')
  const lateNote = sent['sb'].find((t) => t.includes('认领已被 A 获得'))
  assert.ok(lateNote, '迟到认领应收到「已被获得」note')
  d = projectDb.listDispatches(team)[0]
  assert.equal(d.implementer, 'A', '迟到认领不改变 implementer')
  assert.equal(d.phase, 'implementing')

  // 赢家重复 [claim]：不再重放第二阶段 note（幂等）
  relay.postMessage(roomId, 'A', '[claim] 再说一次')
  assert.equal(sent['sa'].filter((t) => t.includes('可动手')).length, 1, '第二阶段 note 不应重放')
  byName = Object.fromEntries(projectDb.listDispatches(team)[0].deliveries.map((x) => [x.memberName, x]))
  assert.equal(byName.A.status, 'working')
})

test('claim：非目标成员（未被投递）不能抢单', () => {
  const { rooms, roomId, team } = setup('claim')
  const { manager } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '@A 你单独评估') // 显式指派只有 A 进单
  relay.postMessage(roomId, 'B', '[claim] 我想抢')
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.deliveries.length, 1)
  assert.equal(d.implementer, null, '没被投递的 B 不应能认领')
  assert.equal(d.phase, 'claiming')
})

test('claim：认领超时收单，原因留痕，不自动重投', () => {
  const { rooms, roomId, team } = setup('claim')
  const { manager, sent } = mockManager(['sa', 'sb'])
  // claimDeadlineMs:0 → deadline 即当下，下一个 tick 必过期
  const relay = new RoomRelay(rooms, manager as never, () => {}, { claimDeadlineMs: 0 })
  relay.postMessage(roomId, 'Owner', '限时认领')
  tick(relay)

  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.state, 'done')
  assert.equal(d.phase, 'done')
  assert.equal(d.cancelReason, '无人认领超时')
  assert.equal(d.implementer, null)
  // 超时后再认领无效
  relay.postMessage(roomId, 'A', '[claim] 现在还来得及吗')
  assert.equal(sent['sa'].filter((t) => t.includes('可动手')).length, 0, '超时收单后不应再放行')
})

test('claim + 绑 repo：赢家获批自动开工作区（目录/分支真实存在、从 HEAD 切出），重复触发幂等', () => {
  const { rooms, roomId, team } = setup('claim')
  const repo = gitRepo()
  rooms.setRepoPath(roomId, repo)
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', 'fix login bug')
  relay.postMessage(roomId, 'A', '[claim] 我来修')

  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.implementer, 'A')
  assert.ok(d.worktreePath, '应记录工作区路径')
  assert.ok(d.branch, '应记录分支名')
  // 目录约定：<repo父目录>/<repo名>-wt/<slug>；分支约定：areco/<成员>-<slug>
  assert.equal(path.basename(path.dirname(d.worktreePath!)), `${path.basename(repo)}-wt`)
  assert.equal(path.basename(d.worktreePath!), 'fix-login-bug')
  assert.equal(d.branch, 'areco/a-fix-login-bug')
  assert.ok(fs.existsSync(d.worktreePath!), '工作区目录应真实存在')
  assert.ok(gitOut(repo, ['branch', '--list', d.branch!]).includes(d.branch!), '分支应真实存在')
  // 分支从主仓 HEAD 切出
  assert.equal(gitOut(d.worktreePath!, ['rev-parse', 'HEAD']), gitOut(repo, ['rev-parse', 'HEAD']))

  // 赢家第二阶段 note 含工作区路径 + 分支 + 纪律三句
  const note = sent['sa'].find((t) => t.includes('可动手'))
  assert.ok(note?.includes(d.worktreePath!), 'note 应含工作区绝对路径')
  assert.ok(note?.includes(d.branch!), 'note 应含分支名')
  assert.ok(note?.includes('不碰主检出') && note?.includes('WIP') && note?.includes('不执行合并'), 'note 应含纪律说明')

  // 幂等：同一 dispatch 重复放行复用既有目录/分支，不报错不重建
  const room = rooms.get(roomId)
  const winner = room.members.find((m) => m.name === 'A')!
  const before = gitOut(d.worktreePath!, ['rev-parse', 'HEAD'])
  ;(relay as unknown as { claimWon(r: unknown, d: unknown, m: unknown): void }).claimWon(
    room,
    projectDb.dispatchById(d.id),
    winner
  )
  const d2 = projectDb.dispatchById(d.id)!
  assert.equal(d2.worktreePath, d.worktreePath)
  assert.equal(d2.branch, d.branch)
  assert.equal(gitOut(d2.worktreePath!, ['rev-parse', 'HEAD']), before, '复用不应产生新提交')
})

test('claim + 中文任务名：slug 净化为空兜底 d<dispatchId>', () => {
  const { rooms, roomId, team } = setup('claim')
  const repo = gitRepo()
  rooms.setRepoPath(roomId, repo)
  const { manager } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '修复登录缺陷')
  relay.postMessage(roomId, 'A', '[claim] 我来')

  const d = projectDb.listDispatches(team)[0]
  assert.equal(path.basename(d.worktreePath!), `d${d.id}`, '中文净化为空应兜底 dispatch id')
  assert.ok(fs.existsSync(d.worktreePath!))
})

test('claim：implementer 会话退出时工作区脏文件兜底提交', () => {
  const { rooms, roomId, team } = setup('claim')
  const repo = gitRepo()
  rooms.setRepoPath(roomId, repo)
  const { manager } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', 'dirty work test')
  relay.postMessage(roomId, 'A', '[claim] 接了')
  const d = projectDb.listDispatches(team)[0]
  assert.ok(d.worktreePath)

  // 弄脏工作区后删会话：应自动 add -A + commit
  fs.writeFileSync(path.join(d.worktreePath!, 'wip.txt'), '半成品\n')
  const headBefore = gitOut(d.worktreePath!, ['rev-parse', 'HEAD'])
  ;(relay as unknown as { onSessionRemoved(id: string): void }).onSessionRemoved('sa')

  assert.equal(gitOut(d.worktreePath!, ['status', '--porcelain']), '', '兜底提交后工作区应干净')
  const log = gitOut(d.worktreePath!, ['log', '--oneline', '-1'])
  assert.ok(log.includes(`wip: 会话退出兜底提交 (dispatch #${d.id})`), 'git log 应见兜底提交')
  assert.notEqual(gitOut(d.worktreePath!, ['rev-parse', 'HEAD']), headBefore)

  // 干净工作区再退出：不产生多余提交（幂等）
  const headAfter = gitOut(d.worktreePath!, ['rev-parse', 'HEAD'])
  ;(relay as unknown as { onSessionRemoved(id: string): void }).onSessionRemoved('sa')
  assert.equal(gitOut(d.worktreePath!, ['rev-parse', 'HEAD']), headAfter)
})

test('rooms：绑定 repo 校验必须是 git 仓', () => {
  const { rooms, roomId } = setup('claim')
  const repo = gitRepo()
  rooms.setRepoPath(roomId, repo)
  assert.equal(rooms.get(roomId).repoPath, repo)
  assert.throws(() => rooms.setRepoPath(roomId, os.tmpdir()), /不是 git 仓库/)
  rooms.setRepoPath(roomId, null) // 解绑
  assert.equal(rooms.get(roomId).repoPath, null)
})
