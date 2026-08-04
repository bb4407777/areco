// 项目协作投递行为：人类发言默认投全体（不必手打 @all）、共享上下文纪要、agent 无@不广播、@指定成员回归。
// 隔离：先于 import 设 ARECO_ROOT 到临时目录，project-db/rooms 落盘都在其下（不污染真库）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-relay-'))
process.env.ARECO_ROOT = root
// auto-recall 测试需脚本路径非空（假 recallRunner 不起真子进程，路径值本身不被使用）
process.env.ARECO_RECALL_SCRIPT = 'recall-stub'
// 2026-08-02 投递竞态修复（FIX A/B/C/D）测试：收缩回显验证/退避/就绪门时序，让重试链毫秒级
// 跑完（生产值 8s×4 次 + [0,3,9,18]s 退避会把测试拖到分钟级）。比例关系与生产一致。
process.env.ARECO_ECHO_VERIFY_MS = '40'
process.env.ARECO_ECHO_BACKOFF_MS = '0,15,25,35'
process.env.ARECO_FIRST_OUTPUT_MAX_WAIT_MS = '250'
// 2026-08-04 FIX E（提交确认门）：回显后再等一窗确认 marker 未再现（=输入框已清空=已提交）。
// 同样收缩到毫秒级；补注放行、串行落账等都改为等这道门，故各用例 sleep 需覆盖 ECHO+SUBMIT 两窗。
process.env.ARECO_SUBMIT_VERIFY_MS = '30'
process.env.ARECO_SUBMIT_MAX_NUDGES = '2'

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

// ---- auto-recall 记忆注入（2026-07-22 定稿；2026-07-30 P1-6 异步化）：recallRunner 注入点
// 替换真子进程。异步化后的行为：缓存冷 → 正文先行注入（不带块），recall 完成后补注一条
// 「auto-recall 补充」note；缓存热（同根消息再投）→ 块直接拼进正文（旧行为）。
// 2026-08-02 FIX A（qclaw 58af1338 事故）后补注加「正文送达门」：正文回显确认后才补注，
// 正文终败则丢弃——补注绝不允许先于正文成为会话首条消息。

/** 可回显假会话（FIX A/B/C/D 测试）：真 EventEmitter 输出流，sendline 默认异步回显整条 wire
 *  （尾部 nonce 落进回显验证窗 → 判送达）；swallow>0 时前 N 次 sendline 被吞（零回显，复现
 *  qclaw 启动盲窗）。startedAt/lastOutputAt 供就绪门（FIX B）脚本化：默认 startedAt=null =
 *  门直通（等价于「已画过屏」的存量会话）。 */
class EchoSession extends EventEmitter {
  sent: string[] = []
  isRunning = true
  startedAt: number | null = null
  lastOutputAt = 0
  swallow = 0
  /** FIX E：模拟「文本进了输入框但没提交」——TUI 持续重绘把 marker 一直摆在屏幕上。
   *  >0 时每次重绘都再吐一遍 wire；每收到一个裸 \r（=补回车）减 1，减到 0 视为终于提交。
   *  设为 Infinity 可模拟怎么补都提交不了的死会话。 */
  stuckInInput = 0
  /** 收到的裸回车次数（FIX E nudge 计数） */
  nudges = 0
  private lastWire = ''
  private repaint: NodeJS.Timeout | null = null
  constructor(readonly id: string) {
    super()
  }
  onceQuiet(fn: () => void) {
    fn()
  }
  /** 生产 Session.write 的最小替身：FIX E 补裸回车走这里（单独 '\r' 不拆帧） */
  write(data: string, _opts?: { markWorking?: boolean }) {
    if (data !== '\r') return
    this.nudges += 1
    if (this.stuckInInput > 0 && this.stuckInInput !== Infinity) this.stuckInInput -= 1
    if (this.stuckInInput === 0) this.stopRepaint() // 提交成功：输入框清空，marker 不再出现
  }
  private stopRepaint() {
    if (this.repaint) {
      clearInterval(this.repaint)
      this.repaint = null
    }
  }
  /** 测试收尾：清掉重绘定时器，防用例间泄漏拖住 runner */
  dispose() {
    this.stopRepaint()
  }
  sendline(text: string) {
    this.sent.push(text)
    this.lastWire = text
    if (this.swallow > 0) {
      this.swallow -= 1
      return // 被吞：注入落进未就绪输入层，零回显
    }
    setTimeout(() => {
      this.lastOutputAt = Date.now()
      this.emit('output', text) // 回显整条 wire：尾部 nonce 可被验证窗捕获
      if (this.stuckInInput > 0 && !this.repaint) {
        // 滞留输入框：持续重绘，marker 反复出现 → FIX E 的提交门应判「未提交」并补回车
        this.repaint = setInterval(() => {
          if (this.stuckInInput > 0) this.emit('output', this.lastWire)
          else this.stopRepaint()
        }, 10)
        this.repaint.unref?.()
      }
    }, 0)
  }
}

