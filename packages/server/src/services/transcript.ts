// Transcript 读盘重建：不解析终端流，读 Claude Code 自己写的
// ~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl，按字节 cursor 增量、只消费完整行。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { TranscriptMessage, TranscriptPage, TranscriptPart } from '../../../shared/protocol'
import type { Session } from './session'

const MAX_PART_TEXT = 20_000
const MAX_TOOL_INPUT = 2_000

/** Claude Code 的 cwd→项目目录名规则：非字母数字全部替换为 -（本机实测） */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(session: Session): string | null {
  if (!session.claudeSessionId) return null
  // c5 这类包装器模板固定了隔离 HOME（session.claudeHome），transcript 在那边而非服务进程 HOME
  const home = session.claudeHome || os.homedir()
  return path.join(home, '.claude', 'projects', cwdToSlug(session.cwd), `${session.claudeSessionId}.jsonl`)
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const o = item as { type?: string; text?: string }
        return o?.type === 'text' && typeof o.text === 'string' ? o.text : ''
      })
      .join('')
  }
  return ''
}

export function parseTranscriptLine(raw: string): TranscriptMessage | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const type = obj.type
  if (type !== 'user' && type !== 'assistant') return null
  if (obj.isSidechain === true || obj.isMeta === true) return null
  const message = obj.message as { content?: unknown } | undefined
  const content = message?.content
  const parts: TranscriptPart[] = []

  if (typeof content === 'string') {
    if (content.trim()) parts.push({ kind: 'text', text: content.slice(0, MAX_PART_TEXT) })
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const o = item as Record<string, unknown>
      switch (o.type) {
        case 'text': {
          const text = String(o.text ?? '')
          if (text.trim()) parts.push({ kind: 'text', text: text.slice(0, MAX_PART_TEXT) })
          break
        }
        case 'thinking': {
          const text = String(o.thinking ?? '')
          if (text.trim()) parts.push({ kind: 'thinking', text: text.slice(0, MAX_PART_TEXT) })
          break
        }
        case 'tool_use': {
          let input = ''
          try {
            input = JSON.stringify(o.input, null, 2) ?? ''
          } catch {
            input = String(o.input)
          }
          parts.push({ kind: 'tool_use', name: String(o.name ?? 'tool'), input: input.slice(0, MAX_TOOL_INPUT) })
          break
        }
        case 'tool_result': {
          const text = textOf(o.content)
          parts.push({
            kind: 'tool_result',
            text: (text || '（空结果）').slice(0, MAX_TOOL_INPUT),
            isError: o.is_error === true,
          })
          break
        }
      }
    }
  }

  if (!parts.length) return null
  return {
    role: type,
    parts,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
  }
}

/** 从字节 cursor 起增量读取；只消费到最后一个换行符，未完整的尾行留待下轮 */
export function readTranscript(session: Session, cursor: number): TranscriptPage {
  return readTranscriptFile(transcriptPath(session), cursor)
}

/** 同 readTranscript，但直接给文件路径（供窗口定位的 fallback 复用） */
export function readTranscriptFile(filePath: string | null, cursor: number): TranscriptPage {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, messages: [], cursor: 0 }
  }
  const size = fs.statSync(filePath).size
  const from = Math.max(0, Math.min(cursor, size))
  if (size <= from) return { exists: true, messages: [], cursor: from }

  const fd = fs.openSync(filePath, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
  } finally {
    fs.closeSync(fd)
  }

  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < 0) return { exists: true, messages: [], cursor: from }
  const consumed = buf.subarray(0, lastNewline + 1).toString('utf8')

  const messages: TranscriptMessage[] = []
  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue
    const msg = parseTranscriptLine(line)
    if (msg) messages.push(msg)
  }
  return { exists: true, messages, cursor: from + lastNewline + 1 }
}
