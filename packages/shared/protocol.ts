// WS 协议与共享类型 —— server/client 两端唯一事实源。
// offset 单位 = UTF-16 code unit（node-pty onData 已是完整解码 string，两端计数天然一致）。
import type { TrafficState } from './traffic'

export const PROTOCOL_VERSION = 1

// 流控水位（字符数）
export const FLOW_HIGH_WATER = 256 * 1024
export const FLOW_LOW_WATER = 64 * 1024
// 高水位滞留超时：疑似假死连接（手机锁屏）强制 detach，防止拖死 pty
export const FLOW_STALL_MS = 15_000

export type SessionStatus = 'spawning' | 'running' | 'stopping' | 'exited' | 'error'

export type ExitReason = 'user-stop' | 'user-kill' | 'exit' | 'crash' | 'server-restart' | null

export interface Template {
  id: string
  name: string
  command: string
  args: string[]
  cwd: string
  color: string
  autoStart: boolean
  enabled: boolean
  /**
   * 该模板拉起的 claude 往哪个 HOME 写 transcript（包装器如 bin/c5 用 env -i 固定了隔离 HOME）。
   * 设了它模板即视为 claude 系：spawn 注入 --session-id/--resume、对话视图与历史恢复按此 HOME 定位。
   * command basename 为 claude 的模板不用设（默认服务进程 HOME）。
   */
  claudeHome?: string
}

export interface SessionSummary {
  id: string
  name: string
  /** 名字仍是自动命名（占位名 → 第一句话 → agent 原生标题/最新 prompt 演化）；手动 rename 后转 false 永久锁定 */
  autoNamed: boolean
  templateId: string
  command: string
  args: string[]
  cwd: string
  color: string
  status: SessionStatus
  pid: number | null
  epoch: number
  createdAt: number
  startedAt: number | null
  exitedAt: number | null
  exitCode: number | null
  exitReason: ExitReason
  /** 服务端维护的红绿灯状态；客户端只读，通过 sessionUpdate 实时推送。 */
  trafficState: TrafficState
  trafficUpdatedAt: number
  lastLine: string
  cols: number
  rows: number
  claudeSessionId: string | null
  claudeHome: string | null // claude transcript 所在 HOME（null = 服务进程 HOME 或非 claude 系）
  /** 非 claude agent 的原生会话 ID；首次确定性识别后持久化，后续禁止再按时间猜文件。 */
  agentSessionId: string | null
  /** 首条用户输入的规范化哈希，用于把新会话与 agent 原生日志精确绑定。 */
  agentBindingHash: string | null
  promptCount: number
  outputChars: number
  /** 已归档：不在看板默认视图展示，元数据/终端快照/对话日志全保留，可恢复 */
  archived: boolean
  /** 钉选为「总台」：一个常驻 agent 接全部项目房间；加成员列表置顶，改名不影响（2026-07-22） */
  pinned?: boolean
  /** 项目归属：项目内「新建 agent 进项目」spawn 时绑定的 room id；null/缺省 = 游离会话。
   *  删除项目时按此级联删专属会话（2026-07-22 维护者定：会话与项目强绑定） */
  roomId?: string | null
}

// ---- 客户端 → 服务端 ----

export interface AttachMsg {
  type: 'attach'
  sessionId: string
  cols: number
  rows: number
}
export interface DetachMsg {
  type: 'detach'
  sessionId: string
}
export interface InputMsg {
  type: 'input'
  sessionId: string
  data: string
}
export interface SendlineMsg {
  type: 'sendline'
  sessionId: string
  text: string
}
export interface ResizeMsg {
  type: 'resize'
  sessionId: string
  cols: number
  rows: number
}
// ack 用绝对 offset（幂等，无累计漂移）
export interface AckMsg {
  type: 'ack'
  sessionId: string
  offset: number
}

export type ClientMsg = AttachMsg | DetachMsg | InputMsg | SendlineMsg | ResizeMsg | AckMsg

// ---- 服务端 → 客户端 ----

export interface InitMsg {
  type: 'init'
  protocolVersion: number
  title: string
  version: string
  sessions: SessionSummary[]
  templates: Template[]
}
export interface SnapshotMsg {
  type: 'snapshot'
  sessionId: string
  epoch: number
  data: string
  offset: number
  cols: number
  rows: number
  live: boolean // false = exited 会话的落盘快照，之后不会有 output 流
}
export interface OutputMsg {
  type: 'output'
  sessionId: string
  epoch: number
  data: string
  offset: number // 该块末尾的累计位置
}
export interface SessionUpdateMsg {
  type: 'sessionUpdate'
  session: SessionSummary
}
export interface SessionRemovedMsg {
  type: 'sessionRemoved'
  sessionId: string
}
export interface ErrorMsg {
  type: 'error'
  code: string
  message: string
  sessionId?: string
}

