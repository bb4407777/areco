# StandCode + Areco 整合优化 — 进度文档

> 更新：2026-07-25
> 作者：Hermes（Caller）

---

## 目录

- [架构现状](#架构现状)
- [已完成](#已完成)
- [被打断/暂停](#被打断暂停)
- [待做](#待做)
- [时间线](#时间线)

---

## 架构现状

### 角色分层

| 角色     | 主体                           | 默认模型                  | 职责               |
| -------- | ------------------------------ | ------------------------- | ------------------ |
| Caller   | Hermes（微信通道 → areco）     | —                         | 路由、决策、派发、主动轮询、代发微信 |
| Thinker  | stand-thinker-workbuddy        | WorkBuddy + DeepSeek-v4-pro | 规划、分析、判断、路由 |
| Worker   | claude                         | Claude CLI + GLM-5.2      | 代码、搜索、文书、下载、总结 |

### 备选 Worker

| 模板 ID                | 说明                       |
| ---------------------- | -------------------------- |
| `claude`               | Claude CLI + GLM-5.2（默认 Worker） |
| `workbuddy-deepseek`   | WorkBuddy + DeepSeek-v4-flash |
| `workbuddy-deepseek-pro` | WorkBuddy + DeepSeek-v4-pro |
| `codex`                | gpt-5.6-sol               |
| `zcode`                | ZCode（需 `BIGMODEL_API_KEY` 环境变量） |

### 使用流程：秒回 + 同回合并行派发

1. Hermes 收到微信请求 → 秒回确认
2. 同轮派发 Thinker（plan_only）和 Worker（执行），`run --bg` 异步 inbox
3. Stand 完成后 `caller.py` 写入 inbox → cc-send 极简触发消息 → Hermes 读到后汇总发微信
4. 多 Stand 并行结果走 `aggregate_results()` 合并回执

### 核心组件

| 组件            | 路径                                              | 说明                      |
| --------------- | ------------------------------------------------- | ------------------------- |
| Caller 核心     | `$STANDCODE_ROOT/caller/caller.py`      | 调度引擎（dispatch/poll/relay/plan） |
| Registry        | `$STANDCODE_ROOT/stand/registry.json`   | 7 模板 + 5 类任务映射      |
| API 文档        | `$STANDCODE_ROOT/docs/api.md`           | v0.4 完整协议              |
| StandCode SKILL | `~/skills/standcode/SKILL.md`            | Hermes Caller 行为手册     |
| Areco 模板      | `$ARECO_ROOT/config.json`               | 14 个模板含 StandCode 4 个 |
| Inbox 目录      | `$STANDCODE_ROOT/data/inbox/`           | 异步回调结果存储            |

---

## 已完成

### 1. Caller 核心引擎 `caller/caller.py` — `dispatch` / `poll_result` / `dispatch_and_wait` / `run --bg`

**状态**：✅ 完成

**内容**：

- `dispatch()` — 模板选择优先级：`template_id > task_type 映射 > role 默认 > default_template`
- `poll_result()` — Caller 主动轮询 Stand 结果，不依赖 Stand 自汇报 cc-send。支持 `stand_session_id` 提前退出检测（10s 心跳，避空等满 timeout）
- `dispatch_and_wait()` — 派发 + 等待一站式（保留向后兼容）
- `dispatch_and_relay()` — 派发 → 轮询 → 微信代发，超时/异常也代发告知
- `plan_and_execute()` — Thinker 出结构化 plan → Worker 按计划执行，缺步骤判定 `plan_failed`
- `auto_dispatch()` — `should_plan` 门控自动选路
- `aggregate_results()` — 多 Stand 并行结果/追问汇总（5 段式：总体状态 / 各结论 / 文件 / 追问 / 下一步）
- **CLI 入口**：`run`（前台/`--bg`）/ `status` / `list` / `aggregate`
- 后台 `run --bg`：`start_new_session` 独立进程 → 状态落 `~/.standcode/tasks/` → 日志独立

### 2. 注册表 `stand/registry.json` — 7 模板 + 5 类任务映射

**状态**：✅ 完成

**内容**：

- 7 个模板：`stand-thinker-default` / `stand-thinker-workbuddy` / `stand-worker-default` / `stand-worker-fast` / `zcode` / `workbuddy-deepseek` / `workbuddy-deepseek-pro`（部分按需挂载到 areco config.json）
- 5 类任务映射：`think → stand-thinker-workbuddy` / `plan → stand-thinker-workbuddy` / `execute → claude` / `work → claude` / `fast → stand-worker-fast`
- 角色层级：`default_thinker: stand-thinker-workbuddy` / `default_worker: claude`

### 3. 角色分层：Caller(Hermes) / Thinker(stand-thinker-workbuddy) / Worker(claude)

**状态**：✅ 完成

**内容**：

- Caller(Hermes)：路由、决策、派发、主动轮询、代发微信 — `stand/registry.json` 的 `default_thinker` / `default_worker`
- `caller.py` 中 `dispatch_thinker()` / `dispatch_worker()` 便利方法
- `plan_only=True` 强制 Thinker 结构化 "目标/上下文/步骤/约束/判据/落点" — `PLAN_TEMPLATE` 常量
- 门控 `should_plan()` 关键字 + `_parse_plan()` 解析校验

### 4. Hermes 提升为房间同级权限（room-relay.ts 排查修复）

**状态**：✅ 完成

**内容**：

- areco `config.json` → `humanRelayAgents: ["Hermes"]`：Hermes 进入转述白名单
- `room-relay.ts` 排查确认：白名单内 agent 带 `human_relay=1` 的消息清零链深 + 无 `@` 默认投全体，不触发防环闸
- `caller.py` 直写 SQLite 的 `send_message()` 默认 `human_relay=True`
- 测试覆盖：`room-relay.test.ts` 两条 Hermes 白名单用例（转述清零链深、名单外打标无效）

### 5. API 文档 `docs/api.md` v0.4 — 完整协议文档

**状态**：✅ 完成

**内容**：

- 完整 Caller API 协议（12 节，674 行）：dispatch / poll_result / relay_to_wechat / dispatch_and_relay / plan_and_execute / aggregate_results / async inbox
- 角色层级、架构示意、消息协议、错误处理、环境变量
- 房间生命周期、CLI 参考、测试示例

### 6. StandCode SKILL.md — Caller 行为手册

**状态**：✅ 完成

**内容**：Hermes 调用 StandCode 的行为手册。

### 7. Areco config.json 模板配置

**状态**：✅ 完成

**内容**：areco `config.json` 中已配以下 StandCode 相关模板：

| 模板 ID                    | 命令                                                    | 模型                |
| -------------------------- | ------------------------------------------------------- | ------------------- |
| `claude`                   | `claude` CLI                                            | GLM-5.2             |
| `stand-thinker-workbuddy`  | WorkBuddy CLI `--model deepseek-v4-pro`                 | DeepSeek-v4-pro     |
| `stand-worker-default`     | `qclaw-stand-wrapper.py --model pool-glm-5.2`           | GLM-5.2             |
| `zcode`                    | `node zcode.cjs --prompt --mode yolo`                   | BIGMODEL             |

### 8. ZCode 模板配入

**状态**：✅ 完成

**内容**：

- areco `config.json` 含 `zcode` 模板（`node zcode.cjs --prompt --mode yolo`）
- registry.json 含 `zcode` 模板（role: worker）
- 注：需 `BIGMODEL_API_KEY` 环境变量方可运行

### 9. 异步回调 inbox 机制

**状态**：✅ 完成

**内容**：

- `data/inbox/{task_id}.json` — 后台任务完成后 caller 写入完整结果
- `send_callback_trigger(task_id)` → cc-send 极简触发消息 "任务 xxx 完成，Hermes 正在汇总…"
- `process_inbox_callback(task_id)` — Hermes 入口：读 inbox → 汇总 → 发微信 → 清理
- `.processing` 锁文件防并发
- 异常也写 inbox（不直接发完整异常消息）
- API：`write_inbox` / `read_inbox` / `delete_inbox` / `acquire_processing_lock` / `release_processing_lock` / `summarize_inbox`

**Inbox JSON 格式**：

```json
{
  "task_id": "bg-1743064900-a1b2c3",
  "room_id": "a1b2c3d4",
  "stand": "Thinker via WorkBuddy DeepSeek-v4-pro",
  "role": "worker",
  "status": "completed",
  "result_text": "已完成…",
  "files": ["/path/to/result.docx"],
  "request_summary": "一句话结论",
  "request": "任务描述（前 200 字）",
  "error": null,
  "inbox_created_at": "2026-07-25T12:00:00Z"
}
```

---

## 被打断/暂停

### Areco 前端 UI 导航文字修改

**状态**：⏸ 暂停

**内容**：areco 前端 UI 导航文字调整 — "看板" → "会话"、"项目" → "任务"

### Reasonix × QClaw shim 修复

**状态**：⏸ 暂停（已修复）

**内容**：Reasonix 与 QClaw 的桥接 shim 之前已修复并验证通过。

---

## 待做

### 微信代发 inbox 完整流程验收

**状态**：⏳ 待做

**内容**：端到端测试 inbox 流程：微信发任务 → Hermes 秒回 → caller `run --bg` 派发 Stand → Stand 完成 → 写 inbox + 触发消息 → Hermes 读触发 → `process_inbox_callback` 汇总 → 微信回执

### caller.py 模板默认值与 registry.json 对齐校验

**状态**：⏳ 待做

**内容**：检查 `DEFAULT_TASK_MAP` / `DEFAULT_TEMPLATE_ID` / `default_thinker_id` / `default_worker_id` 硬编码常量与 `stand/registry.json` 中的映射是否一致，找出差异并统一切换到 registry 驱动。

---

## 时间线

| 日期       | 事项                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 2026-07-25 | docs/api.md v0.4 定稿；async inbox 机制完成；registry.json 7 模板定型 |
| 2026-07-24 | caller.py dispatch/relay/inbox 主干完工                                |
| 2026-07-23 | Hermes humanRelayAgents 白名单配置 + room-relay.ts 测试                |
| 2026-07-22 | areco config.json 增配 claude / stand-thinker-workbuddy / zcode       |
| （前期）   | Reasonix × QClaw shim 修复；StandCode SKILL.md 编写                    |
