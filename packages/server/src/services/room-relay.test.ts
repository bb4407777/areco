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

test('人类无 @ 发言全体收到：串行先放行第一位，回复后轮到下一位', () => {
  const { rooms, roomId, name } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '大家看下这个报错')
  assert.ok(sent['sa']?.length, '成员顺序第一位 A 应先被放行')
  assert.equal(sent['sb'], undefined, 'B 排队等 A 回复，不同时实施')
  const note = sent['sa'][0]
  assert.match(note, new RegExp(`\\[任务·${name}\\] Owner: 大家看下这个报错`))
  assert.match(note, /共享上下文/, '人→agent 投递应附共享上下文')
  assert.match(note, /context\.md/, '应给出纪要文件路径')
  assert.match(note, /必须执行下面命令/, '应附回执命令')
  relay.postMessage(roomId, 'A', '我看完了，没问题') // 回复驱动轮转
  // 前一条 assert 把 sent['sb'] 控制流收窄成 undefined；postMessage 会原位写入桩对象，显式恢复字典类型。
  assert.ok((sent as Sent)['sb']?.length, 'A 回复后 B 被放行，收到同一条根消息')
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
  const { rooms, team } = setup()
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
  const { rooms, team } = setup()
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
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm3', kind: 'fact', claim: '共享缓存条目', source: 'test' }]),
  })
  let n = 0
  try {
    relay.postMessage(roomId, 'Owner', '全体成员看下这个') // 无 @ → 全体收到，串行先放行 A
    relay.postMessage(roomId, 'A', '我看完了') // 回复驱动轮转：B 注入内容回取同一根消息
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sa']?.length && sent['sb']?.length, '两个成员先后都应收到')
  assert.match(sent['sb'][0], /【auto-recall 命中 1：m3】/, '轮到的第二成员复用缓存块')
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
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {}, { humanRelayAgents: ['Hermes'] })
  // agent 互发把链深推到 MAX_DEPTH=3：第 3 条起只落库不投递
  relay.postMessage(roomId, 'A', '@B 深度一')
  relay.postMessage(roomId, 'A', '@B 深度二')
  relay.postMessage(roomId, 'A', '@B 深度三（应被拦）')
  const blockedAt = sent['sb']?.length ?? 0
  assert.equal(blockedAt, 2, '第 3 条应被防环闸拦下')
  // Hermes 转述维护者原话：无 @ 也默认投全体（全体收到；串行先放行第一位 A），且清零链深
  relay.postMessage(roomId, 'Hermes', '收到请回复', { humanRelay: true })
  assert.ok((sent['sa']?.length ?? 0) >= 1, '转述后 A 先收到（串行放行第一位）')
  assert.equal(sent['sb']!.length, blockedAt, 'B 在转述单里排队，等 A 回复')
  // 清零生效：A 的 @B 委派投出（+1）；同时 A 发言驱动转述单轮转，B 收到转述根消息（+1）
  relay.postMessage(roomId, 'A', '@B 解锁后')
  assert.equal(sent['sb']!.length, blockedAt + 2, '链深清零后委派恢复 + 转述轮到 B')
  assert.ok(sent['sb']!.some((x) => /收到请回复/.test(x)), 'B 轮到时收到转述根消息')
})

