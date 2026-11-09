# areco 调试记录（debug.md）

> 排查过程与踩坑实录，按时间线。修复交付档见 `data/handoff/`，本文件记「怎么 debug 的」，
> 后人遇同类故障可照此复盘，不必从零摸索。

---

## 2026-07-27 · 对话模式显示不到会话内容（KIMI 双绑）

### 现象

用户报：下午 19:05 重启 8790 后，多个会话切对话模式看不到内容（workbuddy/kimi）。
"思考内容能显示、对话正文不能"。

### 排查时间线（含弯路，照此避坑）

**弯路 1 · 误判「不是代码回归」**
- 看 `git log` 发现 `agent-transcript.ts` 今天只有 `e24770c`(08:23)动过，且 diff 只改
  `trafficStateFromCodex`（Codex 红绿灯），没碰绑定/读取。于是断言"不是回归"。
- **错**：`e24770c` 确实改了 `agent-transcript.ts`，但和本 bug 无关；真正的回归是**运行时状态**，
  不是代码 diff。结论下太早。

**转折 · 用户一句话纠正方向**
- 用户："19:05 重启之后出现问题，旧代码是 ok 的"。
- 这把"代码 diff"视角扳回"运行时状态"视角：旧进程（PID 54913，06:29 启动）没加载 08:23 后的
  commit 靠 `locateCache` 续命；19:05 重启（PID 54319）清缓存 → 真 bug 显形。
- **教训**：用户的时间点观察（"X 之后坏的"）是金矿，别拿"代码没动"去反驳，先信再查。

**弯路 2 · 误读 transcript API 外壳**
- 多次 `curl /api/sessions/<id>/transcript` 都报 `messages=0`，据此断定会话空白。
- **错**：返回是 `{ok: true, data: <TranscriptPage>}` 包裹，真内容在 `data` 里。我一直读外层
  `d.get('messages')`，永远 0。拆壳后 2579f70e 实为 80 条、b85b8b53 为 80 条——**早就恢复了**。
- **教训**：areco API 统一 `{ok, data}` 外壳（见 `ok()` helper），调试时务必拆 `data`。

**真根因 · KIMI 双绑 + 占用闸 + locateCache 清空**
- server.log 旧进程段（11:56/11:58，**注意 UTC，= 北京 19:56/19:58**）：
  ```
  绑定 kimi 会话 2579f70e ↔ session_c385d78c
  绑定 kimi 会话 b85b8b53 ↔ session_c385d78c   ← 同一个底层！
  ```
- 两张卡错绑同一原生 session。占用闸（`session-manager.ts:60` 注册）只查 `s.isRunning`：
  A 绑 X → A 退出（not running）→ B 绑 X（闸放行）→ A 恢复 → 双绑落定。
- 旧进程靠 `locateCache`（11:56 那次绑定命中）续命，绕过选择逻辑 → 两个都能读。
- 19:05 重启清空 `locateCache` → 重新 locate 时 `bindCandidate`/`exactAgentFile` 占用闸互斥
  （两活会话争同一原生文件）→ 都返回 null → `readAgentTranscript` 返回
  `{exists:false, messages:[]}` → 对话模式空白。

**WB · 不是 bug**
- `9a0d6db2` 卡片名还是模板名 `WorkBuddy DeepSeek Pro #2`（`autoNamed`，没收过输入）→ 空会话，
  空是正常的。且 restart 后已被 exited 清理。
- 有内容的 WB 会话（`b37e3001`，22 条）正常显示。

### 修复

双绑启动体检：`SessionManager.restore()` 末尾 `dedupBindings()`，启动扫一次，
同 nativeId 多会话只留 `startedAt` 最早的，其余 `clearAgentBinding()` + `dropAgentTranscriptCache()`。
纯函数 `duplicateBindingVictims` 抽到 `session-dedup.ts`（避免测试经 SessionManager 拖入
`@xterm/headless` 运行时依赖）。详见 `data/handoff/2026-07-27-claude-transcript-binding-fix.md`。

### spawn 注入根治 · 实测走不通

原想给 workbuddy/kimi 系 spawn 时注入唯一 id（像 claude `--session-id`）。隔离实测：
```
kimi -S session_<新uuid>  →  error: failed to start shell: Session "..." not found.
```
- kimi `-S` 和 codebuddy `--resume` 都是**纯恢复语义**，不接受指定新 id 起新会话。
- CLI 的 session id 由其自身随机生成，外部无法指定。途径 A（注入）不可行。
- 唯一可行的是途径 B（spawn 后监听落盘目录捕获真实 id），成本高收益低，单列待办。

### 调试踩坑清单（后人照此避坑）

1. **API 外壳**：areco 所有 controller 返回 `{ok, data}`，调试 curl 必须拆 `data` 才看到真实 page。
2. **server.log 时区是 UTC**：日志里 `12:41` = 北京 `20:41`。对照进程启动时间（`ps lstart` 本地时）要 +8h 换算。
3. **8790 跑 `dist/server/index.cjs` bundle，不是 src**：改完 src 必须 `node scripts/build-server.mjs`
   重建 dist + restart 8790 才生效；src 改动 restart 不生效（除非跑 tsx 模式，areco 不是）。
   `build-server.mjs` 不跑 typecheck，但 `npm run build` 的 typecheck 会卡 `*.test.ts` 的 lint。
4. **`dropAgentTranscriptCache(sessionId)`**：清 `parseCache` + `locateCache` 两层。手动解绑会话后
   必须调它，否则 `locateCache` 还指旧文件。
