// 项目协作中继：消息在项目消息库（project-db.ts），本服务做三件事——
// 1) 轮询拾取：2s 游标轮询各项目新消息（agent 用 areco-msg.mjs 回执的也从这进来），WS 广播给页面；
// 2) mention 投递：@成员/@all → onceQuiet 注入目标会话终端（注入模板带来源+回执命令）；
// 3) 防环：人发言清零链路深度；agent 消息触发投递时深度+1，≥MAX_DEPTH 只落库不投递。
// 页面发消息走 postMessage（落库 + 立即广播 + 投递），不等轮询；轮询只负责"外部进来的"消息。
// 房间调度（2026-07-22 确定性设计，不上 LLM selector）：消息可见性与行动许可拆开——
// 无 @ 的人类发言全体收到（message_targets 逐行落账），但 serial 模式一次只放行一位成员实施，
// 回复/超时/取消驱动轮转；parallel 模式保持现状全员即注。底账在 projects.db 的 dispatch/delivery 表。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { RoomInfo, RoomMember, RoomMessage, ServerMsg, TranscriptMessage } from '../../../shared/protocol'
import type { SessionManager } from './session-manager'
import type { Session } from './session'
import { DATA_DIR, MSG_CLI_PATH } from '../config'
import { createLogger } from '../logger'
import * as projectDb from './project-db'
import { ALL_MENTION, parseMentions, RoomStore } from './rooms'
import { shellQuote } from './templates'
import { agentKindOf, readAgentTranscript } from './agent-transcript'
import { transcriptPath } from './transcript'
import { readHistoryAllMessages } from './history'
import { ensureWorktree, slugify, wipCommit, worktreeDirFor } from './worktree'

const log = createLogger('room-relay')

const POLL_MS = 2000
const MAX_DEPTH = 3
/** 注入回显验证：重试次数与单次等待（回显标记为每次注入的唯一 nonce，见 injectNote） */
const ECHO_VERIFY_MS = 8000
const ECHO_MAX_ATTEMPTS = 3
/** 回执 CLI 的绝对路径（注入文案用）：任何终端执行即向本库写消息 */
const MSG_CLI = MSG_CLI_PATH

// ---- 共享上下文空间（维护者 2026-07-20 定：项目 = 一个共享上下文空间）----
// 每个项目房间维护一份最近消息纪要文件，投递/@ 时附路径 + 近况预览，
// 让被叫进来的 agent 一进来就看到来龙去脉，不再失忆（真实状态仍以 data/projects.db 为准）。
const CONTEXT_DIR = path.join(DATA_DIR, 'projects')
const CONTEXT_MAX_MESSAGES = 30 // 纪要文件保留条数
const CONTEXT_BODY_CLIP = 500 // 纪要里单条 body 截断
const CONTEXT_PREVIEW_N = 2 // 投递 note 内联的近况预览条数（排除当条）

// ---- 自动捕获 agent 回复（B）：注入后 agent 不主动回执时，从 transcript 取回复代为回执 ----
const CAPTURE_TIMEOUT_MS = 60_000 // 注入后最长等 agent 回复
const CAPTURE_TEXT_MAX = 2000 // 自动回执正文截断

/** serial 串行轮转：当前放行成员的回复超时（超过即置 timeout 自动放下一位）。
 *  走 RoomRelay 构造函数可选参数覆盖，测试传小值。 */
const DELIVERY_TIMEOUT_MS = 10 * 60_000

/** claim 认领制：报认领窗口（超时无人认领收单）。构造参数可注入，测试传小值。 */
const CLAIM_DEADLINE_MS = 5 * 60_000

// ---- auto-recall 记忆注入（2026-07-22 项目房间定稿）：投递 note 时自动跑统一记忆库 recall ----
// 人→agent 一律注入；agent→agent 仅正文命中委派格式特征才注入；dispatch 指令（from='areco-调度'）算委派。
// 每个 root message 只跑一次 recall（按 root id 缓存注入块），任何失败静默跳过，绝不阻塞/炸掉投递。
/** recall.py 路径：环境变量 ARECO_RECALL_SCRIPT 指定；未配置则 auto-recall 整体关闭（静默跳过，不影响投递） */
const RECALL_SCRIPT = process.env.ARECO_RECALL_SCRIPT ?? ''
const RECALL_TOPK = 4
const RECALL_TIMEOUT_MS = 3000
const RECALL_QUERY_CLIP = 120 // query 截断（recall.py 侧有中文 bigram 兜底）
const RECALL_CLAIM_CLIP = 60 // 注入块单条 claim 截断
const RECALL_MEMO_MAX = 500 // 缓存上限，防长驻进程 Map 无界增长
/** 委派格式特征：agent→agent 消息命中其一才跑 recall */
const DELEGATION_RE = /owner|交付物|验收口径|写集|交接路径|委派/i

/** python recall 子进程调用点：生产恒为真实 spawnSync；测试替换此注入点，不起真子进程（行为不变） */
export const recallRunner: { fn: typeof spawnSync } = { fn: spawnSync }

/** 压平空白并截断 body，供纪要/预览单行展示 */
function clipBody(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

function contextPath(team: string): string {
  return path.join(CONTEXT_DIR, `${team}.context.md`)
}

function atomicWriteContext(filePath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    log.warn(`共享上下文写入失败 ${filePath}`, err)
  }
}

/** 渲染项目房间最近 N 条消息为共享上下文纪要（有损：body 截断） */
function renderContext(room: RoomInfo, msgs: projectDb.ProjectMessageRow[]): string {
  const lines = [
    `# 项目「${room.name}」共享上下文`,
    '',
    `> 由 areco 自动维护：项目房间最近 ${msgs.length} 条消息纪要。被投递/@ 时附此文件路径，`,
    `> 让接手的 agent 一进来就看到来龙去脉，不必从零问起（项目 = 共享上下文空间）。`,
    `> 细节以 data/projects.db 为准；本文件每次有新消息自动刷新。`,
    '',
  ]
  for (const m of msgs) {
    const when = m.createdAt.replace('T', ' ').replace(/(\d{2}:\d{2}):\d{2}Z$/, '$1Z')
    lines.push(`## ${when}　${m.from} → ${m.to}`)
    lines.push(clipBody(m.body, CONTEXT_BODY_CLIP))
    lines.push('')
  }
  return lines.join('\n')
}

/** 投递 note 用的近况预览：取最近若干条（排除当条），压成「A：… / B：…」一句话 */
function buildContextPreview(team: string, currentId?: number): { path: string; preview: string } {
  const recent = projectDb.history(team, CONTEXT_PREVIEW_N + 5).filter((m) => m.id !== currentId)
  const preview = recent
    .slice(0, CONTEXT_PREVIEW_N)
    .map((m) => `${m.from}：${clipBody(m.body, 50)}`)
    .join(' / ')
  return { path: contextPath(team), preview: preview || '（尚无历史）' }
}