test('human_relay：名单外 agent 打标无效——不广播、不清零、照常计深', () => {
  const { rooms, roomId } = setup()
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

test('项目房间驻场简报：每个进程代际只带一次 PROJECT.md 指路；任务房不带', () => {
  const rooms = new RoomStore('Owner')
  const proj = rooms.create(`areco-proj${++seq}`, 'project', '/tmp/proj-root')
  rooms.addMember(proj.id, { name: 'A', kind: 'session', sessionId: 'sa' })
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(proj.id, 'Owner', '先熟悉一下环境')
  assert.match(sent['sa'][0], /驻场成员/, '首条投递应带驻场简报')
  assert.match(sent['sa'][0], /\/tmp\/proj-root\/PROJECT\.md/, '简报应指向项目宪章')
  assert.match(sent['sa'][0], /^\[项目·/, '项目房间注入前缀应为「项目·」（2026-07-29 文案修正：按 kind 区分任务/项目）')
  assert.match(sent['sa'][0], /在项目里看不到/, '项目房间回执提示应说「项目」')
  relay.postMessage(proj.id, 'Owner', '再看看这个')
  assert.equal(sent['sa'].length, 2)
  assert.doesNotMatch(sent['sa'][1], /驻场成员/, '同代际第二条不再重复简报')

  // 任务房（kind 默认 task）即便绑了 rootPath 也不带简报——PROJECT.md 是项目专属约定
  const task = rooms.create(`areco-task${++seq}`)
  rooms.setRootPath(task.id, '/tmp/task-root')
  rooms.addMember(task.id, { name: 'B', kind: 'session', sessionId: 'sb' })
  relay.postMessage(task.id, 'Owner', '看下报错')
  assert.doesNotMatch(sent['sb'][0], /驻场成员/, '任务房不带驻场简报')
  assert.match(sent['sb'][0], /^\[任务·/, '任务房间注入前缀应为「任务·」（2026-07-29 高律师令）')
  assert.match(sent['sb'][0], /在任务里看不到，必须执行下面命令把回复发回任务/, '任务房间回执提示应说「任务」')
})

// ---- 2026-07-29 冒名回执事件（hy3 接手 Glm5.2 会话后照抄旧回执命令，成果记到 GLM 头上）三层修复 ----

/** 带模板信息的假 SessionManager：get 返回带 templateId/isRunning/trafficState 的会话，
 *  templateNameOf 按映射解析（模板名取不到返回 null）。接口同 mockManager，另加署名校正所需字段 */
function mockManagerTpls(
  sessionSpecs: { id: string; templateId: string; isRunning?: boolean }[],
  tplNames: Record<string, string>
): { manager: unknown; sent: Sent } {
  const sent: Sent = {}
  const byId = new Map(sessionSpecs.map((s) => [s.id, s]))
  const manager = {
    list: () => sessionSpecs.map((s) => ({ id: s.id, status: s.isRunning === false ? 'exited' : 'running' })),
    get: (id: string) => {
      const s = byId.get(id)
      if (!s) throw new Error(`会话不存在: ${id}`)
      return {
        id: s.id,
        templateId: s.templateId,
        isRunning: s.isRunning !== false,
        trafficState: 'idle',
        onceQuiet: (fn: () => void) => fn(),
        sendline: (text: string) => {
          ;(sent[id] ??= []).push(text)
        },
        on: () => {},
        off: () => {},
      }
    },
    templateNameOf: (session: { templateId: string }) => tplNames[session.templateId] ?? null,
  }
  return { manager, sent }
}

/** 临时接管 console.log 抓 room-relay 的 log 行（logger warn 走 console.log），finally 必须恢复 */
function spyLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.log = orig
    },
  }
}

test('Layer1：投递 note 含反冒名指令，回执命令仍带成员名（正常路径可直接复制粘贴）', () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  relay.postMessage(roomId, 'Owner', '@A 处理一下')
  const note = sent['sa'][0]
  assert.match(note, /必须执行下面命令/, '回执命令提示仍在')
  assert.match(note, /'A' 'Owner' '<你的回复>'/, '回执命令仍带成员名，正常路径可直接复制')
  assert.match(note, /实际执行者不是 A 本人/, '应点名「会话被接手/代跑」的情形')
  assert.match(note, /改成执行者自己的实际 Stand 名/, '应要求改成实际执行者署名')
  assert.match(note, /禁止照抄原署名/, '应含明确禁令')
})

