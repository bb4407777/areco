// 看板会话交接的“读源 + 首条 prompt 投递能力”唯一口径。
// transcript 端点与交接必须对 claude / 原生 agent / qoder 等 transcriptDir 衍生 CLI 同构。
import fs from 'node:fs'
import path from 'node:path'
import type { Template, TranscriptMessage } from '../../../shared/protocol'
import {
  agentKindOf,
  locateClaudeLayoutTranscript,
  locateClaudeTranscript,
  readAgentAllMessages,
  type AgentKind,
} from './agent-transcript'
import { readHistoryAllMessages } from './history'
import { isHermesTemplate, readHermesHandoffMessages } from './hermes-handoff'
import type { Session } from './session'
import { effectiveClaudeHome } from './templates'
import { transcriptPath } from './transcript'

/** CLI 能把最后一个位置参数当首条 prompt；优先走参数，避免 TUI 首屏/信任页吞键盘注入。 */
export function acceptsInitialPromptArg(template: Template): boolean {
  const commandBase = path.basename(template.command)
  return (
    effectiveClaudeHome(template) !== null ||
    template.harness === 'codex' ||
    template.harness === 'qoder' ||
    template.harness === 'workbuddy' ||
    commandBase === 'codex' ||
    commandBase === 'qoderclicn' ||
    commandBase === 'codebuddy'
  )
}

/**
 * Session 里保留的是模板原始 command；harness-first 模板实际执行命令可能完全不同。
 * 例如 reasonix-stand 包装器最终 exec reasonix，不能只按 basename(session.command) 判源。
 */
export function handoffAgentKind(session: Session, template?: Template): AgentKind | null {
  const direct = agentKindOf(session.command, template?.harness)
  if (direct) return direct
  if (path.basename(session.command).startsWith('reasonix-')) return 'reasonix'
  return null
}

/** sessionHandoff 用全量读取：顺序与 transcript 端点一致，原生 agent 必须先于 transcriptDir。 */
export function readSessionHandoffMessages(session: Session, template?: Template): TranscriptMessage[] {
  const kind = handoffAgentKind(session, template)
  if (session.claudeSessionId) {
    const filePath = transcriptPath(session)
    return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
  }
  if (kind) return readAgentAllMessages(session, kind)
  if (session.transcriptDir) {
    const filePath = locateClaudeLayoutTranscript(session, session.transcriptDir)
    return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
  }
  if (template && isHermesTemplate(template)) return readHermesHandoffMessages(session, template)
  const home = template ? effectiveClaudeHome(template) : null
  const filePath = home ? locateClaudeTranscript(session, home) : null
  return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
}