function mockEchoManager(ids: string[]): { manager: unknown; sessions: Map<string, EchoSession> } {
  const sessions = new Map(ids.map((id) => [id, new EchoSession(id)] as const))
  const manager = {
    list: () => ids.map((id) => ({ id, status: 'running' })),
    get: (id: string) => {
      const s = sessions.get(id)
      if (!s) throw new Error(`会话不存在: ${id}`)
      return s
    },
  }
  return { manager, sessions }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface RecallResult {
  error?: Error
  status: number | null
  stdout: string
}

/** 排空 recall 异步链（runRecall await + then 补注均为微任务，setTimeout 0 全覆盖） */
const settleRecall = () => new Promise((r) => setTimeout(r, 0))

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

test('auto-recall：human→agent 正文先行，正文回显确认后才补注块（FIX A 送达门）', async () => {
  const { rooms, roomId } = setup()
  const { manager, sessions } = mockEchoManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const sa = sessions.get('sa')!
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm1', kind: 'fact', claim: '记忆条目内容甲', source: 'test' }]),
  })
  try {
    relay.postMessage(roomId, 'Owner', '大家看下这个报错')
    assert.equal(sa.sent.length, 1, '正文应立即注入，不等 recall')
    assert.doesNotMatch(sa.sent[0], /auto-recall/, '首条正文不再同步等 recall 块')
    await settleRecall()
    // FIX A 关键断言：recall 已完成但正文回显（40ms 验证窗）尚未确认——补注只缓存不注入。
    // 旧行为在此刻直接补注，事故里就是它抢跑成了 qclaw 会话的首条消息。
    assert.equal(sa.sent.length, 1, '正文回显确认前补注不得注入')
    await sleep(150) // 越过回显验证窗(40)+FIX E 提交确认窗(30)：正文确认 → 送达门放行补注
  } finally {
    stub.restore()
  }
  assert.equal(sa.sent.length, 2, '正文确认后应补注一条')
  assert.match(sa.sent[1], /（auto-recall 补充，相关记忆供参考）/, '补注前缀不变')
  assert.match(sa.sent[1], /【auto-recall 命中 1：m1】/, '补注应含命中计数与记忆 id')
  assert.match(sa.sent[1], /- 记忆条目内容甲/, '补注应含 claim 截断行')
})

test('auto-recall：session→agent 含委派格式特征（交付物/owner）正文确认后触发补注', async () => {
  const { rooms, roomId } = setup()
  const { manager, sessions } = mockEchoManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm2', kind: 'sop', claim: '委派验收口径条目', source: 'test' }]),
  })
  let n = 0
  try {
    relay.postMessage(roomId, 'A', '@B 这个活派给你：交付物是复核报告，owner 是你')
    await settleRecall()
    await sleep(150) // 正文回显（40ms 验证窗）+ 提交确认（30ms）后送达门放行补注
    n = stub.count()
  } finally {
    stub.restore()
  }
  const sb = sessions.get('sb')!
  assert.ok(sb.sent.length, 'B 应收到投递')
  assert.match(sb.sent[1], /【auto-recall 命中 1：m2】/, '委派消息应补注 recall 块')
  assert.equal(n, 1, '应跑一次 recall 子进程')
})