test('Layer2：绑定会话被别的模板接手时，tick 摄入的外部回执 from 校正为当前模板名（主循环分支）', () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-sign${++seq}`)
  rooms.addMember(room.id, { name: 'Glm5.2', kind: 'session', sessionId: 'sa', templateId: 'tpl-glm' })
  const { manager, sent } = mockManagerTpls([{ id: 'sa', templateId: 'tpl-hy3' }], { 'tpl-hy3': 'hy3' })
  const broadcasts: { type: string; roomId?: string; message?: { from: string } }[] = []
  const relay = new RoomRelay(rooms, manager as never, (msg) => broadcasts.push(msg as never))
  futureStart(relay)
  const tick = () => (relay as unknown as { tick(): void }).tick()
  tick() // 初见建游标（本房尚无消息）
  const spy = spyLogs()
  try {
    projectDb.send(room.team, 'Glm5.2', 'Owner', '干完了，成果如下') // hy3 照抄旧命令，署名仍是 Glm5.2
    tick()
  } finally {
    spy.restore()
  }
  const rows = projectDb.history(room.team, 10)
  assert.equal(rows[rows.length - 1].from, 'hy3', '库里行 from_agent 应被改写为当前模板名')
  const roomMsg = broadcasts.find((b) => b.type === 'roomMessage' && b.roomId === room.id)
  assert.equal(roomMsg?.message?.from, 'hy3', '广播消息应用校正后署名')
  assert.ok(
    spy.lines.some((w) => /署名修正 Glm5\.2→hy3/.test(w) && /tpl-hy3/.test(w)),
    '应记「署名修正 X→Y（会话被模板 Z 接手）」warn'
  )
  // 校正后 from 非成员名：走「from 不在 members 默认 session」兜底——无 @ 不投递、不误判 human、不死循环
  assert.equal(sent['sa'], undefined, '校正后不得误投回绑定会话')
})

test('Layer2：初见房间分支（启动后新帖）同样校正署名', () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-sign-ff${++seq}`)
  rooms.addMember(room.id, { name: 'Glm5.2', kind: 'session', sessionId: 'sa', templateId: 'tpl-glm' })
  projectDb.send(room.team, 'Glm5.2', 'Owner', '接手机器人的第一条回执')
  const { manager } = mockManagerTpls([{ id: 'sa', templateId: 'tpl-hy3' }], { 'tpl-hy3': 'hy3' })
  const broadcasts: { type: string; roomId?: string; message?: { from: string } }[] = []
  const relay = new RoomRelay(rooms, manager as never, (msg) => broadcasts.push(msg as never))
  // startedAt 拨到「现在」：本条新帖不被快进（他案存量因远早于此被快进跳过）
  ;(relay as unknown as { startedAtMs: number }).startedAtMs = Date.now()
  ;(relay as unknown as { tick(): void }).tick()
  const rows = projectDb.history(room.team, 10)
  assert.equal(rows[rows.length - 1].from, 'hy3', '初见分支摄入的新帖也应被校正')
  // 共享临时根下他案房间同轮也会广播（本 relay 初见全部房间），须按 roomId 捞本房的
  const roomMsg = broadcasts.find((b) => b.type === 'roomMessage' && b.roomId === room.id)
  assert.equal(roomMsg?.message?.from, 'hy3')
})

test('Layer2：templateId 一致 / 会话已死 / 校正目标与房内成员重名——边界行为', () => {
  // 一致：不动
  const rooms = new RoomStore('Owner')
  const room1 = rooms.create(`areco-sign-same${++seq}`)
  rooms.addMember(room1.id, { name: 'Glm5.2', kind: 'session', sessionId: 'sa', templateId: 'tpl-glm' })
  const { manager: m1 } = mockManagerTpls([{ id: 'sa', templateId: 'tpl-glm' }], { 'tpl-glm': 'Glm5.2' })
  const relay1 = new RoomRelay(rooms, m1 as never, () => {})
  futureStart(relay1)
  const tick1 = () => (relay1 as unknown as { tick(): void }).tick()
  tick1()
  projectDb.send(room1.team, 'Glm5.2', 'Owner', '正常回执')
  tick1()
  const rows1 = projectDb.history(room1.team, 10)
  assert.equal(rows1[rows1.length - 1].from, 'Glm5.2', 'templateId 一致时不动')

  // 会话已死（exited 仍在 Map）：不动——死会话的 templateId 证明不了当前执行者
  const room2 = rooms.create(`areco-sign-dead${++seq}`)
  rooms.addMember(room2.id, { name: 'Glm5.2', kind: 'session', sessionId: 'sd', templateId: 'tpl-glm' })
  const { manager: m2 } = mockManagerTpls(
    [
      { id: 'sa', templateId: 'tpl-glm' },
      { id: 'sd', templateId: 'tpl-hy3', isRunning: false },
    ],
    { 'tpl-hy3': 'hy3' }
  )
  const relay2 = new RoomRelay(rooms, m2 as never, () => {})
  futureStart(relay2)
  const tick2 = () => (relay2 as unknown as { tick(): void }).tick()
  tick2()
  projectDb.send(room2.team, 'Glm5.2', 'Owner', '会话死后到达的回执')
  tick2()
  const rows2 = projectDb.history(room2.team, 10)
  assert.equal(rows2[rows2.length - 1].from, 'Glm5.2', '绑定会话已退出时不动')

  // 校正目标名与房内另一成员重名：照改（from 只作署名，member 匹配走错名兜底）
  const room3 = rooms.create(`areco-sign-clash${++seq}`)
  rooms.addMember(room3.id, { name: 'Glm5.2', kind: 'session', sessionId: 'sa', templateId: 'tpl-glm' })
  rooms.addMember(room3.id, { name: 'hy3', kind: 'session', sessionId: 'se', templateId: 'tpl-hy3' })
  const { manager: m3 } = mockManagerTpls(
    [
      { id: 'sa', templateId: 'tpl-hy3' },
      { id: 'se', templateId: 'tpl-hy3' },
    ],
    { 'tpl-hy3': 'hy3' }
  )
  const relay3 = new RoomRelay(rooms, m3 as never, () => {})
  futureStart(relay3)
  const tick3 = () => (relay3 as unknown as { tick(): void }).tick()
  tick3()
  projectDb.send(room3.team, 'Glm5.2', 'Owner', '校正后与 B 成员重名')
  tick3()
  const rows3 = projectDb.history(room3.team, 10)
  assert.equal(rows3[rows3.length - 1].from, 'hy3', '与房内另一成员重名也照改')
})