export interface RoomRelayOpts {
  /** serial 当前放行成员的回复超时毫秒数（默认 DELIVERY_TIMEOUT_MS=10 分钟；测试传小值） */
  deliveryTimeoutMs?: number
  /** claim 报认领窗口毫秒数（默认 CLAIM_DEADLINE_MS=5 分钟；测试传小值） */
  claimDeadlineMs?: number
  /** 允许「转述维护者原话」的 agent 白名单（如微信通道 Hermes）。名单内 agent 带
   *  human_relay 标记的消息按人类语义处理：清零链深 + 无 @ 默认投全体；名单外打标无效。
   *  默认空 = 功能关闭。署名不变（仍是 agent 自己），防环闸与身份闸都不破。 */
  humanRelayAgents?: string[]
}

export class RoomRelay {
  /** 项目 → 已见最大消息 id；未见过的项目首轮：启动前存量快进、启动后新帖照投（详见 tick） */
  private cursors = new Map<string, number>()
  /** 中继启动时刻：tick 初见房间时区分「启动前的历史」（快进不补投）与「启动后的新帖」（照投） */
  private startedAtMs = 0
  /** 项目 → 当前 agent 互调链路深度（人发言清零；内存态，重启归零） */
  private chainDepth = new Map<string, number>()
  /** auto-recall 注入块缓存：root message id → 注入块（null=无命中/失败）。同一根消息投多个成员复用，不重复起子进程 */
  private recallMemo = new Map<number, string | null>()
  /** 注入后待捕获 agent 回复：sessionId → 锚点（注入前消息数 + 来源）。agent 主动回执或自动捕获后清除 */
  private pendingCapture = new Map<
    string,
    { team: string; roomName: string; roomId: string; memberName: string; fromName: string; beforeCount: number; injectedAt: number }
  >()
  private timer: NodeJS.Timeout | null = null
  private readonly deliveryTimeoutMs: number
  private readonly claimDeadlineMs: number
  private readonly humanRelayAgents: string[]

  constructor(
    private rooms: RoomStore,
    private manager: SessionManager,
    private broadcast: (msg: ServerMsg) => void,
    opts: RoomRelayOpts = {}
  ) {
    this.deliveryTimeoutMs = opts.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS
    this.claimDeadlineMs = opts.claimDeadlineMs ?? CLAIM_DEADLINE_MS
    this.humanRelayAgents = opts.humanRelayAgents ?? []
  }

