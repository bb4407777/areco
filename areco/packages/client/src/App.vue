<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import { useSessionsStore } from './stores/sessions'
import { useUiStore } from './stores/ui'
import { wsClient } from './ws'
import { frontendUpdateAvailable, frontendUpdateBlocked, reloadFrontendNow } from './utils/frontendUpdate'

const store = useSessionsStore()
const ui = useUiStore()
const route = useRoute()

const darkOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#63e2b7',
    primaryColorHover: '#7ff0c8',
    primaryColorPressed: '#5acba6',
    bodyColor: '#101014',
    cardColor: '#17171c',
    modalColor: '#1b1b21',
    popoverColor: '#1f1f26',
    borderColor: '#2a2a32',
  },
}
const lightOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#0ea373',
    primaryColorHover: '#12b981',
    primaryColorPressed: '#0b8a61',
    bodyColor: '#f5f6f8',
    borderColor: '#e3e5ea',
  },
}
const naiveTheme = computed(() => (ui.theme === 'light' ? null : darkTheme))
const overrides = computed(() => (ui.theme === 'light' ? lightOverrides : darkOverrides))

// 座舱页/历史正文页寸土寸金，手机上隐藏顶栏；桌面端有导航栏始终显示
const inSession = computed(() => ui.isMobile && (route.path.startsWith('/session/') || route.path.startsWith('/history/')))
const connected = wsClient.connected

function forceUpdate() {
  if (frontendUpdateBlocked.value && !window.confirm('当前有未发送内容，立即更新会丢失这些文字。仍要更新吗？')) return
  reloadFrontendNow(true)
}
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="overrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <div class="app-shell">
          <header v-if="!inSession" class="app-header">
            <router-link to="/" class="brand">
              <span class="brand-dot" :class="{ off: !connected }" />
              {{ store.title }}
            </router-link>
            <nav class="nav">
              <router-link to="/" class="nav-link" :class="{ active: route.path === '/' }">会话</router-link>
              <router-link to="/tasks" class="nav-link" :class="{ active: route.path.startsWith('/tasks') }">任务</router-link>
              <router-link to="/projects" class="nav-link" :class="{ active: route.path.startsWith('/projects') }">项目</router-link>
              <router-link to="/history" class="nav-link" :class="{ active: route.path.startsWith('/history') }">历史</router-link>
              <router-link to="/settings" class="nav-link" :class="{ active: route.path === '/settings' }">设置</router-link>
              <button class="nav-link theme-btn" type="button" :title="ui.theme === 'dark' ? '切到浅色' : '切到深色'" @click="ui.toggleTheme()">
                {{ ui.theme === 'dark' ? '☀️' : '🌙' }}
              </button>
            </nav>
          </header>
          <Transition name="fade">
            <div v-if="!connected && store.ready" class="conn-banner">连接已断开，正在重连…</div>
          </Transition>
          <Transition name="fade">
            <div v-if="frontendUpdateAvailable" class="update-banner">
              <span>{{ frontendUpdateBlocked ? '新版本已就绪；发送或清空未提交内容后将自动更新。' : '新版本已就绪，正在安全更新…' }}</span>
              <button v-if="frontendUpdateBlocked" type="button" @click="forceUpdate">立即更新</button>
            </div>
          </Transition>
          <router-view />
        </div>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.app-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  padding-top: calc(10px + env(safe-area-inset-top, 0px));
  border-bottom: 1px solid var(--border);
  background: var(--bar);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
  text-decoration: none;
}
.brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.brand-dot.off {
  background: var(--danger);
}
.nav {
  display: flex;
  gap: 4px;
  align-items: center;
}
.nav-link {
  padding: 5px 12px;
  border-radius: 7px;
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  border: 0;
  background: none;
  cursor: pointer;
}
.nav-link.active {
  color: var(--text);
  background: var(--chip-bg);
}
.theme-btn {
  font-size: 14px;
  line-height: 1;
  padding: 5px 8px;
}
.conn-banner {
  padding: 6px 16px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 12px;
  text-align: center;
}
.update-banner {
  position: fixed;
  top: calc(8px + env(safe-area-inset-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: min(640px, calc(100vw - 24px));
  padding: 7px 12px;
  border: 1px solid #e8c75b;
  border-radius: 8px;
  background: #fff3cd;
  color: #785900;
  font-size: 12px;
  text-align: center;
  box-shadow: 0 4px 16px #0002;
}
.update-banner button {
  flex: 0 0 auto;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 3px 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