test('Layer2 懒补：存量 member（无 templateId）首轮见到存活 session 即回填并持久化', () => {
  const { rooms, roomId, team } = setup() // setup 的 addMember 不带 templateId = 存量 member
  const { manager } = mockManagerTpls(
    [
      { id: 'sa', templateId: 'tpl-glm' },
      { id: 'sb', templateId: 'tpl-ds' },
    ],
    { 'tpl-glm': 'Glm5.2' }
  )
  const relay = new RoomRelay(rooms, manager as never, () => {})
  futureStart(relay)
  const tick = () => (relay as unknown as { tick(): void }).tick()
  tick()
  projectDb.send(team, 'A', 'Owner', '一条来自 A 的回执')
  tick()
  const memberA = rooms.get(roomId).members.find((m) => m.name === 'A')
  assert.equal(memberA?.templateId, 'tpl-glm', '首轮见到即回填绑定会话的 templateId')
  const persisted = new RoomStore('Owner').get(roomId).members.find((m) => m.name === 'A')
  assert.equal(persisted?.templateId, 'tpl-glm', '回填应持久化到 rooms.json')
  const rows = projectDb.history(team, 10)
  assert.equal(rows[rows.length - 1].from, 'A', '回填即绑定现状，署名不动')
  // 下一轮再见到：不覆盖既有值（stampMemberTemplate 只补空缺）
  projectDb.send(team, 'A', 'Owner', '第二条')
  tick()
  assert.equal(rooms.get(roomId).members.find((m) => m.name === 'A')?.templateId, 'tpl-glm')
})

test('Layer3：captureTick 自动捕获回执用会话当前实际模板名署名，取不到回退成员名', () => {
  const { rooms, roomId, team, name } = setup()
  const { manager } = mockManagerTpls(
    [
      { id: 'sa', templateId: 'tpl-hy3' },
      { id: 'sb', templateId: 'tpl-gone' }, // 模板名取不到 → 回退成员名
    ],
    { 'tpl-hy3': 'hy3' }
  )
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const r = relay as unknown as {
    readSessionDelta: () => unknown[]
    pendingCapture: Map<
      string,
      { team: string; roomName: string; roomId: string; memberName: string; fromName: string; beforeCount: number; injectedAt: number }
    >
    captureTick: () => void
  }
  r.readSessionDelta = () => [{ role: 'assistant', parts: [{ kind: 'text', text: '自动捕获的回复' }] }]
  r.pendingCapture.set('sa', {
    team,
    roomName: name,
    roomId,
    memberName: 'A',
    fromName: 'Owner',
    beforeCount: 0,
    injectedAt: Date.now(),
  })
  r.captureTick()
  let rows = projectDb.history(team, 10)
  assert.equal(rows[rows.length - 1].from, 'hy3', '自动捕获署名应为当前实际模板名（防接手后代跑冒名）')
  assert.equal(rows[rows.length - 1].to, 'Owner', '收件人仍是原投递者')

  r.pendingCapture.set('sb', {
    team,
    roomName: name,
    roomId,
    memberName: 'B',
    fromName: 'Owner',
    beforeCount: 0,
    injectedAt: Date.now(),
  })
  r.captureTick()
  rows = projectDb.history(team, 10)
  assert.equal(rows[rows.length - 1].from, 'B', '模板名取不到时回退成员名')
})
