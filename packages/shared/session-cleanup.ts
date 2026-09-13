import type { SessionSummary } from './protocol'

/**
 * 「一键清理」唯一范围：仍在看板、且服务端已确认退出的会话。
 * 已归档会话用于保留历史；error 可能需要排障；任何活跃状态都不得批量删除。
 */
export function isExitedSessionCleanupCandidate(
  session: Pick<SessionSummary, 'archived' | 'status'>,
): boolean {
  return !session.archived && session.status === 'exited'
}
