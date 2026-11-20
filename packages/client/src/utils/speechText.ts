import type { RoomMessage, TranscriptMessage } from '../../../shared/protocol'

/** 只读 Assistant 正式 text 段；notice/thinking/tool/tool_result 一律不读。 */
export function transcriptSpeechText(message: TranscriptMessage): string {
  if (message.role !== 'assistant') return ''
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/** 房间只读非本人、非 humanRelay 的 Agent 正文。 */
export function roomSpeechText(message: RoomMessage, humanName: string): string {
  if (message.from === humanName || message.humanRelay) return ''
  return message.body.trim()
}

function hash32(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Transcript 暂无服务端 messageId：用会话、角色与时间戳生成去重键。
 *
 * 正文不进键：同一条回复在流式过程中会被读到多次，正文一变键就变，
 * 后半段会被当成新消息整条重念（2026-11-20 高律师报障「重复了几句」）。
 * 没有时间戳的才退回正文哈希——那种情况宁可重念也不能漏念。
 */
export function transcriptSpeechId(sessionId: string, message: TranscriptMessage): string {
  const at = message.timestamp
  if (at) return `transcript:${sessionId}:${message.role}:${at}`
  return `transcript:${sessionId}:${hash32(`${message.role}\n${transcriptSpeechText(message)}`)}`
}

export function roomSpeechId(message: RoomMessage): string {
  return `room:${message.roomId}:${message.id}`
}

/** 首载/翻页只进基线；working 完成时返回新增或续写过的正式 Assistant 文本。 */
export class TranscriptSpeechTracker {
  private ready = false
  /** 键 → 已进基线时的正文。正文变长（续写）时要把全文再交一次，由播报队列只念新增的尾巴。 */
  private baseline = new Map<string, string>()

  invalidate() {
    this.ready = false
    this.baseline.clear()
  }

  reset(sessionId: string, messages: TranscriptMessage[]) {
    this.ready = true
    this.baseline = new Map(
      messages.map((message) => [transcriptSpeechId(sessionId, message), transcriptSpeechText(message)]),
    )
  }

  begin(sessionId: string, messages: TranscriptMessage[]) {
    if (!this.ready) this.reset(sessionId, messages)
    else this.addBaseline(sessionId, messages)
  }

  addBaseline(sessionId: string, messages: TranscriptMessage[]) {
    for (const message of messages) {
      this.baseline.set(transcriptSpeechId(sessionId, message), transcriptSpeechText(message))
    }
  }

  complete(sessionId: string, messages: TranscriptMessage[]): { messageId: string; text: string }[] {
    if (!this.ready) {
      this.reset(sessionId, messages)
      return []
    }
    const out: { messageId: string; text: string }[] = []
    for (const message of messages) {
      const messageId = transcriptSpeechId(sessionId, message)
      const text = transcriptSpeechText(message)
      if (this.baseline.get(messageId) === text) continue
      this.baseline.set(messageId, text)
      if (text) out.push({ messageId, text })
    }
    return out
  }
}
