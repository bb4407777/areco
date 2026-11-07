import type { TranscriptMessage } from '../../../shared/protocol'

/**
 * 对话模式的可见性过滤：思考/工具调用/工具结果默认关，服务端先把「整条都看不见」的消息剔掉，
 * 再按可见条数分页——否则一页 80 条里可能 75 条是折叠块，前端只剩空白，
 * 只能靠反复「加载更早」找内容（2026-11-07 报障）。
 */
export interface VisibilityPrefs {
  /** 保留 thinking 段 */
  thinking: boolean
  /** 保留普通 tool_use 段（AskUserQuestion 类询问始终保留：要渲染成可点选项卡片） */
  toolUse: boolean
  /** 保留 tool_result 段 */
  toolResult: boolean
}

/** hide=thinking,tool_use,tool_result → 对应类别隐藏；不传/空 = 全部可见（不启用补页） */
export function parseHideParam(raw: unknown): VisibilityPrefs | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  const hidden = new Set(text.split(',').map((s) => s.trim()))
  return {
    thinking: !hidden.has('thinking'),
    toolUse: !hidden.has('tool_use'),
    toolResult: !hidden.has('tool_result'),
  }
}

const ASK_MARKERS = ['askuserquestion', 'ask_user_question', 'request_user_input', 'requestuserinput']

export function messageVisible(message: TranscriptMessage, prefs: VisibilityPrefs): boolean {
  for (const part of message.parts) {
    if (part.kind === 'thinking') {
      if (prefs.thinking) return true
    } else if (part.kind === 'tool_use') {
      const name = String(part.name ?? '').toLowerCase()
      if (ASK_MARKERS.some((x) => name.includes(x))) return true
      if (prefs.toolUse) return true
    } else if (part.kind === 'tool_result') {
      if (prefs.toolResult) return true
    } else {
      return true
    }
  }
  return false
}

export function countVisible(
  messages: TranscriptMessage[],
  from: number,
  to: number,
  prefs: VisibilityPrefs
): number {
  let n = 0
  for (let i = from; i < to; i++) if (messageVisible(messages[i], prefs)) n += 1
  return n
}
