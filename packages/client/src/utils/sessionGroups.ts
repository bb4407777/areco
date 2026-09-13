// 会话按项目分组（2026-07-22 维护者定，桌面侧栏与手机看板共用同一套分组规则）：
// 非归档项目里有看板会话成员的收进该项目分组；同一会话挂多个项目归第一个（防重复）；
// 组内与零散区的顺序一律跟随传入的 sessions（调用方传 sessions store 的 boardSessions，
// 即「运行优先 + 最后活动倒序」）——有新回复的会话在组内同样浮到最前。
// 2026-07-25 维护者定（活动置顶）：运行中的会话（含项目分组内的）统一抽到 active 区，
// 由两端渲染在列表最顶；不再出现在 groups/loose 原位，退出后自动回落。
import type { RoomInfo, SessionSummary } from '../../../shared/protocol'

export interface SessionGroup {
  id: string
  name: string
  sessions: SessionSummary[]
}

export interface ActiveEntry {
  session: SessionSummary
  /** 所属项目名（游离会话为 null）——活动区脱离了分组层级，渲染时标注出处 */
  roomName: string | null
}

export interface SessionGrouping {
  /** 运行中会话（running/spawning/stopping，含分组内的），已从 groups/loose 抽出；顺序继承传入 */
  active: ActiveEntry[]
  groups: SessionGroup[]
  /** 未归入任何项目分组的会话（零散区，保持传入顺序） */
  loose: SessionSummary[]
}

function isLive(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'spawning' || s.status === 'stopping'
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
  const active: ActiveEntry[] = []
  const byRoom = new Map<string, SessionGroup>()
  const loose: SessionSummary[] = []
  for (const s of sessions) {
    // 活动置顶：非归档的运行中会话一律进 active（组内计数随之减少，组员全活动则组暂不显示）
    if (!s.archived && isLive(s)) {
      active.push({ session: s, roomName: roomOf.get(s.id)?.name ?? null })
      continue
    }
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
  return { active, groups, loose }
}
