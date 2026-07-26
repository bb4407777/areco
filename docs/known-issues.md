# areco 已知问题（待修，附修法）

> 建档：2026-07-26 | 来源：只读审计 + 逐条核码
> 本文只收「已核实、但**刻意没在本轮修**」的问题，并写明为什么没修、以及具体怎么修。
> 已修的不在这里（看 git log）。

---

## 1. 投递谎报成功（injectNote）—— 优先级最高

**位置**：`packages/server/src/services/room-relay.ts` · `injectNote` / `injectToMember` /
`serialAdvanceNext` / `deliverMentions`

**症状**：`injectNote` **同步**返回 nonce，但真正的 `sess.sendline` 发生在之后的
`sess.onceQuiet(...)` 回调里。三条路径会导致「一个字都没投出去」，而调用方已经拿着真值
nonce 写了 `status:'injected'`：

1. `onceQuiet` 的 `fire()` 末尾是 `if (this.isRunning) fn()`（`session.ts`）——会话在
   最长 30 秒的静默窗口内死掉，回调永不执行；
2. `sess.sendline` 抛错（会话已退出/被删）；
3. 回显校验耗尽 `ECHO_MAX_ATTEMPTS`。

**后果**：串行房间里成员 agent 崩掉 → `serialAdvanceNext` 记 `injected`、设
`current_target` + 10 分钟 deadline 然后返回。**整个房间的队列冻结 10 分钟**，直到
`sweepTimeouts` 解冻。剩下的 `queued` 投递在此期间不会被放行。

**本轮为什么没修**：这是核心投递状态机，而本轮全程**不能重启 8790**（硬红线：该服务
承载着当前会话）。改错的失败模式是「明明送达了却被记成 failed」→ 重复派发同一个任务给
agent，比现有 bug 更贵。没有运行时验证就动它不划算。

**本轮做了什么**：三条静默路径各加 `log.warn`（改动前完全无声），并把 `injectNote` 的
文档注释改成实话——它原先写着「失败返回 null」，而代码从不返回 null。
现在至少「冻了 10 分钟」这件事能在日志里查到。

**修法**（加 `onFailed` 回调，不必改返回类型）：

```ts
private injectNote(
  sessionId: string,
  note: string,
  onSent: (sess: Session) => void,
  onFailed?: (reason: string) => void,   // ← 新增
  attempt = 1,
): string
```

三处触发 `onFailed`：`sendline` catch 里、verify 超时且 `!sess.isRunning`、
`attempt >= ECHO_MAX_ATTEMPTS`。重发路径把 `onFailed` 一路带下去。

`injectToMember` 增一个 `onFailed` 形参透传。`serialAdvanceNext` 传：

```ts
() => {
  // 幂等闸：这条投递可能已被 sweepTimeouts 或人工操作推进过，别覆盖
  const cur = projectDb.deliveriesOf(dispatchId).find((d) => d.id === del.id)
  if (cur?.status !== 'injected') return
  projectDb.updateDelivery(del.id, { status: 'failed' })
  this.serialAdvanceNext(room, dispatchId)   // 立刻放行下一个，不等 10 分钟
}
```

**幂等闸是必须的**，否则 `onFailed` 与 `sweepTimeouts` 可能对同一条投递各推进一次。

**验证方式**（必须在能重启的时候做）：
1. 单测：`room-relay.test.ts` 里造一个 spawn 后立刻 exit 的 fake session，断言
   delivery 落到 `failed` 且下一个成员被放行；
2. 端到端：串行房间放两个成员，第一个 kill 掉，看第二个是否**立刻**（而非 10 分钟后）收到。

---

## 2. 删除/归档运行中会话不跨崩溃持久（session-manager）

**位置**：`session-manager.ts` · `remove()` / `pendingRemove` / `pendingArchive`；
`controllers/rooms.ts` · `RoomControllers.remove`

**症状**：对运行中会话调 `remove()` 只是把 id 加进**内存**的 `pendingRemove` 集合并发
SIGTERM，真正的删除在 `exit` 处理器里。`pendingRemove`/`pendingArchive` 从不持久化
（`persist()` 写的 `SessionSummary[]` 没有这个字段）。而 `RoomControllers.remove` 先
`rooms.remove(room.id)`（立即落盘）**再**循环 `manager.remove(id)`。

**后果**：删项目时若在 SIGTERM→SIGKILL 的 5 秒宽限期内进程被杀（launchd kickstart /
OOM / `/api/server/restart`），重启后会话被恢复成 `exitReason:'server-restart'`，
`roomId` 指向一个已经不存在的房间——**永久留在看板上，且任何级联都碰不到它**。

**修法**：① 把 pending 意图持久化（`SessionSummary` 加 `pendingRemove`/`pendingArchive`
布尔，`restore()` 里据此补做）；② `RoomControllers.remove` 先级联会话、后删房间；
③ 兜底：启动时扫一遍 `roomId` 指向不存在房间的会话并清理。

**为什么没修**：同 1，改的是生命周期状态机，需要重启 + 真删项目才能验。

---

## 3. `/api/server/restart` 可能把进程搞死，并泄一个 fd

**位置**：`controllers/api.ts` · restart 处理器；与 `index.ts` 的 `uncaughtException` 交互

`fs.openSync(path.join(process.cwd(), 'data/logs/restart.log'), 'a')` 在裸
`setTimeout` 回调里、没有 try/catch，`logFd` 也从不 close。若 `data/logs/` 不存在或
`process.cwd()` 不是仓库根（README 宣传的 `npm i -g areco` 场景），`openSync` 抛 →
`uncaughtException` → `index.ts` 的处理器见非 EPIPE 就 3 秒后 `process.exit(1)`。
此时响应已经回了 `{restarting:true}`，`start.sh` 根本没跑，所有 PTY 无快照死掉。

