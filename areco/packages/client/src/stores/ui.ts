// UI 偏好（localStorage 持久化）：终端字号、最近 cwd、移动端判定
import { defineStore } from 'pinia'
import { getUiPrefs, putUiPrefs } from '../api'

const LS_KEY = 'areco-ui'
// 改名前的旧键，读不到新键时迁移一次
const LEGACY_LS_KEY = 'agent-remote-ui'

export type ThemeMode = 'dark' | 'light'
export type SessionViewMode = 'terminal' | 'chat'

interface UiPrefs {
  fontSize: number
  recentCwds: string[]
  promptHistory: string[]
  theme: ThemeMode
  /** 默认显示模式：看板/侧栏点开会话、新建会话成功后的落点（终端/对话）。仅设置页可改；
   *  会话内切换只换当次路由、不写回这里（2026-07-24 维护者定）。默认对话 */
  sessionView: SessionViewMode
  /** 对话模式：显示 agent 思考过程（默认关，勾选才显示） */
  showThinking: boolean
  /** 对话模式：显示工具调用 tool_use（默认关，勾选才显示） */
  showToolUse: boolean
  /** 对话模式：显示工具结果 tool_result（默认关，勾选才显示） */
  showToolResult: boolean
  /** 新建会话表单形态：role = 只选 Worker/Thinker（默认）；template = 旧模板下拉。
   *  服务端 SoT（GET/PUT /api/ui/prefs），跨浏览器/设备生效；缺省回落 'role' */
  spawnMode: 'role' | 'template'
}

const DEFAULT_PREFS: UiPrefs = { fontSize: 13, recentCwds: [], promptHistory: [], theme: 'light', sessionView: 'chat', showThinking: false, showToolUse: false, showToolResult: false, spawnMode: 'template' }

function load(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY)
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UiPrefs>) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREFS }
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    ...load(),
    isMobile: window.matchMedia('(max-width: 768px)').matches,
    isTouch: window.matchMedia('(hover: none) and (pointer: coarse)').matches,
    // 未发送的输入草稿，按 sessionId 存：切换视图/会话再切回不丢字（2026-07-23 报障 #3）。
    // 仅存内存不进 localStorage——草稿是临时态，持久化会让已退出会话的残稿无限堆积
    drafts: {} as Record<string, string>,
  }),
  getters: {
    isDesktop: (state) => !state.isMobile,
  },
  actions: {
    persist() {
      const { fontSize, recentCwds, promptHistory, theme, sessionView, showThinking, showToolUse, showToolResult, spawnMode } = this
      localStorage.setItem(LS_KEY, JSON.stringify({ fontSize, recentCwds, promptHistory, theme, sessionView, showThinking, showToolUse, showToolResult, spawnMode }))
    },
    setSessionView(mode: SessionViewMode) {
      this.sessionView = mode
      this.persist()
    },
    setShowThinking(v: boolean) {
      this.showThinking = v
      this.persist()
      this.pushShowPrefs({ showThinking: v })
    },
    setShowToolUse(v: boolean) {
      this.showToolUse = v
      this.persist()
      this.pushShowPrefs({ showToolUse: v })
    },
    setShowToolResult(v: boolean) {
      this.showToolResult = v
      this.persist()
      this.pushShowPrefs({ showToolResult: v })
    },
    /** fire-and-forget 把显示开关写回服务端（SoT）；失败静默——localStorage 已是完整缓存 */
    pushShowPrefs(prefs: Partial<Record<'showThinking' | 'showToolUse' | 'showToolResult', boolean | null>>) {
      putUiPrefs(prefs).catch(() => { /* 静默：旧版服务端无此端点/网络不可达时行为与纯 localStorage 一致 */ })
    },
    /** 启动时与服务端同步显示开关：服务端有显式值的键覆盖本地并 persist；
     *  服务端无任何显式值而本地有显式选择（≠ 默认）→ 把本地三键 PUT 上去做种子。
     *  全部网络失败静默 catch（8790 旧版无此端点时行为与纯 localStorage 一致，不影响启动） */
    async syncFromServer() {
      try {
        const remote = await getUiPrefs()
        const keys = ['showThinking', 'showToolUse', 'showToolResult'] as const
        const explicit = keys.filter((k) => typeof remote[k] === 'boolean')
        if (explicit.length) {
          for (const k of explicit) this[k] = remote[k]!
          this.persist()
        } else if (keys.some((k) => this[k] !== DEFAULT_PREFS[k])) {
          this.pushShowPrefs({ showThinking: this.showThinking, showToolUse: this.showToolUse, showToolResult: this.showToolResult })
        }
        // 2026-08-01 高律师定：新建会话模式已取消（固定模板），服务端残留 spawnMode 键不再应用
      } catch { /* 静默：见上 */ }
    },
    /** 应用主题到文档（CSS 变量作用域 + iOS 状态栏色） */
    applyTheme() {
      document.documentElement.dataset.theme = this.theme
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', this.theme === 'light' ? '#f5f6f8' : '#101014')
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark'
      this.applyTheme()
      this.persist()
    },
    setFontSize(size: number) {
      this.fontSize = Math.max(10, Math.min(20, size))
      this.persist()
    },
    rememberCwd(cwd: string) {
      const value = cwd.trim()
      if (!value) return
      this.recentCwds = [value, ...this.recentCwds.filter((c) => c !== value)].slice(0, 8)
      this.persist()
    },
    rememberPrompt(text: string) {
      const value = text.trim()
      if (!value) return
      this.promptHistory = [value, ...this.promptHistory.filter((p) => p !== value)].slice(0, 50)
      this.persist()
    },
    /** 存/清某会话的未发送草稿：空串即清除，不留空键 */
    setDraft(sessionId: string, text: string) {
      if (!sessionId) return
      if (text) this.drafts[sessionId] = text
      else delete this.drafts[sessionId]
    },
    watchViewport() {
      window.matchMedia('(max-width: 768px)').addEventListener('change', (e) => {
        this.isMobile = e.matches
      })
    },
  },
})
