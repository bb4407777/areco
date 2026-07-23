import { defineStore } from 'pinia'
import type { ServerMsg, SessionSummary, Template } from '../../../shared/protocol'
import { api } from '../api'

export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    ready: false,
    title: 'Areco',
    serverVersion: '',
    sessions: [] as SessionSummary[],
    templates: [] as Template[],
  }),
  getters: {
    byId: (state) => (id: string) => state.sessions.find((s) => s.id === id),
    sorted(state): SessionSummary[] {
      const rank = (s: SessionSummary) => (s.status === 'running' || s.status === 'spawning' || s.status === 'stopping' ? 0 : 1)
      // 同档内按最后活动（最近输出/回复）倒序：有新回复的会话自动浮到最前
      const activity = (s: SessionSummary) => Math.max(s.trafficUpdatedAt ?? 0, s.startedAt ?? 0, s.createdAt)
      return [...state.sessions].sort((a, b) => rank(a) - rank(b) || activity(b) - activity(a))
    },
    boardSessions(): SessionSummary[] {
      return this.sorted.filter((s) => !s.archived)
    },
    archivedSessions(): SessionSummary[] {
      return this.sorted.filter((s) => s.archived)
    },
    enabledTemplates(state): Template[] {
      return state.templates.filter((t) => t.enabled)
    },
  },
  actions: {
    handleServerMsg(msg: ServerMsg) {
      switch (msg.type) {
        case 'init':
          this.title = msg.title
          this.serverVersion = msg.version
          this.sessions = msg.sessions
          this.templates = msg.templates
          this.ready = true
          document.title = msg.title
          break
        case 'sessionUpdate': {
          const i = this.sessions.findIndex((s) => s.id === msg.session.id)
          if (i >= 0) this.sessions[i] = msg.session
          else this.sessions.push(msg.session)
          break
        }
        case 'sessionRemoved':
          this.sessions = this.sessions.filter((s) => s.id !== msg.sessionId)
          break
        case 'error':
          // 服务端错误（attach 失败/强制 detach 等）：终端视图已自行处理带 sessionId 的，这里至少留痕
          console.warn(`[ws] 服务端错误 ${msg.code}: ${msg.message}${msg.sessionId ? ` (${msg.sessionId.slice(0, 8)})` : ''}`)
          break
      }
    },

    async spawn(templateId: string, opts: { cwd?: string; name?: string }) {
      return api.post<SessionSummary>('/api/sessions', { templateId, ...opts })
    },
    async stop(id: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/stop`)
    },
    async kill(id: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/kill`)
    },
    async restart(id: string, resume = false) {
      return api.post<SessionSummary>(`/api/sessions/${id}/restart`, { resume })
    },
    /** 换 agent 接手：本会话对话写成交接档案，templateId 模板拉起新会话读档续干（活会话先停） */
    async handoff(id: string, templateId: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/handoff`, { templateId })
    },
    async rename(id: string, name: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/rename`, { name })
    },
    async archive(id: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/archive`)
    },
    /** 钉选/取消「总台」：房间加成员列表置顶认此字段，改名不影响 */
    async pin(id: string, pinned: boolean) {
      return api.post<SessionSummary>(`/api/sessions/${id}/pin`, { pinned })
    },
    async unarchive(id: string) {
      return api.post<SessionSummary>(`/api/sessions/${id}/unarchive`)
    },
    async remove(id: string) {
      return api.del<{ removed: string }>(`/api/sessions/${id}`)
    },

    async refreshTemplates() {
      this.templates = await api.get<Template[]>('/api/templates')
    },
    async createTemplate(template: Template) {
      const created = await api.post<Template>('/api/templates', template)
      await this.refreshTemplates()
      return created
    },
    async updateTemplate(id: string, patch: Partial<Template>) {
      const updated = await api.put<Template>(`/api/templates/${id}`, patch)
      await this.refreshTemplates()
      return updated
    },
    async removeTemplate(id: string) {
      await api.del(`/api/templates/${id}`)
      await this.refreshTemplates()
    },
    /** 拖动排序：调用方已先把本地列表挪到位（乐观），这里持久化并以服务端回包为准 */
    async reorderTemplates(ids: string[]) {
      this.templates = await api.post<Template[]>('/api/templates/reorder', { ids })
    },
  },
})