test('auto-recall：session→agent 普通讨论（无委派特征）不触发，子进程不被调用', async () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({ status: 0, stdout: '[]' })
  let n = 0
  try {
    relay.postMessage(roomId, 'A', '@B 我觉得这个方案挺合理')
    await settleRecall()
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.equal(sent['sb']?.length, 1, '普通讨论照常投递且无补注')
  assert.doesNotMatch(sent['sb'][0], /auto-recall/, '不应注入 recall 块')
  assert.equal(n, 0, '不应起 recall 子进程')
})

test('auto-recall：同一根消息后投成员命中缓存，块直接拼正文（只跑一次子进程）', async () => {
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
    await settleRecall() // A 的 recall 完成 → memo 已写
    relay.postMessage(roomId, 'A', '我看完了') // 回复驱动轮转：B 注入内容回取同一根消息
    await settleRecall()
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.ok(sent['sa']?.length && sent['sb']?.length, '两个成员先后都应收到')
  assert.match(sent['sb'][0], /【auto-recall 命中 1：m3】/, '缓存热：轮到的第二成员块拼进正文')
  assert.equal(n, 1, '同一 root message 只起一次子进程')
})

test('auto-recall：子进程超时/非零退出/非法 JSON 均静默降级，投递照常完成、无补注', async () => {
  const scenarios: [string, RecallResult][] = [
    ['超时', { error: new Error('execFile ETIMEDOUT'), status: null, stdout: '' }],
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
      await settleRecall()
    } finally {
      stub.restore()
    }
    assert.equal(sent['sa']?.length, 1, `${label}：投递仍应完成且无补注`)
    assert.doesNotMatch(sent['sa'][0], /auto-recall/, `${label}：不应注入 recall 块`)
  }
})

