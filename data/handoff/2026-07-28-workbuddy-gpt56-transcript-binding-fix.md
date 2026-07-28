# WorkBuddy GPT-5.6 transcript 误绑定修复（2026-07-28）

- 第一阶段提交：`700a35c fix(transcript): prevent WorkBuddy cross-template binding`
- 第二阶段：把 WorkBuddy 从“收紧事后猜测”升级为确定性原生 UUID 绑定；提交号见本文最终验证节。

## 现象

Areco 中 WorkBuddy GPT-5.6 Remote 卡片实际已有 `~/.workbuddy/projects/.../*.jsonl` 对话数据，但“对话模式”为空；同一份 transcript 曾被 WorkBuddy DeepSeek 空卡错误认领。

## 根因与实机证据

旧绑定器在 epoch 生命周期窗口内只有一个非空 transcript 文件时，即使当前卡片没有首条输入哈希或其他内容证据，也会直接执行唯一候选兜底。DeepSeek 与 GPT-5.6 可共用同一 cwd，且启动时间相近；空 DeepSeek 卡先进入轮询后，就可能抢走随后出现的 GPT-5.6 文件。

`data/logs/server.log` 留有直接证据：

```text
按 epoch 窗口唯一候选兜底匹配 workbuddy 3c96e5ae
→ b35a697e-abbc-419c-8d49-cb45e46bfac0.jsonl

绑定 workbuddy 会话 3c96e5ae
↔ b35a697e-abbc-419c-8d49-cb45e46bfac0
```

其中 `3c96e5ae` 是 WorkBuddy DeepSeek 卡，`b35a697e-...` 是 GPT-5.6 原生会话。

此外，WorkBuddy 桌面桥接 transcript 主要写入 `~/.workbuddy/projects`，CodeBuddy CLI 常写入 `~/.codebuddy/projects`；macOS 临时目录还存在 `/tmp` 与 `/private/tmp` realpath slug 差异。只扫描单根目录或单一 cwd slug 会导致“文件存在但定位不到”。桌面 envelope 中真人指令位于最后一个 `<user_query>...</user_query>`，若拿完整系统上下文算哈希也无法正确认领。

## 修复内容

### `packages/server/src/services/agent-transcript.ts`

1. WorkBuddy 定位同时扫描 `~/.codebuddy/projects` 与 `~/.workbuddy/projects`。
2. `workbuddyProjectSlugs()` 同时覆盖 cwd 原值和 realpath，兼容 `/tmp` → `/private/tmp`。
3. `workbuddyUserQuery()` / `parseWorkbuddy()` 只显示并绑定最后一个 `<user_query>` 真人指令。
4. WorkBuddy 完全取消时间窗口和 `mtime` 猜绑：只有精确原生 ID或唯一内容证据才可绑定；首句被吞字、无证据、同首句/标题多候选时一律保持未绑定。
5. 已有确定性 `agentSessionId`、但目标文件尚未落盘时只等待精确文件，禁止退回内容或时间推断。
6. `locateCache` 命中后重新通过全局所有权闸；所有权变化时立即丢弃旧缓存，不能继续读取另一张卡的 transcript。
7. 新增 `workbuddyNativeSessionIdFromOutput()`，从桥接 PTY 的“已创建/已恢复会话 UUID”输出提取确定性原生 ID。

### `packages/server/src/services/session-manager.ts`

1. 官方 `harness: "workbuddy"` 新会话由 Areco 在启动前生成原生 UUID，并通过 CLI 原生 `--session-id <uuid>` 注入；官方历史恢复通过 `--resume <uuid>`，非恢复重启重新分配 UUID。
2. GPT-5.6 bridge 未声明官方 harness，不注入 `--session-id`；继续从 PTY 的创建/恢复输出取得原生 UUID，保留 512 字符短尾兼容 UUID 跨 chunk。
3. `agentKindOf(command, harness)` 改为 harness 优先，空 command 或包装器模板也能正确识别为 WorkBuddy。
4. native transcript 在全部在册卡片间全局一对一，卡片退出不释放所有权；PTY UUID 已有 owner 时一律拒绝第二次认领，不再根据 owner 是否有首句哈希自动换主。
5. 历史页和 `SessionManager.spawn()` 双层拒绝恢复已归属于另一张看板卡的 native transcript，避免内部调用绕过 API。
6. 历史恢复默认模板按 harness 优先查找，官方 WorkBuddy 优先于命令名相同的 bridge。

