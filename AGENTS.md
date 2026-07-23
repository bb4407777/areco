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

## 本仓操作

- **桌面/手机双端同步上线（2026-07-22 高律师定）**：任何 UI 功能改动必须先想清
  两端的落点——桌面侧栏（SessionSidebar）与手机看板（DashboardView 卡片流）是
  **两套组件**，改一套不等于另一套生效。共用逻辑抽成公共模块（如 utils/sessionGroups），
  不许复制两份漂移；交付前两端各过一遍。
- 测试：`npm test`（tsx --test，含服务端/客户端/共享层）；类型检查即构建前置。
- 部署：`./start.sh restart`（launchd com.areco 已接管，脚本自动转发 kickstart）；
  生产 8790 可能有用户在舱内开着的会话，重启前先 `/api/sessions` 看一眼。
- shell 脚本：macOS 系统 bash 3.2 下 `$VAR` 后紧跟中文/全角字符会把首字节
  粘进变量名（set -u 直接炸）——变量后接 CJK 一律写 `${VAR}`。
- `config.json`、`data/`、`bin/` 是 gitignore 的本机私有物，不入仓。