test('auto-recall：recall 无命中（空数组）不注入任何内容', async () => {
  const { rooms, roomId } = setup()
  const { manager, sent } = mockManager(['sa'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({ status: 0, stdout: '[]' })
  let n = 0
  try {
    relay.postMessage(roomId, 'Owner', '查一个没有记忆支撑的主题')
    await settleRecall()
    n = stub.count()
  } finally {
    stub.restore()
  }
  assert.equal(sent['sa']?.length, 1, '投递照常完成且无补注')
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
  sessionSpecs: { id: string; templateId: string; isRunning?: boolean; trafficState?: string }[],
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
        trafficState: s.trafficState ?? 'idle',
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
    pendingCapture: Map<string, CapEntry>
    captureTick: () => void
  }
  r.readSessionDelta = () => [{ role: 'assistant', parts: [{ kind: 'text', text: '自动捕获的回复' }] }]
  r.pendingCapture.set('sa', capEntry({ team, roomName: name, roomId, memberName: 'A' }))
  // 弱文本（非交付物）走 8 拍稳定门槛：首拍建立基线，再 8 拍稳定才捕获
  for (let i = 0; i < 9; i++) r.captureTick()
  let rows = projectDb.history(team, 10)
  assert.equal(rows[rows.length - 1].from, 'hy3', '自动捕获署名应为当前实际模板名（防接手后代跑冒名）')
  assert.equal(rows[rows.length - 1].to, 'Owner', '收件人仍是原投递者')

  r.pendingCapture.set('sb', capEntry({ team, roomName: name, roomId, memberName: 'B' }))
  for (let i = 0; i < 9; i++) r.captureTick()
  rows = projectDb.history(team, 10)
  assert.equal(rows[rows.length - 1].from, 'B', '模板名取不到时回退成员名')
})

/** pendingCapture 条目模板（2026-07-30 交付物门槛加的稳定拍字段一并给默认值） */
type CapEntry = {
  team: string
  roomName: string
  roomId: string
  memberName: string
  fromName: string
  beforeCount: number
  injectedAt: number
  settleTicks: number
  lastLen: number
  lastDeltaCount: number
  deadlineAt: number
}
function capEntry(p: { team: string; roomName: string; roomId: string; memberName: string } & Partial<CapEntry>): CapEntry {
  return {
    fromName: 'Owner',
    beforeCount: 0,
    injectedAt: Date.now(),
    settleTicks: 0,
    lastLen: -1,
    lastDeltaCount: -1,
    deadlineAt: Date.now() + 60_000,
    ...p,
  }
}

test('Layer3：captureTick 交付物门槛——交付物 3 拍即收、开工白话干活中只顺延不抢收、收工后超时兜底', () => {
  const { rooms, roomId, team, name } = setup()
  const { manager } = mockManagerTpls(
    [
      { id: 'sa', templateId: 'tpl-hy3' }, // 灯 idle：已收工
      { id: 'sb', templateId: 'tpl-hy3', trafficState: 'working' }, // 灯 working：干活中
      { id: 'sc', templateId: 'tpl-hy3' },
    ],
    { 'tpl-hy3': 'hy3' }
  )
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const r = relay as unknown as {
    readSessionDelta: () => unknown[]
    pendingCapture: Map<string, CapEntry>
    captureTick: () => void
  }
  // ① 交付物文本（含产物路径）：首拍基线 + 3 拍稳定即收，第 3 拍还不收
  r.readSessionDelta = () => [{ role: 'assistant', parts: [{ kind: 'text', text: '迁移完成，产物路径：/tmp/x.md' }] }]
  r.pendingCapture.set('sa', capEntry({ team, roomName: name, roomId, memberName: 'A' }))
  for (let i = 0; i < 3; i++) r.captureTick()
  assert.equal(projectDb.history(team, 10).length, 0, '稳定拍未满不捕获')
  r.captureTick()
  let rows = projectDb.history(team, 10)
  assert.equal(rows.length, 1, '交付物文本 3 拍稳定即捕获')
  assert.ok(rows[0].body.includes('产物路径'), '捕获的是交付物正文')

  // ② 开工白话 + 灯 working + 已过软超时：不抢收，顺延 deadline（F2 事故根治点）
  r.readSessionDelta = () => [{ role: 'assistant', parts: [{ kind: 'text', text: '收到任务，我先读一下诊断报告再动手' }] }]
  const sb = capEntry({ team, roomName: name, roomId, memberName: 'B', deadlineAt: Date.now() - 1000 })
  r.pendingCapture.set('sb', sb)
  for (let i = 0; i < 12; i++) r.captureTick()
  assert.equal(projectDb.history(team, 10).length, 1, '干活中的开工白话不被捕获')
  assert.ok(r.pendingCapture.has('sb'), '条目保留（顺延等真收工）')
  assert.ok(sb.deadlineAt > Date.now(), 'deadline 已顺延到未来')
  r.pendingCapture.delete('sb')

  // ③ 收工（灯 idle）+ 过软超时的弱短文本：超时兜底照收（真短回复最迟 60s 收到）
  r.readSessionDelta = () => [{ role: 'assistant', parts: [{ kind: 'text', text: '好' }] }]
  r.pendingCapture.set('sc', capEntry({ team, roomName: name, roomId, memberName: 'C', deadlineAt: Date.now() - 1000 }))
  r.captureTick()
  rows = projectDb.history(team, 10)
  assert.equal(rows.length, 2, '已收工会话超时兜底捕获不受门槛拦截')
  assert.equal(rows[rows.length - 1].body, '好', '短回复原样入房')
})

// ---- 2026-08-02 sc 派单×auto-recall 投递竞态（qclaw 58af1338 事故）回归 ----
// 事故链：qclaw 冷 spawn 输入就绪滞后 ~28s，正文 3 次重发（8.0/17.2/26.4s）全落盲窗被吞；
// recall 补注却在会话就绪后落地，成为 Stand 收到的第一条也是唯一一条消息，88 字胡答被
// 自动捕获记成 completed。FIX A=补注过正文送达门；B=零输出就绪门；C=重试退避出盲窗；
// D=回显耗尽如实记 failed。测试时序用文件头 env 收缩（验证窗 40ms、退避 0/15/25/35ms、门上限 250ms）。

test('FIX C 重试预算：正文连吞两次后第三次落地，补注严格后于正文确认', async () => {
  const { rooms, roomId, team } = setup()
  const { manager, sessions } = mockEchoManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const sa = sessions.get('sa')!
  sa.swallow = 2 // 前两次 sendline 落进「启动盲窗」零回显（事故形态；旧预算第 3 次是最后机会）
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'mc', kind: 'fact', claim: '盲窗期先到的记忆', source: 'test' }]),
  })
  try {
    relay.postMessage(roomId, 'Owner', '@A 复核一下部署脚本')
    await settleRecall() // recall 先于正文送达完成（事故时序）
    assert.equal(sa.sent.length, 1, '第 1 次注入已发出（被吞）')
    assert.ok(!sa.sent.some((t) => t.includes('auto-recall 补充')), '正文未确认前补注不得出现')
    await sleep(400) // 链：40 验证 + 15 退避 + 40 验证 + 25 退避 + 第 3 次回显 + 40 验证 + 30 提交确认 ≈ 190ms
  } finally {
    stub.restore()
  }
  const notes = sa.sent.filter((t) => t.includes('auto-recall 补充'))
  assert.equal(sa.sent.length - notes.length, 3, '第 3 次重试落地（新预算 4 次内成功即停）')
  assert.equal(notes.length, 1, '正文确认后补注恰好一次')
  assert.equal(
    sa.sent.findIndex((t) => t.includes('auto-recall 补充')),
    sa.sent.length - 1,
    '补注严格最后：绝不先于正文成为会话消息'
  )
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.deliveries.find((x) => x.memberName === 'A')?.status, 'injected', '送达成功不误记 failed（FIX D 幂等闸回归）')
  assert.equal(d.state, 'active', '等 A 回复：串行队列语义不变')
})

