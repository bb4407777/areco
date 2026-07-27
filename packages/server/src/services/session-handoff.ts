// 看板会话交接的“读源 + 首条 prompt 投递能力”唯一口径。
// transcript 端点与交接必须对 claude / 原生 agent / qoder 等 transcriptDir 衍生 CLI 同构。
import fs from 'node:fs'
import path from 'node:path'
import type { Template, TranscriptMessage } from '../../../shared/protocol'
import { agentKindOf, locateClaudeLayoutTranscript, locateClaudeTranscript, readAgentAllMessages } from './agent-transcript'
import { readHistoryAllMessages } from './history'
import type { Session } from './session'
import { effectiveClaudeHome } from './templates'
import { transcriptPath } from './transcript'

/** CLI 能把最后一个位置参数当首条 prompt；优先走参数，避免 TUI 首屏/信任页吞键盘注入。 */
export function acceptsInitialPromptArg(template: Template): boolean {
  const commandBase = path.basename(template.command)
  return (
    effectiveClaudeHome(template) !== null ||
    Boolean(template.transcriptDir?.trim()) ||
    commandBase === 'codex' ||
    commandBase === 'qoderclicn'
  )
}

/** sessionHandoff 用全量读取：顺序与 transcript 端点一致，原生 agent 必须先于 transcriptDir。 */
export function readSessionHandoffMessages(session: Session, template?: Template): TranscriptMessage[] {
  const kind = agentKindOf(session.command)
  if (session.claudeSessionId) {
    const filePath = transcriptPath(session)
    return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
  }
  if (kind) return readAgentAllMessages(session, kind)
  if (session.transcriptDir) {
    const filePath = locateClaudeLayoutTranscript(session, session.transcriptDir)
    return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
  }
  const home = template ? effectiveClaudeHome(template) : null
  const filePath = home ? locateClaudeTranscript(session, home) : null
  return filePath && fs.existsSync(filePath) ? readHistoryAllMessages(filePath) : []
}
