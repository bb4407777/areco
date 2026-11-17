# AGENTS.md（areco 仓内 agent 行为约束）

> 本仓由多 agent（Claude Code / Codex / WorkBuddy / Kimi CLI …）接力开发。
> 每条规则都踩过坑，别删，只增补。

## 交接纪律（2026-07-19 定）

1. **每棒收尾前必须 `git commit`**——工作区不过夜。攒一天 20+ 文件未提交，
   出了回归无法归因是谁哪一棒引入的（当日桥水绑定/红绿灯两起回归即教训）。
2. **行为变更必须拿真实数据自验再交接**：跑一遍真实看板/真实 transcript 目录
   （`~/.claude/projects`、`~/.codex/sessions`、`~/.codebuddy/projects`），
   单测全绿不算完——严格绑定器单测全过、一碰真实软链双候选就拒绑即教训。
3. 交接文件（`data/handoff/`）写清：本棒 commit 范围、改了什么行为、
   有什么没验证到。
4. **每个新功能/修复 = 一份独立工程档案（2026-07-27 高律师定）**：除「交接」用途外，
   功能/修复本身要有一份独立档案 `data/handoff/YYYY-MM-DD-<主题>.md`，写清根因/动机、
   改了哪些代码（文件:行）、怎么验证（测试/实测）、回滚方法、部署门槛、未办/风险。
   下次同类故障先查档案 + `git log`，不从零排查——「不知道哪次修改把原有功能改没了」
   即靠此追溯。**无档案 = 没干完。** 示范：`data/handoff/2026-07-27-claude-transcript-binding-fix.md`。
5. **输入通道的修复必须带故障注入测试（2026-11-18 定）**：改 `session.ts` 的提交路径
   （`sendline` / `writeEnterWhenSettled` / `submitUntilAccepted` / `guardTypedSubmit`）时，
   必须补一条模拟失败的测试——帧丢了、回车被吞、整行被 TUI 丢掉——只测「正常发得出去」不算验证。
   判据自下而上排序：**agent 转写 > pty 输出 > 屏幕**；屏幕只能当防误触门槛，绝不当交付判据
   （11-09→11-18 十次修复都栽在「屏幕看着像发出去了」）。

## 本仓操作

- **桌面/手机双端同步上线（2026-07-22 高律师定）**：任何 UI 功能改动必须先想清
  两端的落点——桌面侧栏（SessionSidebar）与手机看板（DashboardView 卡片流）是
  **两套组件**，改一套不等于另一套生效。共用逻辑抽成公共模块（如 utils/sessionGroups），
  不许复制两份漂移；交付前两端各过一遍。
- 测试：`npm test`（tsx --test，含服务端/客户端/共享层）；类型检查即构建前置。
- 部署：`./start.sh restart`（launchd com.areco 已接管，脚本自动转发 kickstart）；
  生产 8790 可能有用户在舱内开着的会话，重启前先 `/api/sessions` 看一眼。
- **不自己重启**（2026-11-11 高律师令「下次不要自己重启」）：改动只汇报、只构建，
  重启时机由高律师定；确有紧急理由也先问一句，别顺手 kickstart。
- shell 脚本：macOS 系统 bash 3.2 下 `$VAR` 后紧跟中文/全角字符会把首字节
  粘进变量名（set -u 直接炸）——变量后接 CJK 一律写 `${VAR}`。
- `config.json`、`data/`、`bin/` 是 gitignore 的本机私有物，不入仓。
- 桌面壳 `packages/app/`（2026-08-13 新增，独立 package）：Electron 壳，只 loadURL
  到 areco server（默认 8790，`ARECO_URL` 覆盖），不打包前端、无 IPC；改 server 端口
  或部署形态时同步看它。档案：`data/handoff/2026-08-13-areco-desktop-shell.md`。

## 复用模式清单（2026-07-24 高律师定：一套更换，改一处必同步）

> 这些是仓里已经沉淀的共用模块/版式约定。新功能**先查这里有没有现成的**，
> 不许复制第二份；改版式/判断逻辑时按「同步面」整组改，漏一处就是回归。

### 消息气泡版式（三处同构，改版式必须整组改）
- 统一结构：`.msg-meta`（发送者名/模板名，泡泡上方）→ `.bubble` → `.msg-foot`
  （左「📋 复制 / ✓ 已复制」，右完整时间 `fmtFullTime`）。
- 落点：`ChatMessage.vue`（对话模式 + 历史日志页共用组件，模板名走 `agentLabel` prop）
  与 `GroupChatView.vue` 消息块（项目，self 消息 foot 整体右对齐）。

### utils/format.ts（会话展示的判断与格式化，唯一出处）
- `templateLabel` / `templateColor`：模板名与颜色（模板已删有兜底）。
- `chatCapable` / `sessionEntryPath`：会话有无对话视图、按偏好算落点路由——
  看板点卡片、侧栏、新建会话三处共用，**禁止在调用处重写判断**。
- `fmtFullTime`：气泡右下角完整时间，两端统一格式。
- `trafficColor` / `statusTagText`：红绿灯与状态文案。

### 其他共用件
- `utils/sessionGroups.ts`：桌面侧栏与手机看板的项目分组规则（双端同源）。
- `utils/clipboard.ts` `copyPlainText`：双通道复制（气泡/项目消息同用）。
- `utils/filelinks.ts` + `FilePreview.vue`：正文里文件路径 → chip 预览。
- `stores/ui.ts`：本机 UI 偏好（localStorage `areco-ui`）。加新偏好 = 加字段 +
  `DEFAULT_PREFS` + `persist()` + setter，设置页用「对话模式」卡片的 `pref-row` 样式挂开关。
- `SpawnDialog.vue`：`spawned` 事件**必须传完整 SessionSummary**——store 靠 ws 推送，
  spawn 返回瞬间 `byId` 查不到新会话（2026-07-23 落点判断失效即此坑）。
- 组件：`TypingIndicator` / `ViewModeSwitch` / `PromptBar` / `MobileKeyBar` 全局复用。