**修法**：整个回调包 try/catch；`spawn` 后 `closeSync(logFd)`；路径从 `ROOT_DIR`/
`ENTRY_DIR` 解析而不是 `process.cwd()`（`nearEntry()` 已有先例）；找不到启动脚本回 501。

**为什么没修**：这条路径**只在重启时执行**，而本轮不重启；改它又无法验证，属于「改了也
不知道对不对」。建议与重启动作同批做、当场验。

顺带：`index.ts` 里 `process.on('EPIPE', …)` 是死代码——Node 不发 `'EPIPE'` 进程事件，
真正起作用的是 `uncaughtException` 分支。

---

## 4. 并行派发先注入后查幂等

**位置**：`room-relay.ts` · `deliverMentions` 并行分支

```ts
for (const m of members) {
  const nonce = this.injectToMember(...)        // ← 副作用先发生
  const del = deliveries.find((d) => d.memberName === m.name)
  if (del && del.status === 'queued') { … }     // ← 幂等判断在后
}
```

串行分支是对的（先查 `busy` 再注入），并行分支反了。触发条件：areco 在人类发消息后 3 秒内
重启，首轮快进把「新消息」重放进 `onMessageStored`。底账不会脏（`createDispatch` 幂等、
既有投递已是 `injected`），但**每个成员的终端会再收到一遍同样的任务**，两个 agent 干同一件事。

**修法**：把 `del.status === 'queued'` 判断提到 `injectToMember` 之前，与串行分支对齐。
改动很小，但同属投递路径，建议与问题 1 同批修同批验。

---

## 5. RoomStore 吞写失败、且解析失败会清空 rooms.json

**位置**：`services/rooms.ts` · `save()` / `load()` / `atomicWrite`

`save()` catch 一切只 `log.error`，于是 `create`/`addMember`/`setRootPath`/`archive`
都会在**没写成盘**的情况下回 200。对称地，`load()` 遇 JSON 错返回 `[]`，而下一次
`save()` 就把这个 `[]` 写回去——**39 个房间 + 73 个成员绑定一次性永久蒸发**。
`atomicWrite` 只有 `writeFileSync(tmp)` + `renameSync`，两者都没 `fsync`，掉电正好能
留下触发上述路径的截断文件。

**修法**：`save()` 让异常抛出去（controller 的 `guard()` 本来就会转 400）并回滚内存改动；
`load()` 解析失败时把坏文件改名 `rooms.json.corrupt-<ts>` 并**拒绝**覆盖；rename 前
对 tmp fd `fsyncSync`。`persistence.ts:15-19/50-62` 已有正确写法可抄。

**为什么没修**：`load()` 那半边改起来安全，但 `save()` 从「吞」改成「抛」会改变所有房间
写操作的失败语义（原先静默成功、之后会 400），需要过一遍前端的错误处理，本轮没余量。

---

## 6. 其他（已核实，量小，未修）

| 位置 | 问题 |
|---|---|
| `room-relay.ts` · `tick()` | `history()` 在 `archivedAt` 判断**之前**调用，23 个已归档房每 2 秒白拉 50 行。需要 max(id) 才能推进游标，故要先给 project-db 加个轻量 `lastMessageId(team)` 再挪 |
| `room-relay.ts` · `serialAdvanceNext` | `updateDelivery` 与 `setDispatchState` 走两个连接、未包事务。中间崩溃会留下 `state='active'` 且 `current_target`/`deadline` 皆 NULL 的孤儿 dispatch，`sweepTimeouts` 跳过它、`advanceSerial` 匹配不到，该房间的派发**永久卡死**。修：一个连接一个事务 + 启动时扫 active 且 current_target 为 NULL 的行 |
| `ws/gateway.ts` · `attach()` | 同一 session 并发 attach 时，重入闸 `att.snapshotPending === false` 挡不住——第二次 attach 换掉了 map 里的对象，两次都判 pending。应改成比对象身份（`att !== myAtt → return`）。症状是重复快照 / 偶发丢一块输出 |
| `services/templates.ts` · `transcriptDirMemo` | 按 template id 缓存且从不失效，改了模板 `command` 后仍用旧探测结果直到重启 |
| `controllers/api.ts` · `fileUploadInner` | 写流可能还在 flush 时就 `fs.rmSync` 目标 |
| `services/files.ts` | `data/preview-cache` 无淘汰 |
| `RoomRelay.stop()` | 不解绑 `manager.on('removed')`，`stop()`→`start()` 会重复注册 |

---

## 不修（已由高律师定）

**零认证**：`config.json` 的 `insecureNoAuth: true` + 空 `passwordHash` +
`fileRootsUnrestricted: true` + 绑 `0.0.0.0`。2026-07-26 高律师明示「特意设计的，
本地网络只连自己设备，不改」。

配套事实（供日后重新评估时参考，不是要求改）：现有的 X-API-Key 守卫是**装饰性**的——
`createApiKeyGuard` 只对「带了错 key」回 401，**完全不带 key 会 fall through 到
sessionGuard**，而后者在 `auth.enabled === false` 时直接放行。所以那把 key 目前不保护
任何东西。另 `isApiKeyScope` 不含 `/api/tasks`，一旦将来设了密码，StandCode 的 caller
就够不着任务提交接口了。
