// 群聊房间状态：房间列表 + 各房消息缓存。实时性靠 WS（rooms 全量 / roomMessage 增量），
// REST 只用于首载与 CRUD；mutations 后等服务端 broadcastRooms 回流，不本地改名单。
import { defineStore } from 'pinia'
import type { DispatchMode, MergeCheckInfo, RoomDispatchInfo, RoomInfo, RoomMessage, ServerMsg } from '../../../shared/protocol'
import { api } from '../api'

interface RoomsPayload {
  rooms: RoomInfo[]
  humanName?: string
  msgCli?: string
  archiveSupported?: boolean
}

export const useRoomsStore = defineStore('rooms', {
  state: () => ({
    loaded: false, // false 且接口 404 = 服务端还是旧版本（待重启）
    stale: false,
    rooms: [] as RoomInfo[],
    messages: {} as Record<string, RoomMessage[]>,
    /** 房间 → 调度列表（WS roomDispatches 全量推 + 进页面 REST 拉一次） */
    dispatches: {} as Record<string, RoomDispatchInfo[]>,
    humanName: 'Owner',
    msgCli: '',
    /** 新服务端归档能力标记；旧 8790 缺字段时保持 false，前端只展示待重启状态。 */
    archiveSupported: false,
    /** 房间 → 已读到的最大消息 id（localStorage 持久；仅用于侧栏未读角标） */
    lastRead: {} as Record<string, number>,
    /** 房间 → 最近一条消息的本地时间戳（WS 增量更新；初始值用 RoomInfo.lastMessageAt） */
    lastMsgAt: {} as Record<string, number>,
    /** 房间 → loadMessages 代数 token：并发/过期响应守卫 */
    loadTokens: {} as Record<string, number>,
  }),
  getters: {
    byId: (state) => (id: string) => state.rooms.find((r) => r.id === id),
    unread: (state) => (id: string) => {
      const list = state.messages[id]
      if (!list?.length) return 0
      const read = state.lastRead[id] ?? 0
      return list.filter((m) => m.id > read).length
    },
    /** 按最近回复倒序：有新消息的项目自动浮到最前；无消息的按创建时间兜底 */
    sortedRooms(state): RoomInfo[] {
      const at = (r: RoomInfo) =>
        state.lastMsgAt[r.id] ?? (r.lastMessageAt ? Date.parse(r.lastMessageAt) || 0 : 0) ?? 0
      return [...state.rooms].sort((a, b) => at(b) - at(a) || b.createdAt - a.createdAt)
    },
  },
  actions: {
    handleServerMsg(msg: ServerMsg) {
      if (msg.type === 'rooms') {
        this.rooms = msg.rooms
      } else if (msg.type === 'roomMessage') {
        const list = (this.messages[msg.roomId] ??= [])
        if (!list.some((m) => m.id === msg.message.id)) list.push(msg.message)
        this.lastMsgAt[msg.roomId] = Date.now()
      } else if (msg.type === 'roomDispatches') {
        this.dispatches[msg.roomId] = msg.dispatches
      }
    },

    loadReadState() {
      try {
        this.lastRead = JSON.parse(localStorage.getItem('areco-room-read') ?? '{}')
      } catch {
        this.lastRead = {}
      }
    },
    markRead(roomId: string) {
      const list = this.messages[roomId]
      if (!list?.length) return
      this.lastRead[roomId] = list[list.length - 1].id
      localStorage.setItem('areco-room-read', JSON.stringify(this.lastRead))
    },

    async refresh() {
      try {
        const payload = await api.get<RoomsPayload>('/api/rooms')
        this.rooms = payload.rooms
        if (payload.humanName) this.humanName = payload.humanName
        if (payload.msgCli) this.msgCli = payload.msgCli
        this.archiveSupported = payload.archiveSupported === true
        this.stale = false
      } catch (err) {
        // 旧服务端没有 /api/rooms（404 未找到）：标记待重启，界面给明确提示而非空白
        if (err instanceof Error && err.message.includes('未找到')) this.stale = true
        else throw err
      } finally {
        this.loaded = true
      }
    },
    async loadMessages(roomId: string, limit = 100) {
      // 竞态守卫：REST await 期间 WS push 已写入 messages，整体赋值会把新消息覆盖丢失；
      // 代数 token 丢弃过期响应，赋值时合并期间到达的 WS 增量（按 id 去重排序）
      const token = (this.loadTokens[roomId] ?? 0) + 1
      this.loadTokens[roomId] = token
      const list = await api.get<RoomMessage[]>(`/api/rooms/${roomId}/messages?limit=${limit}`)
      if (this.loadTokens[roomId] !== token) return
      const live = this.messages[roomId] ?? []
      const merged = [...list]
      for (const m of live) {
        if (!merged.some((x) => x.id === m.id)) merged.push(m)
      }
      merged.sort((a, b) => a.id - b.id)
      this.messages[roomId] = merged
    },
    async create(name: string) {
      const room = await api.post<RoomInfo>('/api/rooms', { name })
      return room
    },
    async remove(id: string) {
      await api.del(`/api/rooms/${id}`)
      delete this.messages[id]
    },
    async archive(id: string) {
      return api.post<RoomInfo>(`/api/rooms/${id}/archive`, {})
    },
    async unarchive(id: string) {
      return api.post<RoomInfo>(`/api/rooms/${id}/unarchive`, {})
    },
    async addMember(roomId: string, templateId: string) {
      return api.post(`/api/rooms/${roomId}/members`, { templateId })
    },
    async removeMember(roomId: string, name: string) {
      return api.del(`/api/rooms/${roomId}/members/${encodeURIComponent(name)}`)
    },
    async send(roomId: string, body: string) {
      return api.post<RoomMessage>(`/api/rooms/${roomId}/messages`, { body })
    },
    async loadDispatches(roomId: string) {
      this.dispatches[roomId] = await api.get<RoomDispatchInfo[]>(`/api/rooms/${roomId}/dispatches`)
    },
    async setMode(roomId: string, mode: DispatchMode) {
      return api.post<RoomInfo>(`/api/rooms/${roomId}/mode`, { mode })
    },
    async setRepo(roomId: string, repoPath: string | null) {
      return api.post<RoomInfo>(`/api/rooms/${roomId}/repo`, { repoPath })
    },
    async setRoot(roomId: string, rootPath: string | null) {
      return api.post<RoomInfo>(`/api/rooms/${roomId}/root`, { rootPath })
    },
    async cancelDispatch(roomId: string, dispatchId: number, reason?: string) {
      return api.post(`/api/rooms/${roomId}/dispatches/${dispatchId}/cancel`, { reason })
    },
    async mergeCheck(roomId: string, dispatchId: number) {
      return api.post<MergeCheckInfo>(`/api/rooms/${roomId}/dispatches/${dispatchId}/merge-check`)
    },
    async resolveConflict(roomId: string, dispatchId: number, templateId: string) {
      return api.post<MergeCheckInfo & { sessionId?: string }>(`/api/rooms/${roomId}/dispatches/${dispatchId}/resolve-conflict`, {
        templateId,
      })
    },
  },
})
