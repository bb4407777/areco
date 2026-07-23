import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: () => import('./layouts/SessionLayout.vue'),
      children: [
        { path: '', component: () => import('./views/DashboardView.vue') },
        { path: 'session/:id', component: () => import('./views/SessionView.vue') },
        { path: 'session/:id/chat', component: () => import('./views/TranscriptView.vue') },
      ],
    },
    {
      path: '/history',
      component: () => import('./layouts/HistoryLayout.vue'),
      children: [
        { path: '', component: () => import('./views/HistoryView.vue') },
        { path: ':source/:project/:id', component: () => import('./views/HistoryTranscriptView.vue') },
      ],
    },
    { path: '/projects', component: () => import('./views/GroupChatView.vue') },
    { path: '/messages', redirect: '/projects' },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// 重新部署后旧页面懒加载 chunk 404（旧 index.html 引用已删除的旧哈希文件）→ 导航静默失败。
// 检测到该错误就带着目标路由强刷一次拿新包；同一目标只刷一次，防止服务端真坏时死循环。
const CHUNK_RELOAD_KEY = 'ar-chunk-reload'
router.onError((err, to) => {
  const msg = String((err as Error)?.message ?? err)
  if (!/dynamically imported module|Importing a module script failed/i.test(msg)) return
  if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === to.fullPath) return
  sessionStorage.setItem(CHUNK_RELOAD_KEY, to.fullPath)
  location.hash = `#${to.fullPath}`
  location.reload()
})
router.afterEach(() => sessionStorage.removeItem(CHUNK_RELOAD_KEY))
