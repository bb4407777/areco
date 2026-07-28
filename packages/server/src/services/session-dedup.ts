/** native transcript 全局占用判断：所有在册卡片都保有所有权，退出不释放。 */
export function nativeSessionOccupied(
  sessions: ReadonlyArray<{ id: string; agentSessionId: string | null }>,
  currentSessionId: string,
  nativeId: string,
): boolean {
  return sessions.some((s) => s.id !== currentSessionId && s.agentSessionId === nativeId)
}

/** 双绑体检纯函数：多个会话同绑一个底层 nativeId 时，留 startedAt 最早的（原主），
 *  返回其余应解绑的会话 id（victim）。供 SessionManager.restore 启动体检调用，便于单测。
 *
 *  独立成模块（而非写在 session-manager.ts）是为了让单测不经 SessionManager 拖入
 *  @xterm/headless 的运行时依赖——纯逻辑不该被 pty/xterm 污染。
 *
 *  场景：旧占用闸只查 running 会话，会话「退出又恢复」会漏过双绑——A 绑底层 X → A 退 →
 *  B 绑 X（A 退时不占）→ A 恢复 → 两会话同绑 X；重启清 locateCache 后占用闸互斥、两边
 *  对话模式都空白（2026-07-27 2579f70e 与 b85b8b53 同绑 session_c385d78c 即此）。
 *  当前由 nativeSessionOccupied 覆盖全部在册卡；本函数继续清理升级前存量双绑。 */
export function duplicateBindingVictims(
  sessions: ReadonlyArray<{
    id: string
    agentSessionId: string | null
    startedAt: number | null
    createdAt: number
  }>,
): string[] {
  const byNative = new Map<string, Array<{ id: string; t: number }>>()
  for (const s of sessions) {
    if (!s.agentSessionId) continue
    const arr = byNative.get(s.agentSessionId)
    const entry = { id: s.id, t: s.startedAt ?? s.createdAt }
    if (arr) arr.push(entry)
    else byNative.set(s.agentSessionId, [entry])
  }
  const victims: string[] = []
  for (const group of byNative.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.t - b.t)
    for (const v of group.slice(1)) victims.push(v.id)
  }
  return victims
}