5. **占用闸只查 running**：会话「退出又恢复」是双绑漏网根源。体检（启动）+ 占用闸（运行时）两层防御。
6. **codebuddy/kimi session id 不可外部指定**：`-S`/`--resume` 只恢复已存在会话。要确定性绑定，
   只能 spawn 后从落盘文件捕获真实 id（途径 B）。
7. **`locateCache` 让旧进程「看起来好的」**：bug 在旧进程已存在，但靠缓存续命没显形；**重启是验真**，
   用户报"重启后坏"往往不是重启引入，是重启清缓存让既有 bug 显形。
8. **pre-existing WIP 污染 dist**：`build-server.mjs` bundle 整个 working tree，别人的未提交改动会
   一起进 dist。restart 前 `git status` 确认 WIP，或 stash 后 rebuild 干净 dist。
9. **`timeout`/`gtimeout` 在 macOS 默认没有**：实测交互 CLI 用 `perl -e 'alarm N; ...'` 或
   background + sleep + kill。
10. **会话 id 前缀查日志**：areco session.id（uuid）≠ agent 的原生文件 id。日志里 `[locate] <前缀>`
    是 areco id；原生文件名（codebuddy `<uuid>.jsonl`、kimi `session_<uuid>/wire.jsonl`）是 agent 自己的 id，
    两者靠 locate 绑定关联，别混。

---

## 2026-11-09 · 恢复会话后消息发不出去（回车变换行）

### 现象

areco 里 WorkBuddy/codebuddy 会话退出后自动恢复，恢复期间发出去的消息停在输入框里
（或带一个空行），命令一直不提交；已有的「看输入框、尾字不在就补按回车」的复看机制
（`submitUntilAccepted`）没救回来。

### 实测（pty + @xterm/headless，probe 脚本 /tmp/probe*.cjs）

- 恢复（`codebuddy --resume`）首屏重放期间写入的正文**整段被 TUI 丢掉**：1.5s 时写入，
  3s 看屏幕输入框仍是空的，正文+回车并帧、分开写都一样。4s 后按回车也没用——消息已经没了。
- 输入框形态：正文行 `> text`，上下一行是 `────` 分隔线，下面 `? for shortcuts  ← for agents`。
  自动恢复重放到首屏画完约 8–12s（信任页更久），比 `MIN_BOOT_MS`（8s）和旧 `ENTER_MAX_WAIT_MS`（8s）都长。

### 根因

1. 恢复期间正文写在输入框还不存在的时候 → 被丢；旧逻辑只在「框里有尾字」时才按，**从不在
   正文丢失后补写**，5 分钟窗口空转；
2. 等满上限仍无条件按一次回车，且之后每秒按一次，撞上 TUI 重绘残帧就并成粘贴 → 换行，
   正是用户说的「成为换行」。

### 修复（`packages/server/src/services/session.ts`）

- `sendline` 记录写入时输入框是否已存在（`boxAtWrite`）；
- `submitUntilAccepted(snippet, body, boxAbsentAtWrite)`：
  - 认不出输入框（首屏/信任页）→ **不按回车**（按了就是换行），到 20s 才给非 TUI harness 盲按兜底；
  - 框空且从没见过尾字、写入时框也没画出来 → 判定正文被丢，补写（最多 5 次，间隔 3s）；
  - 尾字还在框里 → 补按回车，但要求 pty 安静 ≥250ms（`SUBMIT_QUIET_MS`）才按，避开重绘合帧；
  - 5 分钟仍不成功时把尾屏 12 行打进日志，便于下次直接看现场。

### 仍未解（下次遇同类先看这里）

- 恢复首屏多久画完与历史长度正相关，20s 盲按窗是经验值；真遇到更长的恢复，看
  `[submit] 5 分钟仍未提交` 日志里的尾屏再调。

---

## 2026-11-09 · 傍晚那条带两张图的回复没到（又一次「发了没反应」）

### 现象

17:30、17:31 分别上传 IMG_0123／IMG_0124，回车发送——界面没报错，服务端**什么都没收到**；
17:35 手打重发同一条，正常送达（日志 `sendline 触发自动恢复`）。

### 定位（日志时间 UTC，本地要 +8）

- 17:28:41 服务重启，17:29:31 手机（192.168.11.86）重连成功，17:32:10 这条连接关闭。
- 17:30–17:33 服务端**零 sendline 帧**：既没有「在跑直投」也没有「需恢复」——不是注入失败，
  是消息帧根本没到。同一时段 HTTP 上传是通的（两个文件都落在 data/uploads/）。
- 17:35 那条能到，说明服务端代码路径正常。

### 根因

iOS 上从相册选图会离开 WebView，WS 被系统掐断；回来时 `readyState` 仍是 OPEN（TCP 半死），
`wsClient.send()` 返回 true——文字被吞，界面无任何提示。旧 `reconnectNow()` 见 OPEN 就 return，
连不上也不重连；服务端心跳要 60s 才回收，这段窗口里发什么丢什么。

### 修复

- 协议：`sendline` 带 `id`，服务端收下即回 `sendline-ack`；新增 `ping`／`pong`。
- 服务端 `gateway.ts`：每条 sendline 打一行日志（含字数、在跑/需恢复），两条路径都回 ack。
- 客户端 `ws.ts`：`sendline()` 返回 Promise，8s 没回执判未送达并强断重连；20s 一次 ping，
  45s 无 pong 认定假连接；`reconnectIfStale()` 供回前台时用。
- `PromptBar.vue`：等回执才清输入框；没送到就留着原文并提示「再按一次」。
- `main.ts`：visible／pageshow／online 改走 `reconnectIfStale()`。
