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

/** Transcript 暂无服务端 messageId：用会话、时间戳与正文生成稳定去重键。 */
export function transcriptSpeechId(sessionId: string, message: TranscriptMessage): string {
  return `transcript:${sessionId}:${hash32(`${message.timestamp ?? ''}\n${transcriptSpeechText(message)}`)}`
}

export function roomSpeechId(message: RoomMessage): string {
  return `room:${message.roomId}:${message.id}`
}

/** 首载/翻页只进基线；只有 working 完成时返回本轮新增的正式 Assistant 文本。 */
export class TranscriptSpeechTracker {
  private ready = false
  private baseline = new Set<string>()

  invalidate() {
    this.ready = false
    this.baseline.clear()
  }

  reset(sessionId: string, messages: TranscriptMessage[]) {
    this.ready = true
    this.baseline = new Set(messages.map((message) => transcriptSpeechId(sessionId, message)))
  }

  begin(sessionId: string, messages: TranscriptMessage[]) {
    if (!this.ready) this.reset(sessionId, messages)
    else this.addBaseline(sessionId, messages)
  }

  addBaseline(sessionId: string, messages: TranscriptMessage[]) {
    for (const message of messages) this.baseline.add(transcriptSpeechId(sessionId, message))
  }

  complete(sessionId: string, messages: TranscriptMessage[]): { messageId: string; text: string }[] {
    if (!this.ready) {
      this.reset(sessionId, messages)
      return []
    }
    const out: { messageId: string; text: string }[] = []
    for (const message of messages) {
      const messageId = transcriptSpeechId(sessionId, message)
      if (this.baseline.has(messageId)) continue
      this.baseline.add(messageId)
      const text = transcriptSpeechText(message)
      if (text) out.push({ messageId, text })
    }
    return out
  }
}
