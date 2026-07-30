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