  start() {
    if (this.timer) return
    this.startedAtMs = Date.now()
    // 会话被删除时联动移除项目里指向它的 member，否则悬空 member 发消息静默失效（首次 start 挂一次）
    this.manager.on('removed', (sessionId) => this.onSessionRemoved(sessionId))
    this.timer = setInterval(() => {
      this.tick()
      this.captureTick()
    }, POLL_MS)
    log.info(`项目中继已启动（${POLL_MS}ms 轮询，${this.rooms.list().length} 个项目）`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 会话被删除：联动移除所有项目里指向它的 member（避免悬空 member 发消息静默失效），
   *  并对其作为 implementer 的工作区做兜底提交（WIP 不丢） */
  private onSessionRemoved(sessionId: string) {
    let changed = false
    const victims: { room: RoomInfo; member: RoomMember }[] = []
    for (const room of this.rooms.list()) {
      if (room.archivedAt !== null) continue // 归档项目保留成员快照，不随会话删除而改写
      const victim = room.members.find((m) => m.kind === 'session' && m.sessionId === sessionId)
      if (!victim) continue
      victims.push({ room, member: victim })
      try {
        this.rooms.removeMember(room.id, victim.name)
        log.info(`会话 ${sessionId.slice(0, 8)} 被删，联动移除项目「${room.name}」成员 ${victim.name}`)
        changed = true
      } catch (err) {
        log.warn(`联动移除成员失败 项目「${room.name}」`, err)
      }
    }
    for (const { room, member } of victims) this.wipCommitOnExit(room, member.name)
    if (changed) this.broadcastRooms()
  }

  /**
   * 会话退出兜底提交（认领制阶段三）：查该成员作为 implementer 的 active dispatch，
   * 其 areco 自建工作区（以 dispatch.worktree_path 为准，绝不碰用户主检出）有未提交改动则
   * add -A + commit。失败只记日志——会话删除流程不能被 git 问题炸断。
   */
  private wipCommitOnExit(room: RoomInfo, memberName: string): void {
    let dispatches: projectDb.DispatchRow[]
    try {
      dispatches = projectDb.activeDispatchesOfImplementer(memberName)
    } catch (err) {
      log.warn(`兜底提交查询失败 ${memberName}`, err)
      return
    }
    for (const d of dispatches) {
      if (!d.worktreePath) continue
      try {
        const committed = wipCommit(d.worktreePath, `wip: 会话退出兜底提交 (dispatch #${d.id})`)
        if (committed) log.info(`项目「${room.name}」成员 ${memberName} 退出，工作区 ${d.worktreePath} 已兜底提交（dispatch #${d.id}）`)
      } catch (err) {
        log.warn(`兜底提交失败 ${d.worktreePath}（dispatch #${d.id}）`, err)
      }
    }
  }

  /** 房间列表注入最近消息时间（副本，不污染 rooms.json 落盘对象） */
  roomsWithActivity(): RoomInfo[] {
    let ats: Record<string, string> = {}
    try {
      ats = projectDb.lastMessageAts()
    } catch (err) {
      log.warn('房间最近消息时间读取失败，按无处理', err)
    }
    return this.rooms.list().map((r) => ({ ...r, lastMessageAt: ats[r.team] ?? null }))
  }

  broadcastRooms() {
    this.broadcast({ type: 'rooms', rooms: this.roomsWithActivity() })
  }

  /** 刷新项目共享上下文纪要文件（每次有新消息调用；幂等原子写） */
  private refreshContext(room: RoomInfo): void {
    try {
      const msgs = projectDb.history(room.team, CONTEXT_MAX_MESSAGES)
      atomicWriteContext(contextPath(room.team), renderContext(room, msgs))
    } catch (err) {
      log.warn(`共享上下文刷新失败 项目「${room.name}」`, err)
    }
  }

  private toRoomMessage(room: RoomInfo, m: projectDb.ProjectMessageRow): RoomMessage {
    return { id: m.id, roomId: room.id, from: m.from, to: m.to, body: m.body, createdAt: m.createdAt, humanRelay: m.humanRelay }
  }

  private tick() {
    for (const room of this.rooms.list()) {
      let msgs: projectDb.ProjectMessageRow[]
      try {
        msgs = projectDb.history(room.team, 50)
        // 窗口溢出兜底：一个轮询周期新增超 50 条时，尾批盖不住游标，窗口外消息会被静默跳过。
        // history 无分页参数，逐步放大 limit 直到窗口含游标（或库内已无更早消息），
        // 保证 id>cursor 的消息不丢；上限 6400 防异常刷库时一次性全量拉出。
        const cursor = this.cursors.get(room.id)
        let limit = 50
        while (cursor !== undefined && msgs.length === limit && msgs[0].id > cursor && limit < 6400) {
          limit *= 2
          msgs = projectDb.history(room.team, limit)
        }
        if (msgs.length === limit && msgs[0] && cursor !== undefined && msgs[0].id > cursor) {
          log.warn(`轮询 ${room.team} 积压超过 ${limit} 条，最早 ${msgs[0].id - cursor - 1} 条已超出窗口跳过`)
        }
      } catch (err) {
        log.warn(`轮询 ${room.team} 失败`, err)
        continue
      }
      // 归档期间外部 areco-msg 仍可能直写 projects.db：推进游标但不广播、不投递，
      // 防止恢复项目后把归档期消息一次性补投给 agent。
      if (room.archivedAt !== null) {
        this.cursors.set(room.id, msgs.length ? msgs[msgs.length - 1].id : 0)
        continue
      }
      const cursor = this.cursors.get(room.id)
      if (cursor === undefined) {
        // 初见房间（含重启后首轮）：中继启动前的存量快进不补投（防重启重放轰炸），
        // 启动后到达的照投——建房即发首条的竞态不再被吞（2026-07-24 会诊房间丢首条实锤）。
        // createdAt 是秒级 ISO，留 3s 容差
        const freshAfter = this.startedAtMs - 3000
        let ff = 0
        for (const m of msgs) if (Date.parse(m.createdAt) < freshAfter) ff = m.id
        this.cursors.set(room.id, msgs.length ? msgs[msgs.length - 1].id : 0)
        for (const m of msgs) {
          if (m.id <= ff) continue
          this.broadcast({ type: 'roomMessage', roomId: room.id, message: this.toRoomMessage(room, m) })
          this.onMessageStored(room, m)
        }
        continue
      }
      let hadNew = false
      for (const m of msgs) {
        if (m.id <= cursor) continue
        this.cursors.set(room.id, m.id)
        hadNew = true
        this.broadcast({ type: 'roomMessage', roomId: room.id, message: this.toRoomMessage(room, m) })
        this.onMessageStored(room, m)
      }
      if (hadNew) this.refreshContext(room) // 外部（areco-msg.mjs 回执等）进来的消息：批量后刷新一次
      this.sweepTimeouts(room) // 每 2s 轮询顺带扫 serial 超时：当前放行位超 deadline 未回复 → 放下一位
    }
  }

  /** 页面发消息：落库（游标同步推进，避免轮询二次广播）+ 立即广播 + 投递 */
  postMessage(roomId: string, from: string, body: string, opts?: { humanRelay?: boolean }): RoomMessage {
    const room = this.rooms.get(roomId)
    if (room.archivedAt !== null) throw new Error(`项目「${room.name}」已归档，只能查看或恢复`)
    const text = body.trim()
    if (!text) throw new Error('消息不能为空')
    const { targets, all } = parseMentions(text, room.members)
    const to = all ? ALL_MENTION : (targets[0] ?? (from === this.rooms.humanName ? ALL_MENTION : this.rooms.humanName))
    const stored = projectDb.send(room.team, from, to, text, { humanRelay: opts?.humanRelay })
    this.cursors.set(room.id, Math.max(this.cursors.get(room.id) ?? 0, stored.id))
    const message = this.toRoomMessage(room, stored)
    this.broadcast({ type: 'roomMessage', roomId: room.id, message })
    this.onMessageStored(room, stored)
    this.refreshContext(room) // 页面发言：纪要文件常驻刷新（含当条）
    return message
  }

  /** 消息落库后的统一后处理（tick 轮询 / postMessage / captureTick 三路径共用）：
   *  1) mention 投递（parallel=现状全员即注；serial=只放行当前轮到的成员；claim=全员发「先报认领」）；
   *  2) claim 认领：本条 from 报 [claim] → 原子批准唯一 Implementer（与 serial 轮转互斥，见 handleClaim）；
   *  3) 串行推进：本条 from 命中 active serial dispatch 的 current_target → 当前 delivery 落定、放下一位。 */
  private onMessageStored(room: RoomInfo, m: { id: number; from: string; body: string; to?: string; humanRelay?: boolean }) {
    this.deliverMentions(room, m.from, m.body, m.id, m.humanRelay ?? false, m.to)
    this.handleClaim(room, m)
    this.advanceSerial(room, m.from)
  }

  /**
   * 投递 @mention/广播到目标会话终端。
   *  - 人类发言默认投全体（不必每次手打 @all，维护者 2026-07-20 定）；agent 发言仍需显式 @，防互调失控。
   *  - 人→agent 投递附「共享上下文文件路径 + 最近若干条预览」，agent 进来不再失忆；agent→agent 不附，防膨胀。
   *  - 防环：人发言清零链路深度；agent 互调深度 ≥MAX_DEPTH 时只落库不投递。
   *  - 调度底账（2026-07-22）：message_targets 落真实收件人（广播展开成成员名），
   *    幂等建 dispatch + deliveries；parallel 全员即注（现状），serial 只放行成员顺序第一位。
   */
  private deliverMentions(room: RoomInfo, from: string, body: string, currentId: number, humanRelay = false, toField?: string) {
    if (room.archivedAt !== null) return
    const parsed = parseMentions(body, room.members)
    let { targets, all } = parsed
    // 外部通道（areco-msg CLI 直写 projects.db）的收件人记在 to_agent 列、正文不一定带 @：
    // 正文无 @ 时按列投递，不再静默吞（2026-07-24 会诊房间连吞两条任务书实锤）
    if (!targets.length && !all && toField) {
      if (toField === ALL_MENTION) all = true
      else if (room.members.some((m) => m.kind === 'session' && m.name === toField)) targets = [toField]
    }
    // 转述闸：只有白名单 agent（如微信通道 Hermes 转维护者原话）的 human_relay 标记生效；
    // 名单外打标一律忽略——否则任何 agent 都能自我清零链深，防环闸形同虚设
    const relayAsHuman = humanRelay && this.humanRelayAgents.includes(from)
    if (humanRelay && !relayAsHuman) {
      log.warn(`项目「${room.name}」消息带 human_relay 标记但发送者 ${from} 不在转述白名单，按 agent 处理`)
    }
    // 发送者身份：人类只认花名册 humanName 精确等值；查不到成员时**默认 session 而非 human**。
    // 否则 agent 回执名字与花名册字符串不一致（带空格/全角括号的成员名极易漂移：全角"（）"vs 半角、
    // 多空格等）会被误判为人类发言 → 默认广播全体 + 清零 chainDepth + 投递过滤 m.name!==from 失效
    // （from 不在 members）→ agent 收到自己刚发的消息 → 再回执 → 死循环。chainDepth 防环闸因每次走
    // human 分支清零而永不触发。2026-07-20 修。
    const senderMember = room.members.find((m) => m.name === from)
    const senderKind = from === this.rooms.humanName || relayAsHuman
      ? 'human'
      : (senderMember?.kind ?? 'session')
    // 人类发言默认广播全体；agent 发言需显式 @（all 或具体成员）才投递
    const broadcastAll = all || (senderKind === 'human' && targets.length === 0)
    if (!targets.length && !broadcastAll) return

    let depthBlocked = false
    if (senderKind === 'human') {
      this.chainDepth.set(room.id, 0)
    } else if (senderMember) {
      // 只计房内成员互调的链深：外部终端/编排者（from 不在花名册）代发不增不清——
      // 连续委派不同成员不是互调循环（2026-07-24 会诊房间第 4 条任务书被 MAX_DEPTH 误拦实锤）
      const depth = (this.chainDepth.get(room.id) ?? 0) + 1
      this.chainDepth.set(room.id, depth)
      depthBlocked = depth >= MAX_DEPTH
    }
    const members = room.members.filter(
      (m) => m.kind === 'session' && m.name !== from && (broadcastAll || targets.includes(m.name))
    )
    if (!members.length) return

    // 调度底账：真实收件人 + 幂等 dispatch/deliveries。记账失败不阻断投递（消息本身已落库已广播）。
    let dispatch: projectDb.DispatchRow | null = null
    let deliveries: projectDb.DeliveryRow[] = []
    try {
      projectDb.recordMessageTargets(currentId, members.map((m) => m.name))
      dispatch = projectDb.createDispatch(room.team, currentId, room.dispatchMode, MAX_DEPTH).dispatch
      deliveries = projectDb.addDeliveries(
        dispatch.id,
        members.map((m) => ({ name: m.name, sessionId: m.sessionId }))
      )
    } catch (err) {
      log.warn(`项目「${room.name}」调度记账失败，按现状并行投递继续`, err)
      dispatch = null
      deliveries = []
    }

    // 防环闸拦下：只落库不投递，对应 deliveries 记 failed 留痕
    if (depthBlocked) {
      log.info(`项目「${room.name}」agent 互调深度达 ${MAX_DEPTH}，本条只落库不投递`)
      for (const d of deliveries) {
        if (d.status === 'queued') this.tryUpdateDelivery(d.id, { status: 'failed' })
      }
      if (dispatch) this.broadcastDispatches(room)
      return
    }

    // serial：只放行成员顺序第一位（current_target），其余 queued——全体收到 ≠ 全体同时实施。
    // 幂等重入（同一根消息重复处理）时已有放行位则不再注入。
    if (dispatch && room.dispatchMode === 'serial') {
      const busy = deliveries.some((d) => d.status === 'injected' || d.status === 'working')
      if (!busy) this.serialAdvanceNext(room, dispatch.id)
      this.broadcastDispatches(room)
      return
    }

    // claim 认领制：全员收到第一阶段「先报认领、禁止改码」，等 [claim] 回复后原子批准唯一 Implementer。
    // 与 serial 互斥：claim 单不进 activeSerialDispatches（mode 过滤），serial 的轮转/超时都不碰它。
    if (dispatch && room.dispatchMode === 'claim') {
      this.deliverClaimPhaseOne(room, dispatch, deliveries)
      this.broadcastDispatches(room)
      return
    }

    // parallel：现状 for-loop 全员即注；deliveries 同步记 injected/failed
    const flat = body.replace(/\s*\r?\n\s*/g, '；')
    for (const m of members) {
      const nonce = this.injectToMember(room, m, from, flat, senderKind, currentId)
      const del = deliveries.find((d) => d.memberName === m.name)
      if (del && del.status === 'queued') {
        this.tryUpdateDelivery(
          del.id,
          nonce
            ? { status: 'injected', attempt: del.attempt + 1, correlationId: nonce }
            : { status: 'failed', attempt: del.attempt + 1 }
        )
      }
    }
    if (dispatch) this.broadcastDispatches(room)
  }

  /** delivery 落账失败只记日志（投递本身已完成，账务不能反过来炸投递链路） */
  private tryUpdateDelivery(id: number, patch: Parameters<typeof projectDb.updateDelivery>[1]) {
    try {
      projectDb.updateDelivery(id, patch)
    } catch (err) {
      log.warn('delivery 状态更新失败', err)
    }
  }

  /**
   * 向单个成员会话注入 note（离线自动 resume 拉起再投）。返回注入 nonce（回显标记，作 delivery.correlation_id）；
   * 失败返回 null：会话已从 Map 摘除（无恢复凭据）、自动 resume 失败、或注入抛错。
   * directive：附加的调度指令（认领制第一/二阶段说明等），原样拼进 note，不改主文案结构。
   */
  private injectToMember(
    room: RoomInfo,
    m: RoomMember,
    from: string,
    flat: string,
    senderKind: 'human' | 'session',
    currentId: number,
    directive?: string
  ): string | null {
    const running = new Map(this.manager.list().map((s) => [s.id, s]))
    const session = m.sessionId ? running.get(m.sessionId) : undefined
    // 离线成员：自动 resume 拉起再投递（2026-07-20 维护者需求：项目成员退出后发消息自动恢复对话）
    // exited 的 session 实体仍在 Map、恢复凭据齐全；restart(id,true) 复用原对象、id 不变、续原生上下文
    if (!session) return null // 已从 Map 摘除（被删）→ 无恢复凭据，跳过
    if (session.status !== 'running') {
      try {
        this.manager.restart(session.id, true) // 同步起进程、status→running；后续 onceQuiet 等首屏画完再注入
        log.info(`项目「${room.name}」成员 ${m.name} 离线，自动 resume 拉起后投递`)
      } catch (err) {
        log.warn(`项目「${room.name}」自动恢复 ${m.name} 失败，跳过`, err)
        return null
      }
    }
    try {
      // 共享上下文：仅人→agent 带预览（agent→agent 不带，避免链路膨胀）。
      // buildContextPreview 走 projectDb.history，db 故障时异常会一路抛到 setInterval 回调
      // 崩进程（postMessage 路径下消息已落库已广播却给用户返回失败）——单条投递失败记日志跳过，
      // 不影响其他投递与游标推进。
      const ctx = senderKind === 'human' ? buildContextPreview(room.team, currentId) : null
      const recall = this.recallBlock(currentId, from, flat, senderKind)
      const replyCmd = `node ${shellQuote(MSG_CLI)} ${room.team} ${shellQuote(m.name)} ${shellQuote(from)} '<你的回复>'`
      const note =
        `[项目·${room.name}] ${from}: ${flat}` +
        (directive ? `（${directive}）` : '') +
        (ctx ? `（共享上下文 ${ctx.path}；最近：${ctx.preview}）` : '') +
        (recall ? `\n${recall}\n` : '') +
        `（⚠️你在终端里的回复${this.rooms.humanName}在项目里看不到，必须执行下面命令把回复发回项目，否则等于没回：${replyCmd}）`
      const nonce = this.injectNote(session.id, note, (sess) => {
        const beforeCount = this.sessionMessageCount(sess) // 注入前消息数（note 尚未落盘）
        // 标记待捕获：agent 若不主动回执，captureTick 取其回复代为回执到项目
        this.pendingCapture.set(session.id, {
          team: room.team,
          roomName: room.name,
          roomId: room.id,
          memberName: m.name,
          fromName: from,
          beforeCount,
          injectedAt: Date.now(),
        })
      })
      log.info(`项目「${room.name}」投递 ${from} → ${m.name}`)
      return nonce
    } catch (err) {
      log.warn(`投递失败 ${room.name} → ${m.name}`, err)
      return null
    }
  }

  /**
   * auto-recall 注入块：人发的一律跑；session 发的仅命中委派格式特征（或 from='areco-调度' 的调度指令）才跑。
   * 按 rootMessageId 缓存——同一根消息投多个成员只起一次 python 子进程。无命中/任何失败返回 null（不注入）。
   */
  private recallBlock(rootMessageId: number, from: string, flat: string, senderKind: 'human' | 'session'): string | null {
    if (senderKind !== 'human' && from !== 'areco-调度' && !DELEGATION_RE.test(flat)) return null
    const cached = this.recallMemo.get(rootMessageId)
    if (cached !== undefined) return cached
    const block = this.runRecall(this.recallQuery(flat))
    if (this.recallMemo.size >= RECALL_MEMO_MAX) this.recallMemo.clear()
    this.recallMemo.set(rootMessageId, block)
    return block
  }

  /** recall query 构造：正文含「相关记忆：xxx」/「recall：xxx」引导的取其内容；否则去信封前缀后截前 120 字 */
  private recallQuery(flat: string): string {
    const guided = flat.match(/(?:相关记忆|recall)\s*[:：]\s*([^；\n]+)/i)
    if (guided) return guided[1].trim().slice(0, RECALL_QUERY_CLIP)
    return flat.replace(/^\[[^\]]*\]\s*/, '').slice(0, RECALL_QUERY_CLIP)
  }

  /** 同步跑 recall.py（3s 超时）：非零退出/超时/JSON 解析失败/db 锁等任何失败静默返回 null，绝不阻塞投递 */
  private runRecall(query: string): string | null {
    if (!RECALL_SCRIPT) return null
    try {
      const out = recallRunner.fn('python3', [RECALL_SCRIPT, '--json', '--topk', String(RECALL_TOPK), query], {
        encoding: 'utf-8',
        timeout: RECALL_TIMEOUT_MS,
      })
      if (out.error || out.status !== 0 || !out.stdout) return null
      const hits = JSON.parse(out.stdout) as { id: string; kind: string; claim: string; source: string }[]
      if (!Array.isArray(hits) || hits.length === 0) return null
      const lines = hits.map((h) => `- ${clipBody(h.claim ?? '', RECALL_CLAIM_CLIP)}`)
      return `【auto-recall 命中 ${hits.length}：${hits.map((h) => h.id).join(', ')}】\n${lines.join('\n')}`
    } catch {
      return null
    }
  }

  /**
   * serial 放行下一位：取该 dispatch 第一条 queued delivery 注入（note 内容回取根消息），
   * 成功则置 injected + current_target/deadline；注入失败记 failed 顺延；无可放行的则 dispatch done。
   */
  private serialAdvanceNext(room: RoomInfo, dispatchId: number): void {
    try {
      const d = projectDb.dispatchById(dispatchId)
      if (!d || d.state !== 'active') return
      const root = projectDb.messageById(d.rootMessageId)
      if (!root) {
        // 根消息缺失（消息不会被删，理论兜底）：无法构造 note，剩余 queued 记 failed、收单
        for (const del of projectDb.deliveriesOf(dispatchId)) {
          if (del.status === 'queued') projectDb.updateDelivery(del.id, { status: 'failed' })
        }
        projectDb.setDispatchState(dispatchId, { state: 'done', currentTarget: null, deadline: null })
        return
      }
      const flat = root.body.replace(/\s*\r?\n\s*/g, '；')
      const senderKind = root.from === this.rooms.humanName ? 'human' : 'session'
      for (const del of projectDb.deliveriesOf(dispatchId)) {
        if (del.status !== 'queued') continue
        const member = room.members.find((m) => m.kind === 'session' && m.name === del.memberName)
        const nonce = member ? this.injectToMember(room, member, root.from, flat, senderKind, root.id) : null
        if (nonce) {
          projectDb.updateDelivery(del.id, { status: 'injected', attempt: del.attempt + 1, correlationId: nonce })
          projectDb.setDispatchState(dispatchId, {
            currentTarget: del.memberName,
            deadline: new Date(Date.now() + this.deliveryTimeoutMs).toISOString(),
          })
          log.info(`项目「${room.name}」串行放行 ${del.memberName}（dispatch #${dispatchId}）`)
          return
        }
        projectDb.updateDelivery(del.id, { status: 'failed', attempt: del.attempt + 1 })
      }
      projectDb.setDispatchState(dispatchId, { state: 'done', currentTarget: null, deadline: null })
    } catch (err) {
      log.warn(`串行放行失败 项目「${room.name}」 dispatch #${dispatchId}`, err)
    }
  }

  /** 串行推进检查：本条消息 from 命中房间内 active serial dispatch 的 current_target
   *  （且 from 是 session 成员、非 humanName）→ 当前 delivery 置 done，放行下一位。 */
  private advanceSerial(room: RoomInfo, from: string): void {
    if (room.archivedAt !== null) return // 归档房间：调度扫描/推进整体跳过（对齐归档不投递语义）
    if (from === this.rooms.humanName) return
    const member = room.members.find((m) => m.name === from)
    if (!member || member.kind !== 'session') return
    let d: projectDb.DispatchRow | undefined
    try {
      d = projectDb.activeSerialDispatches(room.team).find((x) => x.currentTarget === from)
    } catch (err) {
      log.warn(`串行推进查询失败 项目「${room.name}」`, err)
      return
    }
    if (!d) return
    try {
      // 回复落定：'replied'→'done' 合并落终态 done（中间态无可观测消费者）
      const cur = projectDb
        .deliveriesOf(d.id)
        .find((x) => x.memberName === from && (x.status === 'injected' || x.status === 'working'))
      if (cur) projectDb.updateDelivery(cur.id, { status: 'done' })
    } catch (err) {
      log.warn(`串行推进落定失败 项目「${room.name}」`, err)
      return
    }
    this.serialAdvanceNext(room, d.id)
    this.broadcastDispatches(room)
  }

  // ---- claim 认领制（与 serial 轮转互斥：claim 单 mode='claim'，serial 的查询/推进/超时都只看 mode='serial'）----

  /**
   * claim 第一阶段：给每个目标成员注入「先报认领、禁止改码」note。
   * 幂等：phase 只在首次置 claiming + 认领截止；delivery 仍 queued 的才注入（重入不重复打扰）。
   */
  private deliverClaimPhaseOne(room: RoomInfo, dispatch: projectDb.DispatchRow, deliveries: projectDb.DeliveryRow[]): void {
    try {
      if (!dispatch.phase) {
        projectDb.setDispatchState(dispatch.id, {
          phase: 'claiming',
          claimDeadline: new Date(Date.now() + this.claimDeadlineMs).toISOString(),
        })
      }
      const root = projectDb.messageById(dispatch.rootMessageId)
      if (!root) return
      const flat = root.body.replace(/\s*\r?\n\s*/g, '；')
      const senderKind = root.from === this.rooms.humanName ? 'human' : 'session'
      for (const del of deliveries) {
        if (del.status !== 'queued') continue
        const member = room.members.find((m) => m.kind === 'session' && m.name === del.memberName)
        const nonce = member
          ? this.injectToMember(
              room,
              member,
              root.from,
              flat,
              senderKind,
              root.id,
              '认领制任务·第一阶段：先报认领——回复以 [claim] 开头说明认领范围；未获批准前禁止改任何代码'
            )
          : null
        this.tryUpdateDelivery(
          del.id,
          nonce
            ? { status: 'injected', attempt: del.attempt + 1, correlationId: nonce }
            : { status: 'failed', attempt: del.attempt + 1 }
        )
      }
    } catch (err) {
      log.warn(`claim 第一阶段投递失败 项目「${room.name}」 dispatch #${dispatch.id}`, err)
    }
  }

  /**
   * 认领处理：成员消息 body 以 [claim] 开头（大小写不敏感）且房内有 claiming 中的 active dispatch
   * → 认最早那单（先建的任务先被认领，语义最直白），原子 UPDATE 按 affected rows 判输赢，先到先得。
   * 赢家放行第二阶段；迟到者只收轻量 note，不在房间自动发消息（防环）。重复 [claim] 天然幂等：
   * 赢家再发 [claim] 时 implementer 已非 NULL，tryClaimDispatch 返回失败 → 走迟到分支再收一条 reviewer note。
   */
  private handleClaim(room: RoomInfo, m: { id: number; from: string; body: string }): void {
    if (room.archivedAt !== null) return
    if (!/^\s*\[claim\]/i.test(m.body)) return
    if (m.from === this.rooms.humanName) return
    const member = room.members.find((x) => x.kind === 'session' && x.name === m.from)
    if (!member) return
    let claiming: projectDb.DispatchRow[]
    try {
      claiming = projectDb.activeClaimingDispatches(room.team)
    } catch (err) {
      log.warn(`认领查询失败 项目「${room.name}」`, err)
      return
    }
    // 只认在该单 deliveries 里的成员（显式 @ 指派时，没被投到的人不能抢单）
    const target = claiming.find((d) => projectDb.deliveriesOf(d.id).some((del) => del.memberName === m.from))
    if (!target) {
      // 迟到认领：claiming 单已没有，但房内有已被别人认领的实施中单 → 只给迟到者补一条 reviewer note
      // （赢家自己重复发 [claim] 不算迟到，直接忽略，避免重放第二阶段 note）
      try {
        const held = projectDb
          .listDispatches(room.team, 10)
          .find(
            (d) =>
              d.mode === 'claim' &&
              d.state === 'active' &&
              d.phase === 'implementing' &&
              d.implementer !== m.from &&
              d.deliveries.some((del) => del.memberName === m.from)
          )
        if (held) this.claimLate(room, held, member)
      } catch (err) {
        log.warn(`迟到认领检查失败 项目「${room.name}」`, err)
      }
      return
    }
    let won = false
    try {
      won = projectDb.tryClaimDispatch(target.id, m.from)
    } catch (err) {
      log.warn(`原子认领失败 项目「${room.name}」 dispatch #${target.id}`, err)
      return
    }
    if (won) this.claimWon(room, target, member)
    else this.claimLate(room, target, member)
    this.broadcastDispatches(room)
  }

  /** 认领赢家：delivery 置 working，绑了 repo 则幂等开工作区，注入第二阶段「可动手」note；输家降 reviewer */
  private claimWon(room: RoomInfo, dispatch: projectDb.DispatchRow, winner: RoomMember): void {
    const deliveries = projectDb.deliveriesOf(dispatch.id)
    const winDel = deliveries.find((d) => d.memberName === winner.name)
    if (winDel) this.tryUpdateDelivery(winDel.id, { status: 'working' })
    log.info(`项目「${room.name}」成员 ${winner.name} 认领成功（dispatch #${dispatch.id}）`)

    // 第二阶段 note：可动手 + 绑 repo 时自动开工作区（失败不阻断放行，note 里如实说明）
    let directive = '认领制任务·第二阶段：已批准你为 Implementer，可动手实施。'
    if (room.repoPath) {
      try {
        const root = projectDb.messageById(dispatch.rootMessageId)
        // 工作区/分支命名：slug 取根消息摘要净化（中文净化后为空则兜底 d<dispatchId>）；
        // 分支前缀 areco/，成员名净化为空兜底 m<deliveryId>
        let slug = slugify(clipBody(root?.body ?? '', 60), `d${dispatch.id}`)
        let dir = worktreeDirFor(room.repoPath, slug)
        let branch = `areco/${slugify(winner.name, `m${winDel?.id ?? 0}`)}-${slug}`
        // 撞车兜底：目录已存在且不是本单上次建的（别的 dispatch 摘要前缀恰好相同，或本单上次
        // 建了一半没来得及记档）→ slug 追加单号区分；本单已成功建过的重入则 dispatch.branch 相等直接复用
        if (fs.existsSync(dir) && dispatch.branch !== branch) {
          slug = `${slug}-d${dispatch.id}`
          dir = worktreeDirFor(room.repoPath, slug)
          branch = `areco/${slugify(winner.name, `m${winDel?.id ?? 0}`)}-${slug}`
        }
        ensureWorktree(room.repoPath, dir, branch) // 幂等：同 dispatch 重复触发复用既有目录/分支
        projectDb.setDispatchState(dispatch.id, { worktreePath: dir, branch })
        directive +=
          `工作区：${dir}（分支 ${branch}）。纪律：① 只在自己工作区里改，不碰主检出；` +
          `② WIP 随手 commit 进自己分支；③ 不执行合并，等${this.rooms.humanName}统一收口。`
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`项目「${room.name}」工作区创建失败（dispatch #${dispatch.id}）`, err)
        directive += `（⚠️工作区创建失败：${reason}。仍已批准你为 Implementer，请先回报${this.rooms.humanName}再动手。）`
      }
    }
    this.injectToMember(room, winner, 'areco-调度', directive, 'session', dispatch.rootMessageId)

    // 输家：delivery 落定 done，轻量 note 降为 reviewer（不在房间发消息，防环）
    for (const del of deliveries) {
      if (del.memberName === winner.name) continue
      if (del.status !== 'queued' && del.status !== 'injected') continue
      this.tryUpdateDelivery(del.id, { status: 'done' })
      const loser = room.members.find((m) => m.kind === 'session' && m.name === del.memberName)
      if (loser) {
        this.injectToMember(
          room,
          loser,
          'areco-调度',
          `${winner.name} 已认领该任务（dispatch #${dispatch.id}），你转为 reviewer：不要改码，等评审。`,
          'session',
          dispatch.rootMessageId
        )
      }
    }
  }

