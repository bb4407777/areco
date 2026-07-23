// 项目协作投递行为：人类发言默认投全体（不必手打 @all）、共享上下文纪要、agent 无@不广播、@指定成员回归。
// 隔离：先于 import 设 ARECO_ROOT 到临时目录，project-db/rooms 落盘都在其下（不污染真库）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-relay-'))
process.env.ARECO_ROOT = root
// auto-recall 测试需脚本路径非空（假 recallRunner 不起真子进程，路径值本身不被使用）
process.env.ARECO_RECALL_SCRIPT = 'recall-stub'

const { RoomRelay } = await import('./room-relay')
const { recallRunner } = await import('./room-relay')
const { RoomStore } = await import('./rooms')
const projectDb = await import('./project-db')

type Sent = Record<string, string[]>

/** 假 SessionManager：onceQuiet 立即执行（不等真实 quiet），sendline 记录到 sent[id] */
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
function setup(): { rooms: InstanceType<typeof RoomStore>; roomId: string; team: string; name: string } {
  const rooms = new RoomStore('Owner')
  const name = `areco${++seq}` // 每个 test 唯一项目名（rooms.json 在临时目录累积，防撞名）
  const room = rooms.create(name)
  rooms.addMember(room.id, { name: 'A', kind: 'session', sessionId: 'sa' })
  rooms.addMember(room.id, { name: 'B', kind: 'session', sessionId: 'sb' })
  return { rooms, roomId: room.id, team: room.team, name }
}

test('人类无 @ 发言默认投全体在线 agent（不必手打 @all）', () => {
  const { rooms, roomId, name } = setup()
  rooms.setDispatchMode(roomId, 'parallel') // 本测验证并行全员即注（项目默认已是 serial）
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家看下这个报错')
  assert.ok(sent['sa']?.length, 'A 应收到投递')
  assert.ok(sent['sb']?.length, 'B 应收到投递')
  const note = sent['sa'][0]
  assert.match(note, new RegExp(`\\[项目·${name}\\] Owner: 大家看下这个报错`))
  assert.match(note, /共享上下文/, '人→agent 投递应附共享上下文')
  assert.match(note, /context\.md/, '应给出纪要文件路径')
  assert.match(note, /必须执行下面命令/, '应附回执命令')
})

test('agent 无 @ 发言不广播（防 agent 互调失控）', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'A', '我查一下日志') // A 是 session 成员、无 @
  assert.equal(sent['sb'], undefined, 'B 不应被投递')
  assert.equal(sent['sa'], undefined, '自己也不投')
})

test('@指定成员只投该成员（原行为不破）', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '@B 你看一下')
  assert.equal(sent['sb']?.length, 1, 'B 收到')
  assert.equal(sent['sa'], undefined, '未被 @ 的 A 不投')
})

test('中文正文紧邻 @ 时只投指定成员，消息收件人不落成 all', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '你看下@B')
  assert.equal(sent['sb']?.length, 1, '被 @ 的 B 应收到')
  assert.equal(sent['sa'], undefined, '未被 @ 的 A 不应收到')
  assert.equal(projectDb.history(team, 1)[0].to, 'B', '数据库应记录明确收件人')
})

