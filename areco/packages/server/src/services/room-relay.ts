// 项目协作中继：消息在项目消息库（project-db.ts），本服务做三件事——
// 1) 轮询拾取：2s 游标轮询各项目新消息（agent 用 areco-msg.mjs 回执的也从这进来），WS 广播给页面；
// 2) mention 投递：@成员/@all → onceQuiet 注入目标会话终端（注入模板带来源+回执命令）；
// 3) 防环：人发言清零链路深度；agent 消息触发投递时深度+1，≥MAX_DEPTH 只落库不投递。
// 页面发消息走 postMessage（落库 + 立即广播 + 投递），不等轮询；轮询只负责"外部进来的"消息。
// 房间调度（2026-07-22 确定性设计，不上 LLM selector；2026-07-26 砍掉房间级 parallel，一律串行）：
// 消息可见性与行动许可拆开——无 @ 的人类发言全体收到（message_targets 逐行落账），但一次只放行
// 一位成员实施，回复/超时/取消驱动轮转。@不同成员派不同任务=各自独立 dispatch，天然并行。
// 底账在 projects.db 的 dispatch/delivery 表。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { RoomInfo, RoomMember, RoomMessage, ServerMsg, TranscriptMessage } from '../../../shared/protocol'
import type { SessionManager } from './session-manager'
import type { Session } from './session'
import { DATA_DIR, MSG_CLI_PATH } from '../config'
import { createLogger } from '../logger'
import * as projectDb from './project-db'
import { ALL_MENTION, CHARTER_FILE, KIND_LABEL, parseMentions, RoomStore } from './rooms'
import { shellQuote } from './templates'
import {
  isAppendOnlyAgentKind,
  locateAgentTranscriptPath,
  parseAgentIncrement,
  readAgentTranscript,
} from './agent-transcript'
import { parseTranscriptLine, transcriptPath } from './transcript'
import { readHistoryAllMessages } from './history'

const log = createLogger('room-relay')