test('FIX A/D 正文耗尽：4 次全吞 → 补注丢弃、自动捕获锚撤销、delivery 如实记 failed、串行收单', async () => {
  const { rooms, roomId, team } = setup()
  const { manager, sessions } = mockEchoManager(['sa', 'sb'])
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const sa = sessions.get('sa')!
  sa.swallow = Number.MAX_SAFE_INTEGER // 输入永不就绪：全部注入被吞
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'mx', kind: 'fact', claim: '不该被孤注的记忆', source: 'test' }]),
  })
  const spy = spyLogs()
  try {
    relay.postMessage(roomId, 'Owner', '@A 这单会全程被吞')
    await settleRecall()
    await sleep(500) // 链：4×40ms 验证 + 15+25+35ms 退避 ≈ 235ms，全走完（终败不进提交门）
  } finally {
    spy.restore()
    stub.restore()
  }
  assert.equal(sa.sent.length, 4, '新预算 4 次全部尝试（旧 3 次；无一是补注）')
  assert.ok(!sa.sent.some((t) => t.includes('auto-recall 补充')), '正文终败：补注必须丢弃，绝不孤注成首条消息')
  assert.ok(
    spy.lines.some((l) => /正文未确认送达，recall 补注丢弃 A/.test(l)),
    '应记补注丢弃 warn'
  )
  const r = relay as unknown as { pendingCapture: Map<string, unknown> }
  assert.equal(r.pendingCapture.has('sa'), false, '自动捕获锚应撤销——无关回复不得再被记成完成（事故垃圾完成根断点）')
  const d = projectDb.listDispatches(team)[0]
  assert.equal(d.deliveries.find((x) => x.memberName === 'A')?.status, 'failed', 'FIX D：回显耗尽如实记 failed，不再谎报 injected')
  assert.equal(d.state, 'done', '单收件人耗尽后如实收单，不冻死在幻影 current_target 上')
  assert.equal(d.currentTarget, null)
})

