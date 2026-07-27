# 对话模式显示不到会话内容 · 双绑体检修复

- 日期：2026-07-27
- 经手：Claude Code（Glm5.2）
- 范围：`packages/server/src/services/session-manager.ts` · `session-dedup.ts`（新）· `session-manager.test.ts`（新）
- commit：（待提交——working tree 另有 rooms/patrol WIP 未提交，本棒只 add 下列文件）

## 现象

用户报：下午 19:05 重启 8790 后，areco 会话切到对话模式看不到内容（workbuddy/kimi 多个会话空白）。
"思考内容能显示、对话正文不能"——因思考走另一条流（ThinkingStream，直接取 transcript part），
不经过会话绑定；正文必须先靠绑定定位到原生 jsonl 文件才能解析。

## 根因（两个独立 bug，同源于 spawn 不注入 id）

### 主犯 · KIMI 双绑（本次回归的直接原因）

- `2579f70e` 与 `b85b8b53` 两张卡片都把 `agentSessionId` 绑成同一个 `session_c385d78c`。
- 占用闸（`session-manager.ts:60` 注册的 occupancyProvider）只查 `s.isRunning`：
  - A 绑底层 X → A 退出（not running）→ B 绑 X（A 退出时不占，闸放行）→ A 恢复（running）→ 双绑落定。
- 旧进程（06:29 启动）期间靠 `locateCache`（11:56/11:58 那次绑定命中）续命，绕过选择逻辑 → 两个都能读。
- **19:05 重启清空 locateCache** → 重新 locate 时走 `bindCandidate`/`exactAgentFile`，占用闸互斥
  （两个活会话争同一原生文件）→ 两个都 locate 不到 → `readAgentTranscript` 返回 `{exists:false, messages:[]}` → 空白。
- 铁证：旧进程 server.log `11:56:49 绑定 kimi 会话 2579f70e ↔ session_c385d78c`、
  `11:58:39 绑定 kimi 会话 b85b8b53 ↔ session_c385d78c`（两个都绑成功）；新进程实测 messages=0。

### 次犯 · WB 没绑（独立老问题，非本次回归）

- `9a0d6db2`（WorkBuddy DeepSeek Pro #2）：spawn 没注入 agentSessionId、没 bindingHash，
  卡片名还是模板名；其 epoch 窗口（10:29±）有 `7c314072`（1.3MB）等多个候选，唯一候选兜底不生效，
  evidenceMatch 选不中 → 一直空白（11:49 旧进程期间即"未找到"）。

### 总根

`templates.ts:121-123` 的 `buildSpawnSpec` 只对 claudeHome 系注入 `--session-id`/`--resume`；
workbuddy/kimi 系出生时不注入任何 id，全靠事后 `bindAgentSession` 模糊回填——这是 WB 没绑 + KIMI 双绑的共同根源。

## 修复（本轮落地）

### 1. 双绑启动体检（治主犯 · 存量兜底）

- `SessionManager.restore()` 末尾加 `this.dedupBindings()`：启动加载完所有持久化会话后扫一次，
  多个会话同绑一个 nativeId 的，留 `startedAt` 最早的（原主），其余 `clearAgentBinding()` + `dropAgentTranscriptCache()` 解绑清缓存，让其重新 locate 自己的真文件。
- 核心分组逻辑抽成纯函数 `duplicateBindingVictims`（`session-dedup.ts`，独立模块避免测试经
  SessionManager 拖入 `@xterm/headless` 运行时依赖）。
- 单测 6 例（`session-manager.test.ts`）：双绑/三绑/单绑/未绑/startedAt 缺失/混合，全过。

### 2. WB 兜底（审视后判定不加）

`9a0d6db2` 场景（没 id + 窗口多候选 + 无 prompt 证据），locate 强行取最新会绑到 `7c314072`，
若是别人的就重演幽灵卡（串读）。现有 `bindFromPools` line 391-397 的"epoch 唯一候选兜底"是安全边界，不动。WB 解药并入下面的根治项。

## 根治提案（已验证：CLI 不支持，途径 A 不可行）

**原设想**：spawn 时给 workbuddy(codebuddy)/kimi 系注入唯一 agentSessionId（像 claude 系 --session-id），出生即唯一。

**实测结论（2026-07-27）**：codebuddy/kimi 的 session-id 参数是**纯恢复语义**，不接受指定新 id 起新会话——
- `kimi -S session_<新uuid>`（新 id）→ **报错 `failed to start shell: Session "..." not found`**，不新建。
  （areco `api.ts:553` 的 `-S <id>` 只用于 history 恢复已存在会话，id 来自既有 wire。）
- codebuddy `--resume <uuid>` 同理（areco `session-manager.ts:250-256` 找不到原生文件就不传 --resume，即为此）。
- 即「指定 id 起新会话」途径 A 走不通——codebuddy/kimi 的 session id 由 CLI 自身随机生成，外部无法指定。

**当前方案**：双绑体检（本轮）堵存量 + 启动双绑；占用闸防 running 互斥。已覆盖实测场景（2579f70e/b85b8b53 各 80 条正常）。

**若要运行时根治双绑**（体检只在 restart 跑）：唯一可行的是途径 B——spawn 后监听落盘目录，捕获**该 cwd 下 spawn 后首个新文件**，提取其真实 id 确定性回绑（CLI 无关，但有时序竞争、实施复杂、收益有限）。单列待办，非本轮。

## 验证

- `npm test`：**179 pass / 0 fail**（新增 6 例 + 原 173）。
- server `tsc --noEmit`：本次新增/改动文件零错。
  注：`room-dispatch.test.ts:54` 的 `tick unused` 报错是 **pre-existing WIP**（working tree 既有，非本棒引入）。
- `node scripts/build-server.mjs`：bundle 成功，`dedupBindings`/`duplicateBindingVictims` 符号已进 `dist/server/index.cjs`。

## 回滚

删 `restore()` 里的 `this.dedupBindings()` 调用即可（体检是纯增量、无副作用，
解绑的会话下轮 read 会重新 locate——最坏回到双绑空白态，不会更糟）。`session-dedup.ts`、
`session-manager.test.ts` 可一并删。

## 部署

- 服务端改动，需 **restart 8790** 生效（dist/server/index.cjs 已于 20:36 重建）。
- ⚠️ 当前 dist 含 working tree 既有的 rooms/patrol WIP（`room-relay.ts` 大改、`room-dispatch.test.ts`、
  `api-error-continue.mjs`，均非本棒）——restart 前请确认该 WIP 完整，或先 stash 再 rebuild 干净 dist。
- restart 会终止舱内现有会话（2579f70e/b85b8b53 等），由高律师择时。

## 防回归机制（本棒示范）

本档案即"每个新功能/修复 = 独立工程文件记录"规范的示范：根因、代码落点、验证、回滚、
部署、未办全部写清，下次若再出"对话模式空白"，先查本档案 + git log，定位是不是双绑回归或
体检被改坏，而不是从零排查。规范本身待落 CLAUDE.md（见 CLAUDE-inbox 提议）。
