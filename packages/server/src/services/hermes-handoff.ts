// Hermes CLI 会话不落 JSONL，真身在 $HERMES_HOME/state.db 的 sessions/messages 表。
// 本文件只负责 Areco 会话交接读取；微信 gateway 会话与 cron 会话不参与座舱卡片绑定。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Template, TranscriptMessage, TranscriptPart } from '../../../shared/protocol'
import type { Session } from './session'

const BIRTH_SLACK_SECONDS = 60

export function isHermesTemplate(template?: Template): boolean {
  if (!template) return false
  if (template.harness === 'hermes' || path.basename(template.command) === 'hermes') return true
  return template.args.some((arg) => path.basename(arg) === 'hermes')
}

export function hermesHomeOf(template: Template, homeDir = os.homedir()): string {
  const explicit = template.args.find((arg) => arg.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length).trim()
  return explicit || process.env.HERMES_HOME?.trim() || path.join(homeDir, '.hermes')
}

function contentPart(role: string, content: string, toolName: string): TranscriptPart | null {
  if (!content) return null
  if (role === 'tool') return { kind: 'tool_result', text: content, isError: false }
  if (role === 'assistant' && toolName) return { kind: 'tool_use', name: toolName, input: content }
  return { kind: 'text', text: content }
}

/** 按原生 id 优先，否则用 cwd + Areco 进程生命周期定位对应的 Hermes CLI 会话。 */
export function readHermesHandoffMessages(session: Session, template: Template): TranscriptMessage[] {
  const dbPath = path.join(hermesHomeOf(template), 'state.db')
  if (!fs.existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    let nativeId = session.agentSessionId
    if (!nativeId) {
      const started = (session.startedAt ?? session.createdAt) / 1000
      const ended = (session.isRunning ? Date.now() : (session.exitedAt ?? Date.now())) / 1000
      const row = db
        .prepare(
          `SELECT id FROM sessions
             WHERE source = 'cli' AND cwd = ? AND message_count > 0
               AND started_at >= ? AND started_at <= ?
             ORDER BY started_at DESC LIMIT 1`,
        )
        .get(session.cwd, started - BIRTH_SLACK_SECONDS, ended + BIRTH_SLACK_SECONDS) as { id?: unknown } | undefined
      nativeId = typeof row?.id === 'string' ? row.id : null
      if (nativeId) session.bindAgentSession(nativeId)
    }
    if (!nativeId) return []

    const rows = db
      .prepare(
        `SELECT role, content, reasoning, tool_name, timestamp
           FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`,
      )
      .all(nativeId) as Array<Record<string, unknown>>
    const out: TranscriptMessage[] = []
    for (const row of rows) {
      const role = String(row.role ?? '')
      const transcriptRole = role === 'user' || role === 'tool' ? 'user' : 'assistant'
      const parts: TranscriptPart[] = []
      const reasoning = typeof row.reasoning === 'string' ? row.reasoning.trim() : ''
      if (reasoning) parts.push({ kind: 'thinking', text: reasoning })
      const part = contentPart(
        role,
        typeof row.content === 'string' ? row.content.trim() : '',
        typeof row.tool_name === 'string' ? row.tool_name : '',
      )
      if (part) parts.push(part)
      if (!parts.length) continue
      const ts = Number(row.timestamp)
      out.push({
        role: transcriptRole,
        parts,
        timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
      })
    }
    return out
  } finally {
    db.close()
  }
}
