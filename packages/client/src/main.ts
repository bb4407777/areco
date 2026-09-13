import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { wsClient } from './ws'
import { useSessionsStore } from './stores/sessions'
import { useRoomsStore } from './stores/rooms'
import { useUiStore } from './stores/ui'
import { startFrontendUpdateWatcher } from './utils/frontendUpdate'
import hljsDark from 'highlight.js/styles/github-dark-dimmed.css?inline'
import hljsLight from 'highlight.js/styles/github.css?inline'
import './styles/main.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

const sessions = useSessionsStore(pinia)
const rooms = useRoomsStore(pinia)
rooms.loadReadState()
const ui = useUiStore(pinia)
ui.applyTheme() // mount 前先定主题，防闪白/闪黑
ui.watchViewport()
ui.syncFromServer() // 显示开关服务端为 SoT：拉取覆盖本地缓存；失败静默回落 localStorage
startFrontendUpdateWatcher({
  hasUnsavedWork: () => {
    if (Object.values(ui.drafts).some((text) => text.trim())) return true
    return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.composer input[type="text"], .composer textarea, textarea.prompt-input, .n-modal input')]
      .some((el) => el.value.trim())
  },
})

// 代码高亮主题跟随亮暗切换（hljs 样式表整张换）
const hljsStyle = document.createElement('style')
document.head.appendChild(hljsStyle)
watch(
  () => ui.theme,
  (theme) => {
    hljsStyle.textContent = theme === 'light' ? hljsLight : hljsDark
  },
  { immediate: true }
)

wsClient.onMessage((msg) => sessions.handleServerMsg(msg))
wsClient.onMessage((msg) => rooms.handleServerMsg(msg))
wsClient.connect()

// iOS PWA/Safari 切后台会静默杀 WS；回前台立即重连，不等指数退避
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wsClient.reconnectNow()
})
window.addEventListener('pageshow', () => wsClient.reconnectNow())
window.addEventListener('online', () => wsClient.reconnectNow())

app.mount('#app')