// 2026-07-26 StandCode 提速批件：2000→1000，消息从落库到投递的平均等待 ~1s→~0.5s。
// 扫的是本地 SQLite 增量 + captureTick 读屏，1s 一轮成本可忽略；env 可调回。
const POLL_MS = Math.max(250, Number(process.env.ARECO_RELAY_POLL_MS ?? 1000) || 1000)
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
const CAPTURE_TIMEOUT_MS = 60_000 // 软超时：每满一轮检查一次；灯已收工才捕获，仍在干活则顺延
const CAPTURE_TEXT_MAX = 2000 // 自动回执正文截断
// 交付物门槛（2026-07-30 诊断 F2）：旧口径「trafficState !== working 且有 text」把 claude 系
// 干活前的开工叙述（text→下一个 tool_use 之间灯短暂非 working）当完成回复捕获入房。
// 新口径按「灯稳 + transcript 稳」连续拍数收网：像交付物的文本 3 拍即收，
// 弱文本（短句/开工白话）8 拍（跨过 claude 思考停顿的 transcript 静默窗）。
const CAPTURE_SETTLE_TICKS = 3 // 交付物文本连续稳定拍数（POLL_MS/拍）
const CAPTURE_SETTLE_TICKS_WEAK = 8 // 弱文本（不像交付物/开工白话）连续稳定拍数
const CAPTURE_HARD_MAX_MS = 30 * 60_000 // 硬上限：灯一直 working 顺延到此为止，防条目永久残留
// 交付物判据移植自 caller.py _looks_like_deliverable（那边是权威源，改判据两处同步）：
// 结论段/产物路径/commit hash/数字结果 → 像交付物；短开工白话 → 不像；长正文 ≥200 字放行
const DELIV_CONCLUSION_RE = /结论|综上|汇报如下|结果如下|报告如下|已完成|完成情况|交付|验收|产物路径/
const DELIV_PATH_RE = /(?:^|[\s：:（("'`「『])(?:\/|~\/)[\w.~/-]{2,}/
const DELIV_HASH_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/
const DELIV_NUMBER_RE = /\d+(?:\.\d+)?\s*(?:条|个|份|行|次|案|件|篇|页|元|字|图|秒|%|％)/
const PROGRESS_OPENER_RE = /^(?:好的|收到|明白|马上|稍等|我先|我来|我去|让我|正在|开始|接下来|下面我|现在我|先让我)/
/** Stand 回复合并文本像不像「交付物」（captureTick 快车道门槛；export 供测试） */
export function looksLikeDeliverable(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (DELIV_CONCLUSION_RE.test(t) || DELIV_PATH_RE.test(t) || DELIV_HASH_RE.test(t)) return true
  if (PROGRESS_OPENER_RE.test(t) && t.length < 200) return false // 短开工白：带数字也算进度句
  if (DELIV_NUMBER_RE.test(t)) return true
  return t.length >= 200 // 长正文按交付物放行——纯进度句写不满 200 字
}

// serial 串行轮转超时已移除（2026-07-27）：不再因超时自动放下一位；
// 只有成员回复/cancel 驱动轮转。deadline 未设时 sweepTimeouts 已是 no-op。

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

/** recall 子进程结果（recallRunner 注入点的返回形态；测试桩同步返回同形对象即可） */
interface RecallRunResult {
  error?: Error | null
  status: number | null
  stdout: string
}

/** python recall 子进程调用点：生产为异步 execFile（2026-07-30 P1-6，旧 spawnSync 最长
 *  3s 同步阻塞整个 event loop——tick/captureTick/PTY/WS 全被拖住）；测试替换此注入点，
 *  不起真子进程。同步返回或返回 Promise 均可（runRecall 统一 await）。 */
export const recallRunner: {
  fn: (
    cmd: string,
    args: string[],
    opts: { encoding: 'utf-8'; timeout: number }
  ) => RecallRunResult | Promise<RecallRunResult>
} = {
  fn: (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(cmd, args, { encoding: opts.encoding, timeout: opts.timeout }, (error, stdout) => {
        // execFile 超时/非零退出都走 error 分支；stdout 尽量带回（解析层自兜）
        resolve(error ? { error, status: 1, stdout: stdout ?? '' } : { status: 0, stdout: stdout ?? '' })
      })
    }),
}

/** 压平空白并截断 body，供纪要/预览单行展示 */
function clipBody(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** stat 文件字节数；不存在/不可读返回 0（P1-7 captureTick 字节锚用） */
function statSizeSafe(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
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
  /** auto-recall 在途子进程：root message id → 结果 Promise（P1-6 异步化后并发投递共享同一子进程） */
  private recallInflight = new Map<number, Promise<string | null>>()
  /** 项目驻场简报账本：sessionId → 已简报的进程代际（epoch）。每代首条投递带一次 PROJECT.md 指路；内存态，重启后重发一次无害 */
  private briefedEpochs = new Map<string, number>()
  /** 注入后待捕获 agent 回复：sessionId → 锚点（注入前消息数 + 来源 + 稳定拍计数）。agent 主动回执或自动捕获后清除 */
  private pendingCapture = new Map<
    string,
    {
      team: string
      roomName: string
      roomId: string
      memberName: string
      fromName: string
      beforeCount: number
      injectedAt: number
      /** 灯非 working 且 transcript 无增长的连续拍数（captureTick 维护） */
      settleTicks: number
      /** 上一拍的 assistant text 总长（稳定性判据之一） */
      lastLen: number
      /** 上一拍的 transcript 增量条数（thinking/tool_use 落盘也会重置稳定拍） */
      lastDeltaCount: number
      /** 软超时时刻：到点若灯仍 working（干活中）则顺延，收工才捕获 */
      deadlineAt: number
      // ---- P1-7 增量读状态（追加型 transcript 专用；非追加型回落 readSessionDelta 全量路径）----
      /** 注入时刻的 transcript 字节数（此后的文件内容即「注入后增量区」）；-1 = 走全量回落路径 */
      anchorBytes: number
      /** 绑定的 transcript 路径（注入时/首拍定位后钉死；null = 还没定位到，逐拍重试） */
      filePath: string | null
      /** 上一拍文件字节数：未变 → 零读盘沿用 cachedDelta（等稳期主要省的就是这里） */
      lastSize: number
      /** 上一拍解析出的增量消息缓存 */
      cachedDelta: TranscriptMessage[] | null
    }
  >()
  private timer: NodeJS.Timeout | null = null
  /** captureTick 独立 timer（P1-7 拆分：读屏/捕获的 IO 不再与消息轮询 tick 串行互拖） */
  private captureTimer: NodeJS.Timeout | null = null
  private readonly humanRelayAgents: string[]

  constructor(
    private rooms: RoomStore,
    private manager: SessionManager,
    private broadcast: (msg: ServerMsg) => void,
    opts: RoomRelayOpts = {}
  ) {
    this.humanRelayAgents = opts.humanRelayAgents ?? []
  }

  start() {
    if (this.timer) return
    this.startedAtMs = Date.now()
    // 会话被删除时联动移除项目里指向它的 member，否则悬空 member 发消息静默失效（首次 start 挂一次）
    this.manager.on('removed', (sessionId) => this.onSessionRemoved(sessionId))
    this.timer = setInterval(() => this.tick(), POLL_MS)
    // P1-7 拆 timer：captureTick 的 transcript stat/读盘不再挂在消息轮询后面串行跑，
    // 一边的慢 IO 不拖另一边的节拍（同频不同 interval，错峰由事件循环自然形成）
    this.captureTimer = setInterval(() => this.captureTick(), POLL_MS)
    log.info(`项目中继已启动（${POLL_MS}ms 轮询，${this.rooms.list().length} 个项目）`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.captureTimer) clearInterval(this.captureTimer)
    this.captureTimer = null
  }

  /** 会话被删除：联动移除所有项目里指向它的 member（避免悬空 member 发消息静默失效） */
  private onSessionRemoved(sessionId: string) {
    this.briefedEpochs.delete(sessionId)
    let changed = false
    for (const room of this.rooms.list()) {
      if (room.archivedAt !== null) continue // 归档项目保留成员快照，不随会话删除而改写
      const victim = room.members.find((m) => m.kind === 'session' && m.sessionId === sessionId)
      if (!victim) continue
      try {
        this.rooms.removeMember(room.id, victim.name)
        log.info(`会话 ${sessionId.slice(0, 8)} 被删，联动移除项目「${room.name}」成员 ${victim.name}`)
        changed = true
      } catch (err) {
        log.warn(`联动移除成员失败 项目「${room.name}」`, err)
      }
    }
    if (changed) this.broadcastRooms()
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

  /**
   * 署名校正（2026-07-29 冒名回执事件：hy3 接手 Glm5.2 会话后照抄旧包装里的回执命令，
   * 干的活记到 GLM 头上）。外部 areco-msg 直写的旧包装命令无法召回，故 tick 摄入时按
   * 「成员绑定会话的当前实际模板」校正 from：
   *  - from 命中 kind=session 成员，且绑定会话存活，且 member.templateId ≠ session 当前
   *    templateId（= 会话被别的模板接手）→ from 改写为当前模板显示名，库里行同步 UPDATE，
   *    记 log.warn。校正目标名与房内另一成员重名也照改（from 只作署名，成员匹配走错名兜底）。
   *  - 存量 member 缺 templateId：首轮见到能取到存活 session 即懒补回填并持久化。
   *  - 取不到 session / 会话已退出 / templateId 一致 / 模板名取不到：原样放过。
   */
  private resolveActualSender(room: RoomInfo, m: projectDb.ProjectMessageRow): projectDb.ProjectMessageRow {
    const member = room.members.find((x) => x.kind === 'session' && x.name === m.from)
    if (!member?.sessionId) return m
    let session: Session
    try {
      session = this.manager.get(member.sessionId)
    } catch {
      return m // 会话已从 Map 摘除：无从判断实际执行者，原样放过
    }
    if (!session.isRunning) return m // 只认存活会话：死会话的 templateId 证明不了当前执行者
    // 懒补：存量 member 无 templateId，首轮见到即回填持久化（回填即绑定现状，必然一致，无需校正）
    if (!member.templateId) {
      if (session.templateId) {
        try {
          this.rooms.stampMemberTemplate(room.id, member.name, session.templateId)
        } catch (err) {
          log.warn(`项目「${room.name}」成员 ${member.name} templateId 回填失败`, err)
        }
      }
      return m
    }
    if (member.templateId === session.templateId) return m
    const actual = this.manager.templateNameOf(session)
    if (!actual || actual === m.from) return m
    try {
      projectDb.correctMessageSender(m.id, actual)
    } catch (err) {
      log.warn(`项目「${room.name}」署名修正落库失败 消息 #${m.id}`, err)
      return m
    }
    log.warn(`项目「${room.name}」署名修正 ${m.from}→${actual}（消息 #${m.id}，绑定会话被模板 ${session.templateId} 接手）`)
    return { ...m, from: actual }
  }

  private tick() {
    for (const room of this.rooms.list()) {
      // P2-10 归档房短路（history 拉取之前）：归档房不再每秒白拉 50 条。旧逻辑在拉取后
      // 推游标防「恢复后补投轰炸」——该职责移交 fastForwardCursor（unarchive 时快进），
      // 语义等价：归档期外部直写的消息恢复后照旧不补投。
      if (room.archivedAt !== null) continue
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
          const msg = this.resolveActualSender(room, m)
          this.broadcast({ type: 'roomMessage', roomId: room.id, message: this.toRoomMessage(room, msg) })
          this.onMessageStored(room, msg)
        }
        continue
      }
      let hadNew = false
      for (const m of msgs) {
        if (m.id <= cursor) continue
        this.cursors.set(room.id, m.id)
        hadNew = true
        const msg = this.resolveActualSender(room, m)
        this.broadcast({ type: 'roomMessage', roomId: room.id, message: this.toRoomMessage(room, msg) })
        this.onMessageStored(room, msg)
      }
      if (hadNew) this.refreshContext(room) // 外部（areco-msg.mjs 回执等）进来的消息：批量后刷新一次
      // sweepTimeouts 已移除：派发不再因超时自动放下一位（2026-07-27）
    }
  }

  /** 转述白名单查询（rooms.send REST 通道的署名把关用；名单即构造时注入的 humanRelayAgents） */
  isHumanRelayAgent(name: string): boolean {
    return this.humanRelayAgents.includes(name)
  }

  /** 归档房恢复时把游标快进到最新消息（P2-10 配套：tick 已对归档房零处理，归档期
   *  外部直写的消息在恢复后不补投——与旧「每拍推游标」行为等价）。history 读失败时
   *  不动游标：残留旧游标最坏补投几条归档期消息，比在恢复路径抛错强。 */
  fastForwardCursor(roomId: string): void {
    const room = this.rooms.list().find((r) => r.id === roomId)
    if (!room) return
    try {
      const msgs = projectDb.history(room.team, 1)
      this.cursors.set(room.id, msgs.length ? msgs[msgs.length - 1].id : 0)
    } catch (err) {
      log.warn(`恢复房间 ${room.name} 游标快进失败`, err)
    }
  }

  /** 页面发消息：落库（游标同步推进，避免轮询二次广播）+ 立即广播 + 投递
   *  opts.to：显式收件人（caller REST 快路用，落库 to_agent 账面与旧 SQLite 直写一致；
   *  正文无 @ 时 deliverMentions 按该列投递）。缺省走 parseMentions 推断。 */
  postMessage(roomId: string, from: string, body: string, opts?: { humanRelay?: boolean; to?: string }): RoomMessage {
    const room = this.rooms.get(roomId)
    if (room.archivedAt !== null) throw new Error(`项目「${room.name}」已归档，只能查看或恢复`)
    const text = body.trim()
    if (!text) throw new Error('消息不能为空')
    const { targets, all } = parseMentions(text, room.members)
    const to =
      opts?.to?.trim() ||
      (all ? ALL_MENTION : (targets[0] ?? (from === this.rooms.humanName ? ALL_MENTION : this.rooms.humanName)))
    const stored = projectDb.send(room.team, from, to, text, { humanRelay: opts?.humanRelay })
    this.cursors.set(room.id, Math.max(this.cursors.get(room.id) ?? 0, stored.id))
    const message = this.toRoomMessage(room, stored)
    this.broadcast({ type: 'roomMessage', roomId: room.id, message })
    this.onMessageStored(room, stored)
    this.refreshContext(room) // 页面发言：纪要文件常驻刷新（含当条）
    return message
  }

  /** 消息落库后的统一后处理（tick 轮询 / postMessage / captureTick 三路径共用）：
   *  1) mention 投递（串行：只放行当前轮到的成员）；
   *  2) 串行推进：本条 from 命中 active serial dispatch 的 current_target → 当前 delivery 落定、放下一位。 */
  private onMessageStored(room: RoomInfo, m: { id: number; from: string; body: string; to?: string; humanRelay?: boolean }) {
    this.deliverMentions(room, m.from, m.body, m.id, m.humanRelay ?? false, m.to)
    this.advanceSerial(room, m.from)
  }

  /**
   * 投递 @mention/广播到目标会话终端。
   *  - 人类发言默认投全体（不必每次手打 @all，维护者 2026-07-20 定）；agent 发言仍需显式 @，防互调失控。
   *  - 人→agent 投递附「共享上下文文件路径 + 最近若干条预览」，agent 进来不再失忆；agent→agent 不附，防膨胀。
   *  - 防环：人发言清零链路深度；agent 互调深度 ≥MAX_DEPTH 时只落库不投递。
   *  - 调度底账（2026-07-22）：message_targets 落真实收件人（广播展开成成员名），
   *    幂等建 dispatch + deliveries；串行只放行成员顺序第一位，回复/超时驱动轮转。
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
    // mode 固定 'serial'：房间级并行已砍（2026-07-26），@不同成员派不同任务=各自独立 dispatch，天然并行。
    let dispatch: projectDb.DispatchRow | null = null
    let deliveries: projectDb.DeliveryRow[] = []
    try {
      projectDb.recordMessageTargets(currentId, members.map((m) => m.name))
      dispatch = projectDb.createDispatch(room.team, currentId, 'serial', MAX_DEPTH).dispatch
      deliveries = projectDb.addDeliveries(
        dispatch.id,
        members.map((m) => ({ name: m.name, sessionId: m.sessionId }))
      )
    } catch (err) {
      log.warn(`项目「${room.name}」调度记账失败，全员直接注入兜底`, err)
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
    // 幂等重入（同一根消息重复处理，如重启后首轮快进重放）时已有放行位则不再注入。
    if (dispatch) {
      const busy = deliveries.some((d) => d.status === 'injected' || d.status === 'working')
      if (!busy) this.serialAdvanceNext(room, dispatch.id)
      this.broadcastDispatches(room)
      return
    }

    // 记账失败兜底（dispatch 建不出来 = 没有轮转底账可推进）：全员直接注入，投递不能因账务故障丢。
    // 此路径无 deliveries 可查，重启重放的幂等保护不可用——degraded 但可接受（消息本身已落库）。
    const flat = body.replace(/\s*\r?\n\s*/g, '；')
    for (const m of members) {
      this.injectToMember(room, m, from, flat, senderKind, currentId)
    }
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
      // recall 缓存热直接拼正文；冷则正文先行（不再同步等 3s 子进程），命中后补注（P1-6）
      const recall = this.recallBlock(currentId, from, flat, senderKind, (lateBlock) => {
        this.injectLateRecall(room, m.name, session.id, lateBlock)
      })
      // 项目房间驻场简报：每个进程代际（epoch）首条投递带一次。resume 链会被压缩/截断，
      // 驻留上下文的 SoT 是项目根下的 PROJECT.md——指过去让成员自己读，不塞正文防 note 膨胀。
      // epoch 现读现取：上面 restart 分支刚拉起过的会话，手里的 summary 还是旧代际。
      // 末位 ?? 0 兜底 epoch 缺失（测试桩等）：undefined !== undefined 恒假会让简报永不触发。
      const epoch = (this.manager.list().find((s) => s.id === session.id)?.epoch ?? session.epoch) ?? 0
      const brief =
        room.kind === 'project' && room.rootPath && this.briefedEpochs.get(session.id) !== epoch
          ? `（你是项目「${room.name}」的驻场成员，项目根：${room.rootPath}。动手前先读 ${path.join(room.rootPath, CHARTER_FILE)}（项目宪章=驻留上下文），实质结论回写该文件「工作纪要」节。）`
          : null
      const replyCmd = `node ${shellQuote(MSG_CLI)} ${room.team} ${shellQuote(m.name)} ${shellQuote(from)} '<你的回复>'`
      // 2026-07-29 高律师令：房间分任务/项目两层，注入文案按 kind 说「任务」或「项目」，
      // 不再一律写「项目」（任务房间占绝大多数，旧文案误导 agent 以为自己在项目里）。
      const kindLabel = KIND_LABEL[room.kind]
      const note =
        `[${kindLabel}·${room.name}] ${from}: ${flat}` +
        (directive ? `（${directive}）` : '') +
        (ctx ? `（共享上下文 ${ctx.path}；最近：${ctx.preview}）` : '') +
        (recall ? `\n${recall}\n` : '') +
        (brief ? `\n${brief}\n` : '') +
        `（⚠️你在终端里的回复${this.rooms.humanName}在${kindLabel}里看不到，必须执行下面命令把回复发回${kindLabel}，否则等于没回：${replyCmd}。` +
        `如果实际执行者不是 ${m.name} 本人（会话被他人接手/代跑），必须先把命令里的署名「${m.name}」改成执行者自己的实际 Stand 名再执行，禁止照抄原署名——否则成果会记到 ${m.name} 头上）`
      const nonce = this.injectNote(session.id, note, (sess) => {
        // P1-7 字节锚：追加型 transcript 记「注入时刻文件大小」，captureTick 只读锚后增量
        // （stat 未变直接零读盘）。非追加型（reasonix replace 帧等）/探测失败 → anchor=-1，
        // 回落旧的消息数锚全量路径（beforeCount 仅该路径使用）。
        const probe = this.captureAnchorProbe(sess)
        const beforeCount = probe ? 0 : this.sessionMessageCount(sess) // 注入前消息数（note 尚未落盘）
        // 标记待捕获：agent 若不主动回执，captureTick 取其回复代为回执到项目
        this.pendingCapture.set(session.id, {
          team: room.team,
          roomName: room.name,
          roomId: room.id,
          memberName: m.name,
          fromName: from,
          beforeCount,
          injectedAt: Date.now(),
          settleTicks: 0,
          lastLen: -1, // -1 保证首拍必判「有变化」，不虚增稳定拍
          lastDeltaCount: -1,
          deadlineAt: Date.now() + CAPTURE_TIMEOUT_MS,
          anchorBytes: probe ? probe.anchorBytes : -1,
          filePath: probe?.filePath ?? null,
          lastSize: -1,
          cachedDelta: null,
        })
      })
      // 注入成功才记账：失败让下一条投递继续带简报，宁重发不漏发
      if (nonce && brief) this.briefedEpochs.set(session.id, epoch)
      log.info(`项目「${room.name}」投递 ${from} → ${m.name}`)
      return nonce
    } catch (err) {
      log.warn(`投递失败 ${room.name} → ${m.name}`, err)
      return null
    }
  }

  /**
   * auto-recall 注入块：人发的一律跑；session 发的仅命中委派格式特征（或 from='areco-调度' 的调度指令）才跑。
   * 按 rootMessageId 缓存——同一根消息投多个成员只起一次 python 子进程。无命中/任何失败不注入。
   * P1-6 异步化（2026-07-30）：缓存热 → 同步返回块拼进正文（旧行为）；缓存冷 → 返回 null
   * 让正文先行注入零等待，后台跑 recall，命中后经 onLate 回调补注（追加 note）。
   */
  private recallBlock(
    rootMessageId: number,
    from: string,
    flat: string,
    senderKind: 'human' | 'session',
    onLate: (block: string) => void
  ): string | null {
    if (senderKind !== 'human' && from !== 'areco-调度' && !DELEGATION_RE.test(flat)) return null
    const cached = this.recallMemo.get(rootMessageId)
    if (cached !== undefined) return cached
    let p = this.recallInflight.get(rootMessageId)
    if (!p) {
      p = this.runRecall(this.recallQuery(flat)).then((block) => {
        if (this.recallMemo.size >= RECALL_MEMO_MAX) this.recallMemo.clear()
        this.recallMemo.set(rootMessageId, block)
        this.recallInflight.delete(rootMessageId)
        return block
      })
      this.recallInflight.set(rootMessageId, p)
    }
    // 每个等着的成员各挂一个补注回调（degraded 全员直投时并发共享同一子进程结果）
    p.then((block) => {
      if (block) onLate(block)
    }).catch(() => {
      /* runRecall 自身全捕获，这里只兜 onLate 抛错 */
    })
    return null
  }

  /** recall 后到补注（P1-6）：任务正文已先行注入，把命中的记忆块作为补充 note 追加进同一会话。
   *  不动 pendingCapture（主任务捕获锚点不受影响）；会话已退出/被删由 injectNote 内部兜住。 */
  private injectLateRecall(room: RoomInfo, memberName: string, sessionId: string, block: string): void {
    try {
      this.injectNote(sessionId, `（auto-recall 补充，相关记忆供参考）\n${block}`, () => {})
      log.info(`项目「${room.name}」recall 后到，补注 ${memberName}`)
    } catch (err) {
      log.warn(`项目「${room.name}」recall 补注 ${memberName} 失败`, err)
    }
  }

  /** recall query 构造：正文含「相关记忆：xxx」/「recall：xxx」引导的取其内容；否则去信封前缀后截前 120 字 */
  private recallQuery(flat: string): string {
    const guided = flat.match(/(?:相关记忆|recall)\s*[:：]\s*([^；\n]+)/i)
    if (guided) return guided[1].trim().slice(0, RECALL_QUERY_CLIP)
    return flat.replace(/^\[[^\]]*\]\s*/, '').slice(0, RECALL_QUERY_CLIP)
  }

  /** 异步跑 recall.py（3s 超时；P1-6 前为 spawnSync 同步阻塞 event loop）：
   *  非零退出/超时/JSON 解析失败/db 锁等任何失败静默返回 null，绝不阻塞投递 */
  private async runRecall(query: string): Promise<string | null> {
    if (!RECALL_SCRIPT) return null
    try {
      const out = await recallRunner.fn('python3', [RECALL_SCRIPT, '--json', '--topk', String(RECALL_TOPK), query], {
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
   * 成功则置 injected + current_target；注入失败记 failed 顺延；无可放行的则 dispatch done。
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
        projectDb.setDispatchState(dispatchId, { state: 'done', currentTarget: null })
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
          })
          log.info(`项目「${room.name}」串行放行 ${del.memberName}（dispatch #${dispatchId}）`)
          return
        }
        projectDb.updateDelivery(del.id, { status: 'failed', attempt: del.attempt + 1 })
      }
      projectDb.setDispatchState(dispatchId, { state: 'done', currentTarget: null })
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
   *
   * ⚠️ 返回值只代表「已排入注入队列」，**不代表已送达**。nonce 是同步返回的，而真正的
   * sendline 发生在之后的 onceQuiet 回调里，可能根本没跑（会话在静默窗口内死掉）、
   * 抛错、或回显校验重试耗尽。这三种情况调用方都会拿到真值 nonce 并写 status:'injected'，
   * 于是「什么都没投出去」被记成「已投递」——串行房间会因此冻住整条队列直到超时清扫。
   * 三条路径现已各自 log.warn（改动前完全静默），但**状态机仍未修**：
   * 正解是加 onFailed 回调（serialAdvanceNext 里 `nonce` 为假时的 failed 分支已经写好了，
   * 只是永远走不到），详见 docs/known-issues.md「投递谎报成功」。
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
      } catch (err) {
        // 会话可能已退出/被删。原先是空 catch —— 这条投递彻底没发出去，
        // 而调用方已经拿着 nonce 记了 status:injected，从日志里看不出任何异常。
        // 至少让它可见（真正的修法见 docs/known-issues.md「投递谎报成功」）。
        log.warn(`note 注入 ${sessionId.slice(0, 8)} sendline 失败，本次投递未发出`, err)
      }
      setTimeout(() => {
        sess.off('output', onOut)
        if (echoed) return
        if (!sess.isRunning) {
          // 会话在静默窗口内死了 —— 同样什么都没投出去，同样对调用方不可见
          log.warn(`note 注入 ${sessionId.slice(0, 8)} 期间会话已退出，本次投递未送达`)
          return
        }
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
      const kind = this.manager.agentKind(session)
      return kind ? readAgentTranscript(session, kind, { cursor: 0 }).cursor : 0
    } catch {
      return 0
    }
  }

  /** 读 session 注入后的增量 transcript 消息（P1-7 后仅作非追加型/探测失败的回落路径） */
  private readSessionDelta(session: Session, beforeCount: number): TranscriptMessage[] {
    try {
      if (session.claudeSessionId) {
        const fp = transcriptPath(session)
        return fp ? readHistoryAllMessages(fp).slice(beforeCount) : []
      }
      const kind = this.manager.agentKind(session)
      return kind ? readAgentTranscript(session, kind, { cursor: beforeCount }).messages : []
    } catch {
      return []
    }
  }

  /** P1-7 注入时刻的字节锚探测：追加型 transcript 返回 {filePath, anchorBytes}；
   *  非追加型/取不到 kind/任何异常返回 null（调用方回落消息数锚全量路径）。
   *  文件此刻还不存在（冷 spawn 尚未写盘）→ filePath=null、anchor=0：captureTick 逐拍
   *  重定位，文件一出现整个文件都是注入后内容（新会话文件），从 0 起算正确。 */
  private captureAnchorProbe(session: Session): { filePath: string | null; anchorBytes: number } | null {
    try {
      if (session.claudeSessionId) {
        const fp = transcriptPath(session)
        return { filePath: fp, anchorBytes: fp ? statSizeSafe(fp) : 0 }
      }
      const kind = this.manager.agentKind(session)
      if (!kind || !isAppendOnlyAgentKind(kind)) return null
      const fp = locateAgentTranscriptPath(session, kind)
      return { filePath: fp, anchorBytes: fp ? statSizeSafe(fp) : 0 }
    } catch {
      return null
    }
  }

  /** P1-7 captureTick 专用增量读：字节锚 + stat 快路径。
   *  锚可用（anchorBytes ≥ 0）时：文件 size 未变 → 直接回缓存零读盘（等稳期每拍的大头）；
   *  变了 → 只读 [anchor, EOF) 增量段解析（远小于全量 transcript）。
   *  文件轮换/截断（size < anchor）或锚不可用 → 回落 readSessionDelta 全量路径。 */
  private captureDelta(session: Session, cap: { beforeCount: number; anchorBytes: number; filePath: string | null; lastSize: number; cachedDelta: TranscriptMessage[] | null }): TranscriptMessage[] {
    // 锚未建立（-1 = 非追加型回落；undefined = 存量条目/测试桩）一律走旧全量路径
    if (typeof cap.anchorBytes !== 'number' || cap.anchorBytes < 0) {
      return this.readSessionDelta(session, cap.beforeCount)
    }
    try {
      if (!cap.filePath) {
        // 注入时文件还没出现（qclaw 冷启 turn 末才写盘）：逐拍重定位
        cap.filePath = session.claudeSessionId
          ? transcriptPath(session)
          : (() => {
              const kind = this.manager.agentKind(session)
              return kind ? locateAgentTranscriptPath(session, kind) : null
            })()
        if (!cap.filePath) return []
      }
      const size = statSizeSafe(cap.filePath)
      if (size < cap.anchorBytes) return this.readSessionDelta(session, cap.beforeCount) // 轮换/截断
      if (size === cap.lastSize && cap.cachedDelta) return cap.cachedDelta // stat 快路径：零读盘
      // 增量区上限 4MB：马拉松任务锚后增量过大时只读尾段（行首对齐），丢的是最早增量——
      // 捕获正文本就截 CAPTURE_TEXT_MAX，唯一代价是超早段的 areco-msg 主动回执标记可能漏检
      //（低概率重复回执，危害远小于每拍全量读）
      const INCR_MAX = 4 * 1024 * 1024
      const from = Math.max(cap.anchorBytes, size - INCR_MAX)
      const fd = fs.openSync(cap.filePath, 'r')
      let buf: Buffer
      try {
        buf = Buffer.alloc(size - from)
        fs.readSync(fd, buf, 0, buf.length, from)
      } finally {
        fs.closeSync(fd)
      }
      let text = buf.toString('utf8')
      // 行首对齐：from 落在行中（锚采样时半行在途/尾段截断）则丢残首行
      if (from > 0) {
        const headProbe = text.slice(0, 1)
        if (headProbe !== '{' && headProbe !== '') {
          const nl = text.indexOf('\n')
          text = nl >= 0 ? text.slice(nl + 1) : ''
        }
      }
      const msgs = session.claudeSessionId
        ? text
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => parseTranscriptLine(l))
            .filter((m): m is TranscriptMessage => m !== null)
        : (() => {
            const kind = this.manager.agentKind(session)
            return kind ? parseAgentIncrement(text, kind) : []
          })()
      cap.lastSize = size
      cap.cachedDelta = msgs
      return msgs
    } catch {
      return cap.cachedDelta ?? []
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
      const delta = this.captureDelta(session, cap)
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
      // 交付物门槛（2026-07-30 诊断 F2）：旧口径灯一离开 working 就当「回复完」，claude 系
      // 开工叙述在 text→tool_use 缝隙被抢收。新口径要求灯稳+transcript 稳连续 N 拍：
      // 像交付物 3 拍即收；弱文本（短句/开工白话）8 拍。60s 软超时只对已收工（灯非
      // working）会话兜底捕获——真短回复（如「好」）最迟超时收到；仍在干活则顺延。
      const working = session.trafficState === 'working'
      const stable = delta.length === cap.lastDeltaCount && text.length === cap.lastLen
      cap.settleTicks = !working && stable && text ? cap.settleTicks + 1 : 0
      cap.lastDeltaCount = delta.length
      cap.lastLen = text.length
      const settleNeed =
        looksLikeDeliverable(text) && !PROGRESS_OPENER_RE.test(text) ? CAPTURE_SETTLE_TICKS : CAPTURE_SETTLE_TICKS_WEAK
      const replyDone = cap.settleTicks >= settleNeed
      const deadlinePassed = now >= cap.deadlineAt
      const timeout = deadlinePassed && !working
      if (text && (replyDone || timeout)) {
        try {
          // 署名用会话当前实际模板名（防接手后代跑冒名，2026-07-29）；取不到回退成员名
          const captureFrom = this.manager.templateNameOf(session) ?? cap.memberName
          const stored = projectDb.send(cap.team, captureFrom, cap.fromName, text.slice(0, CAPTURE_TEXT_MAX))
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
      } else if (deadlinePassed) {
        if (working && now - cap.injectedAt < CAPTURE_HARD_MAX_MS) {
          // 灯还在 working = 干活中，此刻文本只是开工叙述/中途汇报，收走正是 F2 事故——
          // 顺延一个软超时窗，等真收工（灯落）那一拍捕获全量文本
          cap.deadlineAt = now + CAPTURE_TIMEOUT_MS
          log.info(`项目「${cap.roomName}」${cap.memberName} 仍在干活（灯 working），自动捕获顺延 ${CAPTURE_TIMEOUT_MS / 1000}s`)
        } else {
          // 已收工但始终无 assistant text（纯工具调用/静默），或顺延到硬上限（30min 仍
          // working 的马拉松/卡死会话）：清除条目防永久残留每拍重读 transcript；
          // 迟到交付由 caller 收口层（reconcile 迟到补收）兜底
          this.pendingCapture.delete(sid)
          log.info(
            `项目「${cap.roomName}」等待 ${cap.memberName} 回复超时，放弃自动捕获（${working ? '硬上限仍在干活' : '无文本'}）`
          )
        }
      }
    }
  }
}