  /** 迟到认领（已有人赢）：不改任何状态，只给迟到者注入 reviewer note（同样不在房间发消息） */
  private claimLate(room: RoomInfo, dispatch: projectDb.DispatchRow, member: RoomMember): void {
    const current = projectDb.dispatchById(dispatch.id)
    const holder = current?.implementer ?? '他人'
    log.info(`项目「${room.name}」成员 ${member.name} 认领迟到，${holder} 已持有（dispatch #${dispatch.id}）`)
    this.injectToMember(
      room,
      member,
      'areco-调度',
      `认领已被 ${holder} 获得（dispatch #${dispatch.id}），你转为 reviewer：不要改码，等评审。`,
      'session',
      dispatch.rootMessageId
    )
  }

  /** serial 超时扫描（tick 每 2s 顺带做）：当前放行位超 deadline 未回复 → 置 timeout，放下一位 */
  private sweepTimeouts(room: RoomInfo): void {    if (room.archivedAt !== null) return
    let actives: projectDb.DispatchRow[]
    try {
      actives = projectDb.activeSerialDispatches(room.team)
    } catch (err) {
      log.warn(`串行超时扫描失败 项目「${room.name}」`, err)
      return
    }
    const now = Date.now()
    let changed = false
    for (const d of actives) {
      if (!d.deadline || !d.currentTarget) continue
      if (Date.parse(d.deadline) > now) continue
      try {
        const cur = projectDb
          .deliveriesOf(d.id)
          .find((x) => x.memberName === d.currentTarget && (x.status === 'injected' || x.status === 'working'))
        if (cur) projectDb.updateDelivery(cur.id, { status: 'timeout' })
        log.info(`项目「${room.name}」成员 ${d.currentTarget} 回复超时，串行放下一位（dispatch #${d.id}）`)
      } catch (err) {
        log.warn(`串行超时落定失败 项目「${room.name}」`, err)
        continue
      }
      this.serialAdvanceNext(room, d.id)
      changed = true
    }
    // claim 认领超时：claiming 超 claim_deadline 无人认领 → 收单 done，原因留痕，不自动重投
    let claimings: projectDb.DispatchRow[] = []
    try {
      claimings = projectDb.activeClaimingDispatches(room.team)
    } catch (err) {
      log.warn(`认领超时扫描失败 项目「${room.name}」`, err)
    }
    for (const d of claimings) {
      if (!d.claimDeadline || Date.parse(d.claimDeadline) > now) continue
      try {
        projectDb.setDispatchState(d.id, { state: 'done', phase: 'done', cancelReason: '无人认领超时' })
        for (const del of projectDb.deliveriesOf(d.id)) {
          if (del.status === 'queued' || del.status === 'injected') projectDb.updateDelivery(del.id, { status: 'done' })
        }
        log.info(`项目「${room.name}」dispatch #${d.id} 认领超时，收单`)
        changed = true
      } catch (err) {
        log.warn(`认领超时收单失败 项目「${room.name}」 dispatch #${d.id}`, err)
      }
    }
    if (changed) this.broadcastDispatches(room)
  }