test('共享上下文纪要文件随消息刷新生成', () => {
  const { rooms, roomId, team } = setup()
  const { manager } = mockManager(['sa'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '第一条：讨论投递策略')
  // A 发言虽不广播，但仍落库 + 刷新纪要
  relay.postMessage(roomId, 'A', '第二条：我补充日志')
  const ctxFile = path.join(root, 'data', 'projects', `${team}.context.md`)
  assert.ok(fs.existsSync(ctxFile), '共享上下文纪要文件应生成')
  const content = fs.readFileSync(ctxFile, 'utf-8')
  assert.match(content, /共享上下文空间/, '纪要应有说明头')
  assert.match(content, /第一条：讨论投递策略/)
  assert.match(content, /第二条：我补充日志/)
})

test('agent 回执名字与花名册失配时不广播（防误判 human 触发自我死循环）', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  // 花名册成员名是 'A'，但 agent 回执时名字漂移（带全角括号/异写，真实场景里带空格的
  // "WorkBuddy CodeBuddy"、"Claude Code（Glm5.2）" 极易如此）—— find 精确匹配会失败。
  // 旧逻辑 fallback 'human' → 默认广播全体 + 清零防环 + 投递排除失效 → agent 收到自己消息 → 死循环。
  relay.postMessage(roomId, 'A（Glm5.2）', '我查一下日志')
  assert.equal(sent['sa'], undefined, '失配名字不该被当人类广播——尤其不能投回自己')
  assert.equal(sent['sb'], undefined, '失配名字不该广播给其他成员')
})

test('未知外部发言者（既非 humanName 也不在花名册）按 agent 处理，不广播', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, '某外部终端', '随手插一句')
  assert.equal(sent['sa'], undefined)
  assert.equal(sent['sb'], undefined)
})

test('归档项目只读，不再向 agent 投递', () => {
  const { rooms, roomId } = setup()
  rooms.archive(roomId)
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  assert.throws(() => relay.postMessage(roomId, 'Owner', '归档后不应发送'), /已归档/)
  assert.deepEqual(sent, {})
})

test('归档期间外部直写消息只推进游标，恢复后不补投', () => {
  const { rooms, roomId, team } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const broadcasts: unknown[] = []
  const relay = new RoomRelay(rooms, manager as never, (msg) => broadcasts.push(msg))
  const tick = () => (relay as unknown as { tick(): void }).tick()
  futureStart(relay) // 测试共享临时根（各用例房间互相可见）：视同中继后启动，首轮快进他案存量

  rooms.archive(roomId)
  tick()
  projectDb.send(team, '外部终端', 'all', '@all 归档期间的消息')
  tick()
  rooms.unarchive(roomId)
  tick()

  assert.deepEqual(sent, {}, '恢复后不应把归档期间消息补投给 agent')
  assert.equal(broadcasts.length, 0, '归档期间消息不应推送到实时项目流')
})

// ---- 2026-07-24 会诊房间三连修：to_agent 列兜底 / 初见竞态 / 外部编排者不计链深 ----

/** 把 relay 的启动时刻拨到未来：共享临时根里其他用例的存量房间首轮一律快进，隔离开案新帖 */
function futureStart(relay: unknown) {
  ;(relay as { startedAtMs: number }).startedAtMs = Date.now() + 60_000
}

test('外部直写消息正文无 @ 时按 to_agent 列投递（CLI 收件人不再被吞）', () => {
  const { rooms, roomId, team } = setup()
  rooms.setDispatchMode(roomId, 'parallel')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  futureStart(relay)
  const tick = () => (relay as unknown as { tick(): void }).tick()
  tick() // 初见房间建游标（他案存量快进；本房尚无消息）
  projectDb.send(team, '外部编排者', 'B', '任务书：请复核方案（正文无 @）')
  tick()
  assert.equal(sent['sb']?.length, 1, '应按 to_agent 列投给 B')
  assert.equal(sent['sa'], undefined, '未指定的 A 不应收到')
})

test('外部编排者（非花名册）连续委派不触发互调深度闸；房内成员互调仍计链深', () => {
  const { rooms, roomId, team } = setup()
  rooms.setDispatchMode(roomId, 'parallel')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  futureStart(relay)
  const tick = () => (relay as unknown as { tick(): void }).tick()
  tick()
  for (let i = 1; i <= 5; i++) projectDb.send(team, '外部编排者', 'A', `@A 第 ${i} 条任务`)
  tick()
  assert.equal(sent['sa']?.length, 5, '外部编排者代发不计链深，5 条全投')

  // 房内成员互调：depth 1/2 投递，第 3 条（≥MAX_DEPTH）只落库
  relay.postMessage(roomId, 'A', '@B 互调 1')
  relay.postMessage(roomId, 'A', '@B 互调 2')
  relay.postMessage(roomId, 'A', '@B 互调 3')
  assert.equal(sent['sb']?.length, 2, '成员互调达 MAX_DEPTH 后不再投递')
})

