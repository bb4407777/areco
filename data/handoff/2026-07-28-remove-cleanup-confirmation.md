# Areco 一键清理去掉确认步骤

- 动机：高律师要求 Areco 的删除任务去掉确认步骤；本次将范围限定为“未归档且已退出会话”的“一键清理”，单个会话、项目和模板删除仍保留确认。
- 根因：`useExitedSessionCleanup` 将共享执行逻辑包在 Naive UI `dialog.warning` 的二次确认回调内，桌面侧栏和手机看板因此都必须再点一次。
- 改动：
  - `packages/client/src/composables/useExitedSessionCleanup.ts:1-35` 移除 `useDialog` 和确认框，改为 `cleanupExited()` 点击即调用 `store.cleanupExited()`；保留能力协商门控、重复点击保护、错误/成功提示及当前会话被清理后的回看板跳转。
  - `packages/client/src/components/SessionSidebar.vue:22,153` 使用 `cleanupExited`。
  - `packages/client/src/views/DashboardView.vue:25,139` 使用 `cleanupExited`。
- 验证：`git diff --check`；`npm run typecheck`；`npm test`（188/188）；`npm run build`（Vite 前端和 server bundle 均完成；仅保留既有大 chunk 警告）。
- 回滚：恢复上述三个文件即可；无需改数据库或服务端 API。
- 部署门槛：本次只改前端源码和构建产物，未重启 8790。用户控制的服务重启后，生产前端才会加载这次行为；旧服务端能力协商门控仍有效。
- 风险/未办：点击“一键清理”即执行批量删除，误触风险由按钮现有禁用条件和服务端最终状态筛选承担；未做真实浏览器点击验证。
