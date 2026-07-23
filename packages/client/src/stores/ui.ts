// UI 偏好（localStorage 持久化）：终端字号、最近 cwd、移动端判定
import { defineStore } from 'pinia'

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
  /** 座舱默认显示模式：看板点卡片时 claude 系会话按此进入（终端/对话）。默认对话 */
  sessionView: SessionViewMode
  /** 新建会话成功后的默认显示模式（终端/对话）。默认终端——先看启动画面 */
  newSessionView: SessionViewMode
  /** 对话模式：显示 agent 思考过程（默认关，勾选才显示） */
  showThinking: boolean
  /** 对话模式：显示工具调用 tool_use（默认关，勾选才显示） */
  showToolUse: boolean
  /** 对话模式：显示工具结果 tool_result（默认关，勾选才显示） */
  showToolResult: boolean
}

const DEFAULT_PREFS: UiPrefs = { fontSize: 13, recentCwds: [], promptHistory: [], theme: 'light', sessionView: 'chat', newSessionView: 'terminal', showThinking: false, showToolUse: false, showToolResult: false }

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
      const { fontSize, recentCwds, promptHistory, theme, sessionView, newSessionView, showThinking, showToolUse, showToolResult } = this
      localStorage.setItem(LS_KEY, JSON.stringify({ fontSize, recentCwds, promptHistory, theme, sessionView, newSessionView, showThinking, showToolUse, showToolResult }))
    },
    setSessionView(mode: SessionViewMode) {
      this.sessionView = mode
      this.persist()
    },
    setNewSessionView(mode: SessionViewMode) {
      this.newSessionView = mode
      this.persist()
    },
    setShowThinking(v: boolean) {
      this.showThinking = v
      this.persist()
    },
    setShowToolUse(v: boolean) {
      this.showToolUse = v
      this.persist()
    },
    setShowToolResult(v: boolean) {
      this.showToolResult = v
      this.persist()
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
