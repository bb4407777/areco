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