  /** 取消 dispatch（HTTP API 入口）：active→cancelled，剩余 queued 全置 cancelled，记 cancel_reason。幂等。 */
  cancelDispatch(roomId: string, dispatchId: number, reason?: string): void {
    const room = this.rooms.get(roomId)
    const d = projectDb.dispatchById(dispatchId)
    if (!d || d.team !== room.team) throw new Error(`调度 ${dispatchId} 不存在`)
    if (d.state !== 'active') return
    projectDb.setDispatchState(dispatchId, {
      state: 'cancelled',
      cancelReason: reason?.trim() || null,
      currentTarget: null,
      deadline: null,
    })
    for (const del of projectDb.deliveriesOf(dispatchId)) {
      if (del.status === 'queued') projectDb.updateDelivery(del.id, { status: 'cancelled' })
    }
    log.info(`项目「${room.name}」dispatch #${dispatchId} 已取消${reason ? `：${reason}` : ''}`)
    this.broadcastDispatches(room)
  }

  /** 调度状态变化后推全量 dispatch 列表给页面（前端小面板实时刷新） */
  private broadcastDispatches(room: RoomInfo): void {
    try {
      this.broadcast({ type: 'roomDispatches', roomId: room.id, dispatches: projectDb.listDispatches(room.team) })
    } catch (err) {
      log.warn(`调度状态广播失败 项目「${room.name}」`, err)
    }
  }

