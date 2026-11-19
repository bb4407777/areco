// bot 名册：桌面左栏与手机看板共用同一份状态（模块级 ref，任一侧刷新另一侧跟着变）。
// 呈现只做「会话那一套」：状态点 + 名字 + 模板名 + 状态；这里只出数据与文案，不碰界面。
import { ref } from 'vue'
import { api } from '../api'
import { fmtTime, shortPath, trafficColor } from '../utils/format'

export interface Bot {
  id: string
  name: string
  kind: string
  identity: string
  cwd: string
  templateId: string
  channel: string
  sessionId: string | null
  todoCount: number
  pinned: boolean
  createdAt: number
  lastActiveAt: number
  status: string
  trafficState: string
  lastLine: string
  sessionName: string
  /** 只读历史：旧会话 id（睡着时点开看过去，发第一句按对话层交接开新会话） */
  historyFrom?: string | null
  /** 旧会话的原始身份（会话记录被清理后仍能读历史） */
  history?: {
    sessionId: string
    name?: string
    agentSessionId?: string | null
  } | null
  /** 该 bot 名下的 OPC 任务（后台看板路由过来，不落盘） */
  opc?: {
    running: number
    ready: number
    blocked: number
    doneToday: number
    tasks: {
      id: string
      title: string
      status: string
      rawStatus: string
      assignee: string
      updatedAt: number
      event?: string
      note?: string
    }[]
  }
  /** 名下待办标题（前 12 条，实时从 todos.json 算） */
  todos?: string[]
  /** 引用到的会话：primary＝主归属（唯一），其余为同源引用，只借上下文 */
  refs?: { id: string; name: string; primary: boolean }[]
}

export const KIND_LABEL: Record<string, string> = {
  case: '案件',
  person: '关系',
  function: '职能',
  channel: '通道',
  other: '其他',
}

export const bots = ref<Bot[]>([])

export async function loadBots(): Promise<void> {
  try {
    const res = await api.get<{ bots: Bot[] }>('/api/bots')
    bots.value = res.bots
  } catch {
    /* 服务重启期静默，下次轮询再试 */
  }
}

/** 有待办亮橙；睡着灰；在线沿用会话红绿灯 */
export function botDotColor(bot: Bot): string {
  if (bot.todoCount > 0) return '#f59e0b'
  if (bot.sessionId) return trafficColor(bot.trafficState as never, bot.status as never)
  return '#9ca3af'
}

/** OPC 一行人话：跑 1 · 待 2；没有任务返回空串 */
export function botOpcLine(bot: Bot): string {
  const o = bot.opc
  if (!o) return ''
  const bits: string[] = []
  if (o.running) bits.push(`跑 ${o.running}`)
  if (o.ready) bits.push(`待 ${o.ready}`)
  if (o.blocked) bits.push(`卡 ${o.blocked}`)
  if (!bits.length) return ''
  return `OPC ${bits.join(' · ')}`
}

export function botStatusText(bot: Bot): string {
  if (bot.todoCount > 0) return `${bot.todoCount} 项待办`
  if (bot.status === 'running' || bot.status === 'spawning') return '在线'
  if (bot.status === 'asleep' || !bot.sessionId) return '睡着'
  if (bot.status === 'exited') return fmtTime(bot.lastActiveAt)
  return bot.status
}

/** 副题一行：有身份写「类型 · 身份」，没身份退回工作目录（新建 bot 不再强制填身份） */
export function botSubtitle(bot: Bot): string {
  const kind = KIND_LABEL[bot.kind] ?? bot.kind
  if (bot.identity) return `${kind} · ${bot.identity}`
  return bot.cwd ? shortPath(bot.cwd, 30) : kind
}