export interface RoomMessageMsg {
  type: 'roomMessage'
  roomId: string
  message: RoomMessage
}
export interface RoomsMsg {
  type: 'rooms'
  rooms: RoomInfo[]
}
/** 房间调度状态推送：dispatch/delivery 有变化时全量推该房间的 dispatch 列表 */
export interface RoomDispatchesMsg {
  type: 'roomDispatches'
  roomId: string
  dispatches: RoomDispatchInfo[]
}

export type ServerMsg =
  | InitMsg
  | SnapshotMsg
  | OutputMsg
  | SessionUpdateMsg
  | SessionRemovedMsg
  | ErrorMsg
  | RoomMessageMsg
  | RoomsMsg
  | RoomDispatchesMsg

// ---- REST 统一响应 ----

export interface ApiOk<T> {
  ok: true
  data: T
}
export interface ApiErr {
  ok: false
  error: { code: string; message: string }
}
export type ApiResult<T> = ApiOk<T> | ApiErr

// ---- Transcript（Phase 2）----

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  // 文本段落与工具块的有序列表
  parts: TranscriptPart[]
  timestamp: string | null
}
export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input: string }
  | { kind: 'tool_result'; text: string; isError: boolean }
  // 系统注入正文（kimi 后台子 agent 回报/cron 触发等合成 user 消息）：展示归左侧，
  // 不算用户指令、不参与标题/命名取词（各消费方只读 text 段，天然跳过）
  | { kind: 'notice'; text: string }

export interface TranscriptPage {
  exists: boolean
  messages: TranscriptMessage[]
  cursor: number
  /** 尾页首载/向前翻页时给出：本页起始字节，「加载更早」传 before=start */
  start?: number
  /** start 之前还有更早内容 */
  hasMore?: boolean
}

// ---- 历史对话（Phase 3）：读盘浏览 ~/.claude/projects（reasonix 同构）的既往会话 ----

export interface HistoryEntry {
  source: string // 'claude' | 'kimi' | 'qclaw' | 隔离 HOME 分身名 | chatlog 层源名（codex/reasonix/cc-connect/workbuddy）
  project: string // claude 系是 projects/ 下的 cwd-slug 目录名；kimi 是 sessions/ 下的 wd_slug
  id: string // 会话 id（claude=文件名去 .jsonl；kimi=session_<uuid>；chatlog 层带源前缀如 codex-<uuid>）
  title: string // 最新 custom-title → 首条用户输入 → cwd basename
  cwd: string
  mtimeMs: number // 最后活动 = 文件 mtime
  createdMs: number // 0 = 未知
  size: number
  liveSessionId: string | null // 若属于看板中某会话（按 claudeSessionId / agentSessionId 匹配）
  resumable: boolean // 有对应模板可原生恢复（claude --resume / kimi -S / codex resume / codebuddy --resume / reasonix 选择器）
}

export interface HistoryListPage {
  entries: HistoryEntry[]
  total: number
  hasMore: boolean
}

// 字节区间 [start,end) 内解析出的消息；向前翻页传 before=start
export interface HistoryTranscriptPage {
  messages: TranscriptMessage[]
  start: number
  end: number
  hasMore: boolean
}

export interface StatsSummary {
  totalSessions: number
  runningSessions: number
  todayPromptCount: number
  todayOutputChars: number
  todayRuntimeMs: number
}

/** 对话模式「终端尾屏」：GET /api/sessions/:id/screen 响应体 */
export interface ScreenTailPayload {
  lines: string[]
}

// ---- 项目协作（Phase 6）：项目 = 人 + 活会话成员；消息 SoT 在服务端 projects.db（team=room-<id>） ----

export interface RoomMember {
  /** 成员名（@mention/花名册用）：人类 = config.humanName（默认 Owner）；会话成员 = 模板名（房内唯一，重名自动 ·2） */
  name: string
  kind: 'human' | 'session'
  /** kind=session 绑定的会话；会话退出后保留（界面示离线），名字仍可被 @（只落库不投递） */
  sessionId: string | null
}