test('初见房间：中继启动前的存量快进不补投，之后的新帖照投', () => {
  const { rooms, roomId, team } = setup()
  rooms.setDispatchMode(roomId, 'parallel')
  projectDb.send(team, 'Owner', 'all', '@all 启动前的存量消息')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  // 模拟中继在消息落库之后才启动（重启恢复场景）
  futureStart(relay)
  const tick = () => (relay as unknown as { tick(): void }).tick()
  tick()
  assert.deepEqual(sent, {}, '启动前存量不补投（防重启重放）')
  projectDb.send(team, 'Owner', 'all', '@all 启动后的新帖')
  tick()
  assert.equal(sent['sa']?.length, 1, '之后的新帖照投')
  assert.match(sent['sa'][0], /启动后的新帖/)
})

// ---- auto-recall 记忆注入（2026-07-22）：recallRunner 注入点替换 spawnSync，不起真 python 子进程 ----

interface RecallResult {
  error?: Error
  status: number | null
  stdout: string
}

/** 替换 recallRunner.fn 为假实现；restore 必须调用（finally），防泄漏污染其他用例 */
function stubRecall(result: RecallResult): { count: () => number; restore: () => void } {
  const orig = recallRunner.fn
  let n = 0
  recallRunner.fn = (() => {
    n++
    return result
  }) as never
  return { count: () => n, restore: () => { recallRunner.fn = orig } }
}

test('auto-recall：human→agent 一律注入 recall 块（命中 id 与 claim 截断行进 note）', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm1', kind: 'fact', claim: '记忆条目内容甲', source: 'test' }]),
  })
  try {
    relay.postMessage(roomId, 'Owner', '大家看下这个报错')
  } finally {
    stub.restore()
  }
  const note = sent['sa'][0]
  assert.match(note, /【auto-recall 命中 1：m1】/, 'note 应含命中计数与记忆 id')
  assert.match(note, /- 记忆条目内容甲/, 'note 应含 claim 截断行')
})

test('auto-recall：session→agent 含委派格式特征（交付物/owner）触发注入', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm2', kind: 'sop', claim: '委派验收口径条目', source: 'test' }]),
  })
  let n = 0
  try {
    relay.postMessage(roomId, 'A', '@B 这个活派给你：交付物是复核报告，owner 是你')
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sb']?.length, 'B 应收到投递')
  assert.match(sent['sb'][0], /【auto-recall 命中 1：m2】/, '委派消息应注入 recall 块')
  assert.equal(n, 1, '应跑一次 recall 子进程')
})

test('auto-recall：session→agent 普通讨论（无委派特征）不触发，spawnSync 不被调用', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({ status: 0, stdout: '[]' })
  let n = 0
  try {
    relay.postMessage(roomId, 'A', '@B 我觉得这个方案挺合理')
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sb']?.length, '普通讨论照常投递')
  assert.doesNotMatch(sent['sb'][0], /auto-recall/, '不应注入 recall 块')
  assert.equal(n, 0, '不应起 recall 子进程')
})

test('auto-recall：同一根消息投多个成员只跑一次 recall 子进程（缓存复用）', () => {
  const { rooms, roomId } = setup()
  rooms.setDispatchMode(roomId, 'parallel') // 并行全员即注下才有一根消息投多成员的场景
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm3', kind: 'fact', claim: '共享缓存条目', source: 'test' }]),
  })
  let n = 0
  try {
    relay.postMessage(roomId, 'Owner', '全体成员看下这个') // 无 @ → 投全体
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sa']?.length && sent['sb']?.length, '两个成员都应收到')
  assert.match(sent['sb'][0], /【auto-recall 命中 1：m3】/, '第二成员复用缓存块')
  assert.equal(n, 1, '同一 root message 只起一次子进程')
})

