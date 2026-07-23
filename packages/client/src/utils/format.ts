import type { ExitReason, SessionStatus } from '../../../shared/protocol'
import type { TrafficState } from '../../../shared/traffic'

export function fmtUptime(ms: number): string {
  if (ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export const STATUS_TEXT: Record<SessionStatus, string> = {
  spawning: '启动中',
  running: '运行中',
  stopping: '停止中',
  exited: '已退出',
  error: '错误',
}

export const EXIT_REASON_TEXT: Record<Exclude<ExitReason, null>, string> = {
  'user-stop': '手动停止',
  'user-kill': '强制终止',
  exit: '正常退出',
  crash: '异常退出',
  'server-restart': '服务重启导致退出',
}

/** 侧边栏红绿灯色 */
export function trafficColor(state: TrafficState | undefined, status?: SessionStatus): string {
  if (state === 'exited' || (!state && (status === 'exited' || status === 'error'))) return '#6b7280'
  if (state === 'needs-user') return '#eab308' // 需处理 → 黄
  if (state === 'idle' || state === 'conclusion') return '#22c55e' // 空闲就绪 / 出结论 → 绿
  return '#ef4444'                             // 运行中 → 红
}

/** 路径缩略：家目录换 ~，过长取中段省略 */
export function shortPath(p: string, max = 38): string {
  let value = p.replace(/^\/Users\/[^/]+/, '~')
  if (value.length > max) {
    const head = value.slice(0, Math.floor(max / 2) - 1)
    const tail = value.slice(-(Math.ceil(max / 2) - 2))
    value = `${head}…${tail}`
  }
  return value
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 会话的 agent/模型标签：模板名（约定模板名里带模型，如「Kimi K3」）；模板已删则退回命令名 */
export function templateLabel(
  session: { templateId: string; command: string },
  templates?: Array<{ id: string; name: string }>
): string {
  const tpl = templates?.find((t) => t.id === session.templateId)
  return tpl?.name ?? session.command.split('/').pop() ?? ''
}

/** 会话所属模板的颜色（本源 template.color，改模板即全变）；模板已删退回中性灰 */
export function templateColor(
  session: { templateId: string },
  templates?: Array<{ id: string; color: string }>
): string {
  return templates?.find((t) => t.id === session.templateId)?.color ?? '#7d8590'
}

/** 历史会话 source（agent 来源）→ 颜色：优先匹配 areco 模板取 template.color（与活会话同色），否则按 source 稳定取兜底色 */
const SOURCE_FALLBACK = ['#a371f7', '#79c0ff', '#56d364', '#ffa657', '#f778ba', '#e3b341', '#d2a8ff', '#7d8590']
function hashSource(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
export function sourceColor(
  source: string,
  templates?: Array<{ id: string; name: string; command: string; color: string }>
): string {
  const key = source.toLowerCase()
  const byCmd = templates?.find((t) => (t.command.split('/').pop() ?? '').toLowerCase() === key)
  if (byCmd) return byCmd.color
  const byName = templates?.find((t) => t.name.toLowerCase().includes(key))
  if (byName) return byName.color
  return SOURCE_FALLBACK[hashSource(source) % SOURCE_FALLBACK.length]
}

/** 座舱有对话视图的会话：claude 系（结构化 transcript），或直读自家落盘的 agent */
const CHAT_CAPABLE_COMMANDS = new Set(['codex', 'codebuddy', 'reasonix', 'kimi'])

export function chatCapable(
  session: { claudeSessionId: string | null; command: string; templateId: string },
  templates?: Array<{ id: string; claudeHome?: string }>
): boolean {
  if (session.claudeSessionId) return true
  const base = session.command.split('/').pop() ?? ''
  if (CHAT_CAPABLE_COMMANDS.has(base)) return true
  // claude 包装器会话缺 claudeSessionId（模板 claudeHome 曾丢失）：模板配了 claudeHome 即可走服务端窗口定位
  return Boolean(templates?.find((t) => t.id === session.templateId)?.claudeHome)
}

/**
 * 按显示偏好算会话落点路由：view 为 chat 且会话有落盘 transcript 可读 → /chat，否则终端页。
 * 看板/侧栏点卡片（sessionView）与新建会话（newSessionView）共用这一份判断，别在调用处复制
 */
export function sessionEntryPath(
  id: string,
  session: { claudeSessionId: string | null; command: string; templateId: string } | null | undefined,
  templates: Array<{ id: string; claudeHome?: string }> | undefined,
  view: 'terminal' | 'chat'
): string {
  const chat = view === 'chat' && !!session && chatCapable(session, templates)
  return chat ? `/session/${id}/chat` : `/session/${id}`
}