export interface RoomInfo {
  id: string
  name: string
  /** 消息库的 team 段（room-<id>，与项目 id 对应，改名不受影响） */
  team: string
  createdAt: number
  /** 归档时间；null = 当前项目。归档项目保留成员快照和消息，只读且不参与消息投递。 */
  archivedAt: number | null
  /** 房间调度模式（2026-07-22）：parallel=全员即注；serial=串行轮转一次只放行一位成员（默认，旧 rooms.json 读取时补此值）；claim=认领制（先报认领、原子批准唯一 Implementer） */
  dispatchMode: 'parallel' | 'serial' | 'claim'
  /** 绑定的 git 仓库绝对路径（可空）：claim 模式赢家获批时自动开工作区；旧 rooms.json 读取时补 null */
  repoPath: string | null
  /** 项目/案件文件根目录（可空）：Files 只读浏览的唯一根，不从成员 cwd 推断。 */
  rootPath: string | null
  /** 最后一条消息时间（ISO，服务端列表时从 projects.db 注入；无消息缺省）。前端按它排序房间，不回写 rooms.json */
  lastMessageAt?: string | null
  members: RoomMember[]
}

export interface RoomMessage {
  id: number
  roomId: string
  from: string
  to: string
  body: string
  createdAt: string
  /** 白名单 agent 转述维护者原话的标记（署名仍是 agent）；服务端按人类语义投递 */
  humanRelay?: boolean
}

/** 项目只读文件树节点；path 是服务端 realpath 核验后的绝对路径。 */
export interface ProjectFileNode {
  name: string
  path: string
  relativePath: string
  kind: 'directory' | 'file'
  size: number | null
  mtimeMs: number
}

export interface ProjectFileList {
  rootPath: string
  directory: string
  items: ProjectFileNode[]
  truncated: boolean
}

// ---- 房间调度（确定性轮转，2026-07-22）：底账在 projects.db 的 dispatch/delivery 表 ----

export type DispatchMode = 'parallel' | 'serial' | 'claim'
export type DispatchState = 'active' | 'done' | 'cancelled'
export type DeliveryStatus = 'queued' | 'injected' | 'working' | 'replied' | 'done' | 'timeout' | 'cancelled' | 'failed'
/** claim 模式阶段：claiming=全员报认领中；implementing=已有赢家在实施；done=收单 */
export type DispatchPhase = 'claiming' | 'implementing' | 'done'

export interface RoomDeliveryInfo {
  id: number
  dispatchId: number
  memberName: string
  sessionId: string | null
  status: DeliveryStatus
  attempt: number
  /** 注入回显 nonce（injectNote 每次注入生成），用于把投递与终端回显关联 */
  correlationId: string | null
  createdAt: string
  updatedAt: string
}

export interface RoomDispatchInfo {
  id: number
  team: string
  /** 触发本次调度的根消息 id（幂等键：同一根消息重复建单返回既有行） */
  rootMessageId: number
  mode: DispatchMode
  state: DispatchState
  /** serial：当前放行成员名（parallel 恒 null） */
  currentTarget: string | null
  /** serial：当前放行成员的回复截止时间（ISO 文本） */
  deadline: string | null
  maxDepth: number
  cancelReason: string | null
  /** claim：当前阶段（parallel/serial 恒 null） */
  phase: DispatchPhase | null
  /** claim：赢家成员名（未认领为 null） */
  implementer: string | null
  /** claim：认领截止时间（ISO 文本） */
  claimDeadline: string | null
  /** claim：赢家获批时自动开的 git 工作区绝对路径（未绑 repo 或创建失败为 null） */
  worktreePath: string | null
  /** claim：工作区分支名 */
  branch: string | null
  createdAt: string
  updatedAt: string
  deliveries: RoomDeliveryInfo[]
}

/** 合并干跑预检结果（git merge-tree --write-tree，不动任何工作区/分支） */
export interface MergeCheckInfo {
  clean: boolean
  conflicts: string[]
  message: string
}

// ---- 文件预览（Phase 4）：白名单内本地产物在手机上预览 ----

/** 预览呈现方式：前端据此选渲染器 */
export type PreviewKind =
  | 'pdf' // 直接内嵌 <iframe>
  | 'image' // <img>
  | 'html' // sandbox <iframe>
  | 'text' // <pre> 拉原文
  | 'video' // <video>（服务端支持 Range）
  | 'convert-pdf' // docx/doc/xlsx/ppt 等：raw?as=pdf 现转
  | 'download' // 无法预览，仅下载

export interface FileMeta {
  path: string // 规范化后的绝对路径（realpath）
  name: string
  size: number
  mimeType: string
  ext: string
  preview: PreviewKind
  mtimeMs: number
}