test('FIX B 就绪门：spawn 后零输出不注入，首屏输出后才注入；recall 先到也只能等正文（事故端到端）', async () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-boot${++seq}`)
  rooms.addMember(room.id, { name: 'Q', kind: 'session', sessionId: 'sq' })
  const { manager, sessions } = mockEchoManager(['sq'])
  const sq = sessions.get('sq')!
  sq.startedAt = Date.now() // 新 spawn：lastOutputAt(0) < startedAt → 就绪门生效
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'mq', kind: 'fact', claim: '先到的记忆', source: 'test' }]),
  })
  try {
    relay.postMessage(room.id, 'Owner', '@Q 任务书正文')
    await settleRecall() // 事故时序：recall（15:06:37.831）远早于会话就绪（15:07:05）完成
    assert.equal(sq.sent.length, 0, '零输出盲窗期：正文不注入（就绪门拦住）')
    await sleep(60)
    assert.equal(sq.sent.length, 0, '盲窗持续期间仍不注入，补注也不得先行')
    sq.lastOutputAt = Date.now()
    sq.emit('output', 'qclaw 首屏就绪') // 首个输出：门放行 → onceQuiet → 注入
    await sleep(150) // 正文回显 → 40ms 验证窗 → 30ms 提交确认 → 补注放行
  } finally {
    stub.restore()
  }
  assert.equal(sq.sent.length, 2, '首屏后正文+补注恰好各一')
  assert.match(sq.sent[0], /任务书正文/, '第一条必须是正文')
  assert.match(sq.sent[1], /auto-recall 补充/, '补注严格在正文回显确认之后')
})

test('FIX B 就绪门上限：始终零输出的哑会话到点强制放行，串行队列不挂死', async () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-mute${++seq}`)
  rooms.addMember(room.id, { name: 'M', kind: 'session', sessionId: 'sm' })
  const { manager, sessions } = mockEchoManager(['sm'])
  const sm = sessions.get('sm')!
  sm.startedAt = Date.now()
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({ status: 1, stdout: '' }) // recall 失败路径：settle(null) 清门即走
  try {
    relay.postMessage(room.id, 'Owner', '@M 哑会话兜底')
    assert.equal(sm.sent.length, 0, '门上限（250ms）前不注入')
    await sleep(400)
  } finally {
    stub.restore()
  }
  assert.ok(sm.sent.length >= 1, '上限到点退化为旧行为照常注入，不永久搁置')
  assert.match(sm.sent[0], /哑会话兜底/)
})

// ---- 2026-08-04 FIX E：提交确认门（回显 ≠ 提交）----
// 事故：单 C 的正文回显了（屏幕上 marker 在），但 sendline 尾回车在冷启动重绘中并帧沦为换行，
// 正文一直躺在输入框里，会话 0 token 静止 40 分钟——而 relay 已按旧口径判「送达」。

test('FIX E：文本滞留输入框（marker 反复重绘）→ 补裸回车后提交成功，判送达', async () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-fixe1${++seq}`)
  rooms.addMember(room.id, { name: 'S', kind: 'session', sessionId: 'ss' })
  const { manager, sessions } = mockEchoManager(['ss'])
  const ss = sessions.get('ss')!
  ss.stuckInInput = 1 // 卡一次：补一个裸回车后提交
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm1', kind: 'fact', claim: '记忆', source: 'test' }]),
  })
  try {
    relay.postMessage(room.id, 'Owner', '@S 正文')
    await sleep(260) // 回显 40 + 提交窗 30×N + 补注放行
  } finally {
    stub.restore()
    ss.dispose()
  }
  assert.equal(ss.nudges, 1, '应恰好补一次裸回车（不滥补）')
  assert.equal(ss.sent.length, 2, '提交确认后补注才放行：正文 + 补注')
  assert.match(ss.sent[0], /正文/, '第一条是正文')
  assert.match(ss.sent[1], /auto-recall 补充/, '补注严格后于提交确认')
})

test('FIX E：补满上限仍未提交 → 如实报未送达，补注被丢弃（不污染会话首条）', async () => {
  const rooms = new RoomStore('Owner')
  const room = rooms.create(`areco-fixe2${++seq}`)
  rooms.addMember(room.id, { name: 'D', kind: 'session', sessionId: 'sd' })
  const { manager, sessions } = mockEchoManager(['sd'])
  const sd = sessions.get('sd')!
  sd.stuckInInput = Infinity // 死会话：怎么补都提交不了
  const relay = new RoomRelay(rooms, manager as never, () => {})
  const stub = stubRecall({
    status: 0,
    stdout: JSON.stringify([{ id: 'm2', kind: 'fact', claim: '记忆', source: 'test' }]),
  })
  try {
    relay.postMessage(room.id, 'Owner', '@D 正文')
    await sleep(400) // 补满 ARECO_SUBMIT_MAX_NUDGES=2 次后终败
  } finally {
    stub.restore()
    sd.dispose()
  }
  assert.equal(sd.nudges, 2, '补满上限即止，不无限补回车')
  assert.equal(sd.sent.length, 1, '终败不放行补注——只有正文那一条 sendline')
  assert.match(sd.sent[0], /正文/)
  assert.ok(
    !sd.sent.some((t) => /auto-recall 补充/.test(t)),
    '正文未确认提交时补注必须被丢弃（否则重演 08-02 补注抢跑事故）'
  )
})
