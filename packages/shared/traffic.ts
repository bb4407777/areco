import type { TranscriptMessage } from './protocol'

export type TrafficState = 'idle' | 'working' | 'conclusion' | 'needs-user' | 'exited'

const USER_INPUT_TOOLS = new Set([
  'askuserquestion',
  'ask_user_question', // qclaw(openclaw) 的提问工具名
  'request_user_input',
  'requestuserinput',
])

/** claude 系 Esc/Ctrl-C 中断落盘的用户占位文本：turn 已终止、会话在等输入，不是工作中 */
const INTERRUPT_TEXT = /^\[Request interrupted by user/

export function terminalInputStartsTask(data: string): boolean {
  return data.includes('\r') || data.includes('\n')
}

/**
 * claude 权限框/信任页等终端内对话框的特征文本（这些 UI 只画在 TUI 里、不落 transcript）。
 * 注意不收「bypass permissions」——bypass 模式的状态栏常驻该行（shift+tab 可切换），
 * 收了它所有 bypass 会话常年黄灯（2026-07-24 误报）；权限框靠标题行/「don't ask again」选项行识别已足够
 */
const PENDING_CHOICE_RE = /do you want to|don'?t ask again|do you trust the files/i

/**
 * 尾屏是否停在选择/确认对话框：transcript 照不到的终端内 UI（权限框、信任页），
 * 红绿灯的黄灯只能靠影子终端尾屏检出（2026-07-24 areco-voice 权限框不变黄灯报障）
 */
export function screenHasPendingChoice(lines: string[]): boolean {
  return PENDING_CHOICE_RE.test(lines.join('\n'))
}

export function trafficStateFromMessages(messages: TranscriptMessage[]): Exclude<TrafficState, 'exited'> {
  const last = messages.at(-1)
  if (!last) return 'idle'
  if (
    last.parts.some(
      (part) => part.kind === 'tool_use' && USER_INPUT_TOOLS.has(part.name.toLowerCase())
    )
  ) {
    return 'needs-user'
  }
  if (
    last.role === 'user' &&
    last.parts.some((part) => part.kind === 'text' && INTERRUPT_TEXT.test(part.text.trim()))
  ) {
    return 'needs-user'
  }
  const hasText = last.parts.some((part) => part.kind === 'text' && part.text.trim())
  const hasToolUse = last.parts.some((part) => part.kind === 'tool_use')
  return last.role === 'assistant' && hasText && !hasToolUse ? 'conclusion' : 'working'
}
