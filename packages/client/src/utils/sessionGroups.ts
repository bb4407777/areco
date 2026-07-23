// 会话按项目分组（2026-07-22 维护者定，桌面侧栏与手机看板共用同一套分组规则）：
// 非归档项目里有看板会话成员的收进该项目分组；同一会话挂多个项目归第一个（防重复）；
// 组内与零散区的顺序一律跟随传入的 sessions（调用方传 sessions store 的 boardSessions，
// 即「运行优先 + 最后活动倒序」）——有新回复的会话在组内同样浮到最前。
import type { RoomInfo, SessionSummary } from '../../../shared/protocol'

export interface SessionGroup {
  id: string
  name: string
  sessions: SessionSummary[]
}

export interface SessionGrouping {
  groups: SessionGroup[]
  /** 未归入任何项目分组的会话（零散区，保持传入顺序） */
  loose: SessionSummary[]
}

export function groupSessionsByRoom(rooms: RoomInfo[], sessions: SessionSummary[]): SessionGrouping {
  // 第一遍：定归属（房间成员表为准，先到先得）
  const roomOf = new Map<string, { id: string; name: string }>()
  for (const room of rooms) {
    if (room.archivedAt !== null) continue
    for (const m of room.members) {
      if (m.kind === 'session' && m.sessionId && !roomOf.has(m.sessionId)) {
        roomOf.set(m.sessionId, { id: room.id, name: room.name })
      }
    }
  }
  // 第二遍：按传入顺序装桶，天然继承「最后活动倒序」
  const byRoom = new Map<string, SessionGroup>()
  const loose: SessionSummary[] = []
  for (const s of sessions) {
    const room = s.archived ? undefined : roomOf.get(s.id)
    if (!room) {
      loose.push(s)
      continue
    }
    let g = byRoom.get(room.id)
    if (!g) {
      g = { id: room.id, name: room.name, sessions: [] }
      byRoom.set(room.id, g)
    }
    g.sessions.push(s)
  }
  // 分组顺序跟随房间表顺序（rooms.json 即用户心中的项目次序）
  const groups: SessionGroup[] = []
  for (const room of rooms) {
    const g = byRoom.get(room.id)
    if (g) groups.push(g)
  }
  return { groups, loose }
}
