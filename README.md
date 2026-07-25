# Areco

> 原名 **agent-remote**，v2.2.0 起更名为 **areco**（A **Re**mote **Co**worker）。

CLI Agent 网页远程座舱 —— 在浏览器/手机上远程驾驶 Claude Code、Codex、Reasonix 等 CLI 编程智能体。

## English

**Areco is a remote cockpit for CLI coding agents** — drive Claude Code, Codex, Reasonix and other terminal-based AI agents from your browser or phone, like a chat app for your agents.

- **Multi-agent, multi-session**: spawn sessions from templates (claude / codex / reasonix / shell / custom), each with its own working directory
- **Server-side pty**: start a task on your phone, lock the screen, come back hours later — the session resumes pixel-perfect (shadow-terminal snapshots + offset streaming, alt-screen TUIs included)
- **Device handoff**: open the same live session from any browser, pick up exactly where you left off
- **Chat transcript view**: read agent conversations as clean chat bubbles (Markdown + code highlighting) parsed from each agent's own session files — far more readable on a phone than a raw TUI
- **Project rooms**: group sessions into rooms with @mention routing and shared context, like a group chat of agents
- **Zero cloud**: self-hosted single binary, your agents and data stay on your machine

```bash
npm i -g areco && areco   # then open http://127.0.0.1:8790
```