  /**
   * 注入 note 并回显验证：codebuddy resume 有数秒静默恢复期（pty 实验台 2026-07-21 实测 ~5s，
   * 恢复期间零输出、输入框未接管），onceQuiet 1.2s 会在恢复期中段提前 fire，
   * note 打进未就绪的输入框被静默吞掉（54f424c1 两轮实锤）。
   * 故注入后盯输出里的回显标记：note 尾部追加的每次注入唯一 nonce（#xxxx），
   * 输入框光标在末尾 → nonce 必然落在可见渲染尾部。不能用 note 固有文案当标记——
   * resume 恢复渲染会重放历史消息里的旧 note 文本（「你的回复」在旧 transcript 出现 9 次），
   * 会造成回显误报、吞掉重试（epoch 8 实锤）。
   * ECHO_VERIFY_MS 内未见回显 = 被吞，quiet 后重发，最多 ECHO_MAX_ATTEMPTS 次。
   * 返回本次注入的 nonce（回显标记）：调度底账用它作 delivery.correlation_id；
   * 重发会产生新 nonce，但对外只暴露首个（底账只需关联到本次注入意图）。
   */
  private injectNote(sessionId: string, note: string, onSent: (sess: Session) => void, attempt = 1): string {
    const sess = this.manager.get(sessionId)
    const nonce = Math.random().toString(36).slice(2, 6)
    const wire = `${note}（#${nonce}）`
    const mark = `#${nonce}`
    sess.onceQuiet(() => {
      let echoed = false
      let tail = ''
      const onOut = (data: string) => {
        // TUI 渲染的 ANSI 转义可能插在文字中间，剥掉再拼滚动窗口（防 marker 被切块）
        // eslint-disable-next-line no-control-regex
        tail = (tail + data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')).slice(-2000)
        if (tail.includes(mark)) echoed = true
      }
      sess.on('output', onOut)
      try {
        sess.sendline(wire, { autoName: false })
        onSent(sess)
      } catch {
        /* 会话可能已退出/被删 */
      }
      setTimeout(() => {
        sess.off('output', onOut)
        if (echoed || !sess.isRunning) return
        if (attempt >= ECHO_MAX_ATTEMPTS) {
          log.warn(`note 注入 ${sessionId.slice(0, 8)} ${ECHO_MAX_ATTEMPTS} 次均未见回显，放弃（会话可能卡在启动页）`)
          return
        }
        log.info(`note 注入 ${sessionId.slice(0, 8)} 未见回显（第 ${attempt} 次疑被吞），quiet 后重发`)
        try {
          this.injectNote(sessionId, note, onSent, attempt + 1)
        } catch {
          /* 会话已被删 */
        }
      }, ECHO_VERIFY_MS).unref() // unref：不拖住进程退出（测试/关停场景）
    })
    return nonce
  }

  /** 读 session 注入前的 transcript 消息数（claude 系走 readHistoryAllMessages，agent 系走 readAgentTranscript）*/
  private sessionMessageCount(session: Session): number {
    try {
      if (session.claudeSessionId) {
        const fp = transcriptPath(session)
        return fp ? readHistoryAllMessages(fp).length : 0
      }
      const kind = agentKindOf(session.command)
      return kind ? readAgentTranscript(session, kind, { cursor: 0 }).cursor : 0
    } catch {
      return 0
    }
  }

  /** 读 session 注入后的增量 transcript 消息 */
  private readSessionDelta(session: Session, beforeCount: number): TranscriptMessage[] {
    try {
      if (session.claudeSessionId) {
        const fp = transcriptPath(session)
        return fp ? readHistoryAllMessages(fp).slice(beforeCount) : []
      }
      const kind = agentKindOf(session.command)
      return kind ? readAgentTranscript(session, kind, { cursor: beforeCount }).messages : []
    } catch {
      return []
    }
  }

  /** 扫描待捕获会话：agent 主动回执则清除；否则取回复 text，回复完/超时则自动回执到项目 */
  private captureTick() {
    const now = Date.now()
    for (const [sid, cap] of this.pendingCapture) {
      const captureRoom = this.rooms.list().find((r) => r.team === cap.team)
      if (captureRoom?.archivedAt !== null) {
        this.pendingCapture.delete(sid)
        continue
      }
      let session: Session
      try {
        session = this.manager.get(sid)
      } catch {
        this.pendingCapture.delete(sid) // 会话已退出/被删
        continue
      }
      const delta = this.readSessionDelta(session, cap.beforeCount)
      // agent 已主动回执（areco-msg）：只认 assistant 侧的 text/tool_use → 不自动（避免双重回执）。
      // 注入的 note 本身含 areco-msg 命令，会作为 user 消息落进 transcript，不排除则首个
      // captureTick 即误判「已回执」删掉 pendingCapture，自动捕获永远不触发。
      const alreadyReplied = delta.some(
        (m) =>
          m.role === 'assistant' &&
          m.parts.some((p) => {
            if (p.kind === 'tool_use') return /areco-msg/.test(p.input)
            if (p.kind === 'text') return /areco-msg/.test(p.text)
            return false
          })
      )
      if (alreadyReplied) {
        this.pendingCapture.delete(sid)
        continue
      }
      const text = delta
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text))
        .join('\n')
        .trim()
      const replyDone = session.trafficState !== 'working'
      const timeout = now - cap.injectedAt > CAPTURE_TIMEOUT_MS
      if (text && (replyDone || timeout)) {
        try {
          const stored = projectDb.send(cap.team, cap.memberName, cap.fromName, text.slice(0, CAPTURE_TEXT_MAX))
          const room = this.rooms.list().find((r) => r.team === cap.team)
          if (room) {
            this.cursors.set(room.id, Math.max(this.cursors.get(room.id) ?? 0, stored.id))
            this.broadcast({ type: 'roomMessage', roomId: room.id, message: this.toRoomMessage(room, stored) })
            // 自动捕获的回复同样过统一后处理：serial 房间靠它推进轮转（agent 没跑 areco-msg 也能轮到下一位）
            this.onMessageStored(room, stored)
            this.refreshContext(room)
          }
          log.info(`项目「${cap.roomName}」自动捕获 ${cap.memberName} 回复（${text.length} 字）`)
        } catch (err) {
          log.warn(`自动捕获回执失败 ${cap.memberName}`, err)
        }
        this.pendingCapture.delete(sid)
      } else if (timeout) {
        // 超时仍无 assistant text（纯工具调用/静默等）：直接清除，
        // 否则条目永久残留、每 2s 重读 transcript
        this.pendingCapture.delete(sid)
        log.info(`项目「${cap.roomName}」等待 ${cap.memberName} 回复超时且无文本，放弃自动捕获`)
      }
    }
  }
}