### `packages/server/src/services/agent-transcript.test.ts`

新增或调整回归测试，覆盖：

- 桌面 envelope 只提取最后一个 `user_query`；
- PTY 创建/恢复 UUID 跨 chunk 提取；
- macOS realpath slug；
- 空 DeepSeek 卡不得抢 GPT-5.6 唯一候选；
- 同 cwd 有竞争卡时关闭无证据兜底；
- GPT-5.6 通过明确首条输入哈希认领自己的文件；
- 首条输入被 TUI 吞字时也不做时间窗口猜绑；
- 占用过滤后只剩一个无内容证据的文件仍不绑定；
- 同首句或同标题命中多份 transcript 时视为歧义，不按 `mtime` 选最近文件；
- 预分配原生 ID 的精确文件尚未落盘时只等待；
- 退出卡仍保有 native transcript 所有权；
- 官方 WorkBuddy 新建/恢复参数注入，以及 GPT-5.6 bridge 不误注入官方参数。

## 真实数据核验

对当前 `data/sessions.json` 和本机 WorkBuddy transcript 全量扫描：

| Areco 卡片 | 模板 | 当前原生绑定 | 首条输入哈希命中 |
|---|---|---|---|
| `e40994e4` | workbuddy-gpt56-remote | `b35a697e-...` | 通用短句“在吗？”命中 5 份；已持久化精确 ID 优先 |
| `f2c4fe80` | workbuddy-gpt56-remote | `67680e1b-...` | 唯一命中，正确 |
| `b0c99ca9` | workbuddy-gpt56-remote | `3a7f54ff-...` | 唯一命中，正确 |
| `db8d4387` | workbuddy-gpt56-remote | 尚未持久化 | 唯一命中 `db72468b-87b7-4002-a801-568ee875cfcc` |
| `f17e52ad` | workbuddy-deepseek | 无 | 0 命中，应保持为空 |

`db8d4387.agentBindingHash` 与 `~/.workbuddy/projects/Users-gao-Desktop-民事案件-25民0512麦国祥vs麦少丽（离婚）（一审）/db72468b-87b7-4002-a801-568ee875cfcc.jsonl` 第一条真人指令标准化 SHA-256 完全一致，归属无需人工猜测。

未直接改写运行中 `data/sessions.json`，避免覆盖 8790 持续持久化的状态。新代码加载后应通过首条输入哈希或 PTY 原生 ID自动认领。

## 验证

- 第一阶段：定向 transcript 测试 31/31、全量测试 192/192、完整构建均通过。
- 第二阶段定向回归：55/55 通过，覆盖确定性 ID 注入、歧义拒绝、文件落盘等待、退出卡所有权和 bridge 隔离。
- 第二阶段全量 `npm test`：197/197 通过，0 失败。
- 第二阶段完整 `npm run build`：通过，包含客户端/服务端 typecheck、Vite 生产构建和服务端打包；仅有既存的大 chunk 体积警告，无构建错误。
- `git diff --check`：通过。
- 第二阶段提交：本次“确定性原生 UUID 绑定”独立提交（提交号以 Git 日志为准）。

## 部署门槛

本次没有、也不得在承载当前会话时重启 Areco 8790。服务端新逻辑必须由高律师择时重启，或由会话外 agent 执行重启后才进入生产运行态。

重启后需通过真实 API 复验：

1. `db8d4387` 的对话模式是否读取 `db72468b-...`；
2. 各 GPT-5.6 卡片是否分别读取自己的 transcript；
3. DeepSeek 卡片是否保持为空、不再抢占 GPT-5.6 数据。

## 回滚

回滚本次提交即可恢复旧绑定行为。注意旧行为会重新允许无输入凭据空卡按唯一候选猜绑，可能复现跨模板抢占，不建议只回滚其中一部分。

## 未办与风险

- 8790 未重启，因此当前生产进程仍运行旧服务端代码。
- 重启前无法对新代码路径做生产 `/api/sessions/:id/transcript` 端到端复验；本机真实文件归属和测试已完成。
- 通用首句（如“在吗？”）可能产生多个同哈希文件；已有 `agentSessionId` 和 PTY 原生 UUID 优先，不依赖该歧义哈希猜测。