test('auto-recall：子进程超时/非零退出/非法 JSON 均静默降级，投递照常完成', () => {
  const scenarios: [string, RecallResult][] = [
    ['超时', { error: new Error('spawnSync ETIMEDOUT'), status: null, stdout: '' }],
    ['非零退出', { status: 1, stdout: '' }],
    ['非法 JSON', { status: 0, stdout: 'not-json{' }],
  ]
  for (const [label, result] of scenarios) {
    const { rooms, roomId } = setup()
    const { manager, sent } = mockManager(['sa'])
    const relay = new RoomRelay(rooms, manager as never, () => {})
    const stub = stubRecall(result)
    try {
      relay.postMessage(roomId, 'Owner', '看下这个')
    } finally {
      stub.restore()
    }
    assert.ok(sent['sa']?.length, `${label}：投递仍应完成`)
    assert.doesNotMatch(sent['sa'][0], /auto-recall/, `${label}：不应注入 recall 块`)
  }
})

test('auto-recall：recall 无命中（空数组）不注入任何内容', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({ status: 0, stdout: '[]' })
  let n = 0
  try {
    relay.postMessage(roomId, 'Owner', '查一个没有记忆支撑的主题')
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sa']?.length, '投递照常完成')
  assert.doesNotMatch(sent['sa'][0], /auto-recall/, '空命中不注入')
  assert.equal(n, 1, 'human 消息仍跑了一次 recall（只是无命中）')
})

test('human_relay：白名单 agent 转述清零链深并默认投全体；链深满时转述可解锁', () => {
  const { rooms, roomId } = setup()
  rooms.setDispatchMode(roomId, 'parallel')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {}, { humanRelayAgents: ['Hermes'] })
  // agent 互发把链深推到 MAX_DEPTH=3：第 3 条起只落库不投递
  relay.postMessage(roomId, 'A', '@B 深度一')
  relay.postMessage(roomId, 'A', '@B 深度二')
  relay.postMessage(roomId, 'A', '@B 深度三（应被拦）')
  const blockedAt = sent['sb']?.length ?? 0
  assert.equal(blockedAt, 2, '第 3 条应被防环闸拦下')
  // Hermes 转述维护者原话：无 @ 也默认投全体，且清零链深
  relay.postMessage(roomId, 'Hermes', '收到请回复', { humanRelay: true })
  assert.ok((sent['sa']?.length ?? 0) >= 1, '转述后 A 收到（默认投全体）')
  assert.ok((sent['sb']?.length ?? 0) > blockedAt, '转述后 B 收到')
  // 清零生效：agent 消息恢复可投
  const beforeUnlock = sent['sb']!.length
  relay.postMessage(roomId, 'A', '@B 解锁后')
  assert.equal(sent['sb']!.length, beforeUnlock + 1, '链深清零后 agent 投递恢复')
})

test('human_relay：名单外 agent 打标无效——不广播、不清零、照常计深', () => {
  const { rooms, roomId } = setup()
  rooms.setDispatchMode(roomId, 'parallel')
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {}, { humanRelayAgents: ['Hermes'] })
  // 名单外成员 A 打标 + 无 @：若被误判人类会广播全体——正确行为是按 agent 处理不投递
  relay.postMessage(roomId, 'A', '我冒充人类说话', { humanRelay: true })
  assert.ok(!sent['sb']?.length && !sent['sa']?.length, '名单外打标不得广播')
  // 打标也不豁免计深：连发 @ 消息第 3 条仍被拦
  relay.postMessage(roomId, 'A', '@B 一', { humanRelay: true })
  relay.postMessage(roomId, 'A', '@B 二', { humanRelay: true })
  relay.postMessage(roomId, 'A', '@B 三', { humanRelay: true })
  assert.ok((sent['sb']?.length ?? 0) < 3, '名单外打标不清零链深，防环仍生效')
})