Apache-2.0 · [GitHub](https://github.com/bb4407777/areco) · 中文文档见下文


## 能干什么

- **多 agent 多会话**：模板（claude / codex / reasonix / shell / 自定义）→ 随开随关多个会话，各带独立 cwd
- **pty 活在服务端**：手机上开个任务、锁屏关浏览器，晚点回来画面无缝接上（影子终端快照 + offset 续流，alt-screen TUI 也不花屏）
- **换设备接管**：手机开的会话，电脑浏览器打开就是同一现场
- **Transcript 对话视图**：座舱头部「⌨️ 终端 / 💬 对话」分段切换——对话模式直读 agent 自己的会话落盘重建聊天气泡（markdown + 代码高亮，手机上比 TUI 可读得多）：claude 系读 `~/.claude/projects/**.jsonl`（字节游标尾载分页）；codex / workbuddy(codebuddy) / reasonix / kimi 直读各自落盘（`~/.codex/sessions` rollout、`~/.workbuddy/projects` jsonl、`~/.reasonix/sessions` replace 帧、`~/.kimi-code/sessions` wire.jsonl，消息级游标，文件按 cwd(-slug) + 启动时刻自动关联——不解析终端流，去 agent 数据层拿结构化对话）。尾部先载 + 「加载更早」向前翻页，2.5s 增量追新，底部可直接续问；默认对话模式、切换偏好记忆在本机，看板点卡片按偏好进入（shell 等无落盘会话始终进终端；新建会话落点可在设置页「对话模式」里选，默认先进终端看启动画面）
- **历史对话浏览**（顶栏「历史」）：翻本机全部落盘会话，双层数据源——
  ① 原生层：`~/.claude/projects` + 各隔离 HOME 分身（`~/.homes/*/.claude/projects`，如 c5/fable）自动发现，
  另有 kimi（`~/.kimi-code/sessions/<wd>/<session_*>/agents/main/wire.jsonl`，元信息读 state.json）与 qclaw；
  全文展示，正文尾部先载、「加载更早」字节游标向前翻，超大 transcript 也不卡手机；
  claude 源可一键「继续会话」（`--resume` 回原 cwd 拉起新座舱会话；已在看板运行的直接跳转/409）；
  kimi 源同样可恢复（`-S <session_id>` 回原 cwd，需启用 kimi 模板）；
  ② chatlog 统一层（可选）：codex / reasonix / cc-connect / workbuddy 的会话读 chatlog 提取产物
  （`~/skills/chatlog/conversations-data.json`，全文+脱敏；该文件存在才启用，kimi 由原生层覆盖不进这层）；
  reasonix 的「继续会话」= 座舱里拉起原生 `--resume` 选择器（其 CLI 无按 id 非交互恢复）；
  codex / workbuddy 也可恢复（`codex resume <uuid>` / codebuddy `--resume <uuid>` 回原 cwd，cwd 由提取器补录，
  旧数据缺 cwd 时 workbuddy 不给恢复）；cc-connect 是渠道桥接副本，只读；
  数据超 10 分钟自动异步刷新（提取端点由 `ARECO_CHATLOG_REFRESH_URL` 指定）。列表按最后活动倒序、搜标题/目录/会话 id
- **服务重启不丢现场**：运行中会话标记 `server-restart`，最后画面落盘可回看；「重新启动（恢复对话）」按 agent 能力原生续上——claude 系 `--resume <id>`（无 id 的存量会话按定位文件自动回填转正）、codex `resume <session_id>`、codebuddy `--resume <uuid>`、kimi `-S <session_id>`、reasonix 拉起原生选择器
- **TUI 注入可靠性**（PromptBar / 历史接续 / 恢复重启共用）：`sendline` 文本与回车拆帧发送，提交回车等 pty 输出安静一拍（120ms、上限 2s）再补——同帧「文本+回车」会被 codebuddy/kimi 等 TUI 按粘贴处理、回车沦为换行不提交（表现为要按两次发送或 enter 变换行）；codebuddy 每个新进程弹的「信任目录」确认页由服务端从 pty 输出检测（剥 ANSI 匹配文案）自动回车过页，新建/重启/恢复全生效，每次启动只答一次且限启动后 2 分钟内（防对话正文同款文字误触发）
- **归档 vs 删除**：卡片菜单「归档」把已停止会话移出看板（看板底部「已归档」折叠区可查看/恢复，重启即自动回看板），元数据、终端快照、agent 对话日志全保留；「删除」清掉卡片与终端快照——但 agent 自身的对话日志（`~/.claude/projects` / chatlog 层）本就不归看板管，删除后仍在「历史」页
- **移动端**：底部快捷键条（Esc/Tab/方向/^C…）、单行 prompt 输入、PWA 添加到主屏幕
- **项目协作**（顶栏「项目」）：一个项目拉多个 agent 进群协作，详见下方「项目协作」一节

## 快速开始

方式一：npm（推荐）

```bash
npm i -g areco     # node >= 24
areco              # 首跑在当前目录生成 config.json 与 data/（可用 ARECO_ROOT=/path 指定数据根）
```

打开 `http://127.0.0.1:8790/` 即用（本机 loopback + 未设密码 = 免登录）。要手机/局域网访问：

```bash
areco --hash "你的密码" --save     # 先设密码（非 loopback 绑定无密码会拒绝启动）
# 再把 config.json 的 server.host 改为 0.0.0.0，重启
```

方式二：源码

```bash
git clone https://github.com/bb4407777/areco.git && cd areco
npm install                       # node >= 24
npm run hash -- "你的密码" --save   # 非 loopback 绑定必须设密码，否则拒绝启动
npm run build
./start.sh start                  # 生产单端口，默认 8790
```

打开 `http://<Mac IP>:8790/`（同一 WiFi / Tailscale），登录即用。

```bash
./start.sh status|stop|restart    # 手动/开发用；pid 文件管理，绝不按端口误杀
npm run dev                       # 开发：server 8790 + vite 8791（HMR）
npm test                          # zsh 转义单测
node scripts/selftest.mjs http://127.0.0.1:8790 "密码"   # 端到端自检（含历史对话 4 项；免密模式不传密码）
```

> **常驻可交 launchd 管理**（macOS，可选）：写一个 `~/Library/LaunchAgents/com.areco.plist`
> （KeepAlive + RunAtLoad，WorkingDirectory 指仓库根，ProgramArguments 跑 `node dist/server/index.cjs`）。
> 改动后重载：`launchctl bootout gui/$(id -u) <plist> && launchctl bootstrap gui/$(id -u) <plist>`。
> 注意：launchd 实例会被 KeepAlive 自动拉活。`./start.sh restart` 区分调用来源——
> 界面一键重启（服务的子进程）只走 `kickstart -k` 杀拉（bootout 的整组 teardown 会把调用方一起带走，2026-07-23 实测躺尸）；
> 人工命令行 restart 才走 `bootout`+`bootstrap` **重读 plist**。所以改了 plist（环境变量/启动参数）后，
> 需在命令行跑一次 `./start.sh restart` 生效（按钮重启的输出落 `data/logs/restart.log` 可查）。

> **重要**：服务进程的 `HOME` 决定 spawn 出的 claude 用哪套认证/transcript 目录。
> `start.sh` 已自动落回本用户真实 HOME（passwd 库解析，不信调用方环境）；特殊场景可用 `ARECO_HOME` 覆盖。

> **auto-recall 记忆注入（可选）**：设环境变量 `ARECO_RECALL_SCRIPT` 指向本机 recall 脚本（如 `~/skills/memory/scripts/recall.py`），
> 项目房间投递 note 时自动注入相关记忆；未配置则该功能整体关闭（静默跳过，不影响投递）。

## 项目协作（多 agent 群聊 + 派单）

顶栏「项目」= 给一件事拉一个群，把多个 agent 编成一队干活：

- **建项目 → 加成员**：成员按模板一键 spawn 为项目专属会话（页面操作，或
  `POST /api/rooms/:id/members {"templateId":"claude"}`）；专属会话随项目归档级联管理，
  **删除项目会连带删除专属会话**——讨论收摊用「归档」（可随时恢复），删除是不可逆动作
- **消息与投递**：房间消息正文带 `@成员名` / `@all` 才注入目标会话终端（人类成员发言默认投全体）；
  目标会话已退出会**自动 resume 拉起再投递**；agent 回执走包内 `scripts/areco-msg.mjs`
  （零依赖 CLI，直写 `data/projects.db`，本机任何终端都能插话）；agent 互调链深上限 3 跳防环
- **调度模式**：`serial` 串行轮转（默认，一次只放行一位成员发言，讨论不刷屏）/
  `parallel` 全员同时 / `claim` 认领制，项目页随时切换
- **共享根目录 + 文件面板**：项目设 `rootPath` 后成员共读同一目录，页面直览文件、点开预览
  （docx/pdf/图片/视频，docx 服务端现转 PDF）
- **产物栏**：从消息流自动汇聚各成员产出的文件路径，一栏看全、免翻聊天记录
- **git 派单（可选）**：项目绑定 `repoPath` 后可给成员派发 worktree 任务，完成后合并检查/
  冲突处理（dispatches API），多 agent 改同一仓不踩脚
- **auto-recall（可选）**：配 `ARECO_RECALL_SCRIPT` 指向本机记忆检索脚本后，投递时自动附带相关记忆

## 架构

```
packages/shared/protocol.ts   WS 协议 + 类型（两端唯一事实源）
packages/server  (Koa)        routes → controllers → services 分层
  services/session.ts         pty + @xterm/headless 影子终端 + 双计数器快照（核心正确性）
  services/session-manager.ts 会话注册表/状态机/autoStart/重启恢复
  services/templates.ts       模板 CRUD + zsh -ilc 最小干净环境 spawn（防 agent 环境变量泄漏）
  services/transcript.ts      读盘重建对话（字节 cursor 增量）
  services/history.ts         历史会话：projects/ 扫描（stat+封顶头扫提元信息，mtime 缓存）+ 尾部倒序字节分页
  services/chatlog.ts         chatlog 统一层：codex/reasonix/cc-connect/workbuddy 读提取产物（47MB JSON 闲置即释）
  ws/gateway.ts               attach 快照缓冲防 gap + 绝对 offset ack 流控 + 心跳
packages/client  (Vue3+Naive) Dashboard / Session 座舱 / Transcript 聊天 / History 历史 / Settings
```

### 断线恢复协议（本项目的核心机制）

1. 每会话双计数器：`produced`（pty 输出即累加，标在每个 output 块上）、`shadowProcessed`（影子终端消化完回调推进）
2. attach 时影子终端 `write('', cb)` drain，回调内**同步**取 offset + `SerializeAddon.serialize()`（含 alt-screen/scrollback/光标）
3. 客户端收快照先 `reset()` 重放，之后 `offset <= applied` 或 epoch 不符的块一律丢弃 —— 不重不漏
4. ack 带绝对 offset（幂等无漂移）；unacked > 256K 暂停 pty，全部 < 64K 恢复；高水位滞留 15s（锁屏假死）强制 detach 解救 pty

### 安全

- 非 loopback 绑定 + 无密码 → **拒绝启动**（v1 免密开 0.0.0.0 的教训）。
  想少输密码：`sessionTtlHours` 调大（滑动续期，8760 = 每设备一年只登一次）。
  彻底免密：`server.insecureNoAuth: true` 显式开关——等于把本机 shell 开放给网络内所有设备，仅限完全可信网络（Tailscale-only 绑定更稳）
- Host/Origin 白名单（loopback/RFC1918/Tailscale CGNAT/.ts.net/.local + config.allowedHosts），防 DNS rebinding
- scrypt 口令哈希（兼容识别 v1 的 sha256 格式）+ 登录按 IP 限流（5 次/分 → 指数封禁）
- WS upgrade 同套双校验，未识别 upgrade 一律 destroy；cookie HttpOnly + SameSite=Lax + 滑动 TTL

## 配置（config.json，gitignore）

```jsonc
{
  "server": {
    "host": "0.0.0.0",        // 127.0.0.1 = 仅本机（可免密）
    "port": 8790,
    "passwordHash": "scrypt:…", // npm run hash -- "密码" --save
    "sessionTtlHours": 72,
    "allowedHosts": [],        // 额外放行的访问域名/IP
    "maxSessions": 0           // 同时运行会话上限，0 = 无上限（默认）；也可在「设置」页在线改，即时生效
  },
  "templates": [ { "id", "name", "command", "args", "cwd", "color", "autoStart", "enabled" } ]
}
```

模板也可在网页「设置」里直接增删改。

## bin/ 启动器（可选，不入仓）

`bin/` 整目录 gitignore，用于放你自己的 agent 启动脚本（含 token/绝对路径等本机私有配置）——
比如用 `env -i` 全量重置环境、以隔离 HOME 启动某个 claude 分身，再把脚本注册为模板即可在座舱开会话。
模板的 `claudeHome` 字段告诉服务该会话的 transcript 落在哪个 HOME 下（对话视图/恢复会话靠它定位）。

## Roadmap（未做，有需要再说）

- 聊天模式：headless `claude -p --output-format stream-json` 驱动 + `--permission-prompt-tool` MCP 授权桥
  （手机上点"批准/拒绝"工具调用）
- Observe/Adopt 本机别处启动的 claude 会话（读 sessions manifest）
- 通知推送（会话空闲/出错时经消息桥推送）

## 致谢

- [code-by-wire](https://github.com/luojiahai/code-by-wire)：影子终端快照断线恢复、pty 服务端存活、读盘 Transcript 的实现模式来源（MIT，署名见 NOTICE）
- [agmsg](https://github.com/fujibee/agmsg)：跨 agent 消息的设计启发（早期互操作层曾与其同库，现已转为内置实现）
- [hermes-studio](https://github.com/EKKOLearnAI/hermes-studio)：产品形态参考（多 agent 座舱与群聊形态）
