# StandCode Caller API 协议文档

> 版本: v0.4 | 更新: 2026-07-25
> 作者: Hermes（Caller）

---

## 概述

StandCode Caller 是多 agent 调度框架的核心入口（角色 **Caller**）。它负责：

1. 接收 Client（微信）的自然语言请求
2. 按角色（Thinker / Worker）与任务类型选择合适的 Stand
3. 在 areco 房间中创建/复用 Stand（worker agent session）
4. 投递任务消息，通过房间 relay 机制注入 Stand 的终端
5. **主动轮询**房间消息流，收集 Stand 执行结果（不再依赖 Stand 自汇报 cc-send）
6. **代发微信**：把结果模板化（一句话结论 + 文件路径 + 核心要点 3-5 条）发回 Client
7. **异步回调**（`run --bg`）：结果写入 `data/inbox/`，仅发极简触发消息到微信，由 Hermes 读取 inbox 后汇总发回

### 角色层级（Caller / Thinker / Worker）

| 角色     | 组件                       | 默认模板               | 职责                                   |
| -------- | -------------------------- | ---------------------- | -------------------------------------- |
| Caller   | Hermes（Caller，本模块）   | —                      | 路由、决策、派发、主动轮询、代发微信   |
| Thinker  | 思考型 Stand               | `claude`（GLM-5.2）    | 规划、分析、判断、路由                 |
| Worker   | 执行型 Stand               | `reasonix`（DeepSeek-v4-flash） | 代码、搜索、文书、下载、总结           |

> 任务含规划需求时，Caller 可用 `plan_and_execute()` 两段式：先派 Thinker 出计划，再派 Worker 执行。

### 架构示意

```
微信 ──→ Caller(Hermes) ──→ dispatch() ──→ areco REST API ──→ 创建房间
        (Caller)                            │                    └── 添加 Stand（Thinker/Worker）
                                            ▼
                                       直写 SQLite ──→ 投递消息到房间
                                                         │
                                                         ▼
                                                    房间 Relay 注入 Stand 终端
                                                         │
                                                    Stand 会话处理
                                                         │
                                                    回复消息落库
                                                         │
                                  Caller poll_result() ←┘ （主动轮询，不靠 Stand 自汇报）
                                                         │
                           ┌─ 前台同步 ───────────────────┤
                           │  Caller relay_to_wechat() ───→ 微信（结论+文件+要点）
                           │
                           └─ 后台异步（run --bg）────────┤
                                      写 data/inbox/{task_id}.json
                                        │
                                     cc-send 触发消息 ──→ 微信（极简：「任务 x 完成，Hermes 正在汇总…」）
                                                           │
                                                     Hermes 读到触发消息
                                                        │
                                                  读取 inbox 文件
                                                        │
                                                  summarize_inbox() ──→ 微信（结论+文件+要点）
                                                        │
                                                  清理 inbox 文件
```

### 角色（数据流视角）

| 角色   | 组件                     | 职责                                |
| ------ | ------------------------ | ----------------------------------- |
| Client | 微信对话（用户）         | 提出任务需求                        |
| Caller | Hermes（本模块）         | 决策、分发、主动轮询、代发微信      |
| Stand  | areco 房间中的 agent 会话 | 执行具体任务，产生结果              |
| 底座   | areco 服务 (127.0.0.1:8790) | 房间管理、会话生命周期、消息投递 |

---

---

## 异步回调（Callback）协议

### 概述

后台任务（`run --bg`）不再直接向微信发送完整结果。改为两步走：

1. **caller 写入 inbox**：任务完成后，把结果写入 `data/inbox/{task_id}.json`
2. **触发消息**：caller 通过 cc-send 发一条极简消息：`任务 {task_id} 完成，Hermes 正在汇总…`
3. **Hermes 汇总**：Hermes 读到该消息后，读取 inbox 文件，按模板汇总后发回微信
4. **清理**：汇总完成后删除 inbox 文件

### Inbox 目录

```
$STANDCODE_ROOT/data/inbox/
  ├── bg-1743064900-a1b2c3.json        # 任务结果
  ├── bg-1743064900-a1b2c3.processing  # 锁文件（防并发）
  └── ...
```

### Inbox JSON 格式

```json
{
  "task_id": "bg-1743064900-a1b2c3",
  "room_id": "a1b2c3d4",
  "stand": "Reasonix QClaw DeepSeek-v4-flash",
  "role": "worker",
  "status": "completed",
  "result_text": "已完成…（完整结果正文）",
  "files": ["/path/to/result.docx"],
  "request_summary": "一句话结论",
  "request": "任务描述（前 200 字）",
  "error": null,
  "inbox_created_at": "2026-07-25T12:00:00Z"
}
```

### 触发消息格式

后台 caller 通过 cc-send 发送的消息格式：

```
任务 bg-1743064900-a1b2c3 完成，Hermes 正在汇总…
任务 bg-1743064900-a1b2c3 完成，Hermes 正在汇总（后台任务完成）…
任务 bg-1743064900-a1b2c3 完成，Hermes 正在汇总（异常）…
```

### Hermes 汇总入口（CLI）

```bash
python3 $STANDCODE_ROOT/caller/caller.py _process_inbox <task_id>
# 返回: {"ok": true, "task_id": "...", "message": "汇总内容", "action": "relayed"}
```

### Hermes 汇总入口（Python）

```python
from caller import process_inbox_callback

result = process_inbox_callback("bg-1743064900-a1b2c3")
# result["action"]: "relayed" | "locked" | "not_found" | "error"
```

### 汇总输出模板

```
✅ <一句话结论>
📄 文件：<文件路径>
核心要点：
1. …
2. …
（最多 5 条）
```

### 并发防护

使用 `.processing` 锁文件：处理前写入 `{task_id}.processing`，完成后删除。其他进程检测到 `.processing` 存在则跳过（返回 `locked`）。

### 编程接口

| 函数 | 说明 |
| ---- | ---- |
| `write_inbox(task_id, payload)` | 写入 inbox 结果 |
| `read_inbox(task_id)` | 读取 inbox 文件 |
| `delete_inbox(task_id)` | 删除 inbox + 锁文件 |
| `acquire_processing_lock(task_id)` | 获取 .processing 锁 |
| `release_processing_lock(task_id)` | 释放 .processing 锁 |
| `send_callback_trigger(task_id)` | 发送极简触发消息 |
| `summarize_inbox(payload)` | 按模板汇总 inbox 内容 |
| `process_inbox_callback(task_id)` | 完整回调：读→汇总→发→清理 |

---

## Caller 类

### `Caller()`

```python
from caller import Caller

caller = Caller(
    base_url="http://127.0.0.1:8790",  # areco 服务地址
    projects_db="$ARECO_ROOT/data/tasks.db",  # SQLite 消息库
    registry_path="stand/registry.json",  # Stand 注册表
)
```

加载后实例属性：

| 属性                  | 说明                                                |
| --------------------- | --------------------------------------------------- |
| `default_template_id` | 全局默认模板（`claude`）                            |
| `default_thinker_id`  | Thinker 默认模板（`claude` / GLM-5.2）              |
| `default_worker_id`   | Worker 默认模板（`reasonix` / DeepSeek-v4-flash）   |
| `task_map`            | task_type → 模板映射（专家分派）                    |
| `roles`               | 模板 id → `"thinker"` \| `"worker"`                 |
| `template_names`      | 模板 id → 显示名                                    |

---

### `dispatch()`

派发任务给 Stand。

```python
result = caller.dispatch(
    request="请搜索2026年最高法典型案例",  # str        - 任务描述
    task_type=None,                        # str|None   - 任务类型（None=不按类型分派）
    room_id=None,                          # str|None   - 指定房间 ID，None=新建
    template_id=None,                      # str|None   - 指定模板 ID，None=自动选择
    role=None,                             # str|None   - 'thinker' | 'worker' | None
)
```

#### 模板选择优先级

`template_id` > `task_type` 映射 > `role` 默认 > `default_template`

- `role="thinker"` → `default_thinker`（claude / GLM-5.2）
- `role="worker"` → `default_worker`（reasonix / DeepSeek-v4-flash）
- `task_type` 走专家映射（见下表），无映射或未指定时落到角色默认

#### 任务类型 → 模板映射（worker 类任务默认 Reasonix）

所有 worker 类任务默认走 **Worker = reasonix**（DeepSeek-v4-flash）。需换备选 Worker 时用 `--template` 显式指定。

| 任务类型   | 默认模板   | 说明                |
| ---------- | ---------- | ------------------- |
| search     | reasonix   | 搜索/信息检索       |
| coding     | reasonix   | 编程开发            |
| writing    | reasonix   | 文书写作            |
| analysis   | reasonix   | 分析推理            |
| general    | reasonix   | 通用任务            |

备选 Worker（`--template` 显式指定）：

| 模板 id              | 说明                          |
| -------------------- | ----------------------------- |
| `claude-glm52`       | GLM-5.2（亦是 Thinker 默认）  |
| `workbuddy-deepseek` | WorkBuddy DeepSeek            |
| `codex-gpt56`        | gpt-5.6-sol                   |
| `kimi-k3`            | Kimi K3（额度紧张，仅显式指定）|

#### 返回值

```json
{
    "task_id": "task-a1b2c3d4e5f6",   // 本次任务唯一 ID
    "session_id": "room-a1b2c3d4",    // 房间 team 名，用于 poll_result
    "room_id": "a1b2c3d4",            // 房间短 ID（REST API 路径用）
    "room_name": "Stand-worker-general-a1b2c3",
    "stand_name": "GLM-5.2",          // Stand 成员名
    "stand_session_id": "uuid-xxxx",  // Stand 的 areco session ID
    "message_id": 42,                 // 已投递的消息 ID
    "task_type": "general",           // 实际使用的任务类型
    "template_id": "reasonix",        // 实际使用的模板 ID
    "role": "worker"                  // 'thinker' | 'worker'
}
```

---

### `dispatch_thinker()` / `dispatch_worker()`

角色分派便利方法。

```python
# 派给 Thinker（默认 GLM-5.2）：规划、分析、判断、路由
caller.dispatch_thinker("请分析这份合同的风险点")

# 派给 Worker（默认 Reasonix / DeepSeek-v4-flash）：执行型任务
caller.dispatch_worker("请把这份转写整理成 200 字摘要")
```

签名与 `dispatch()` 一致（不含 `role`，内部已固定）。返回值同 `dispatch()`。

---

### `poll_result()`

**Caller 主动轮询** Stand 执行结果（不再依赖 Stand 自汇报 cc-send）。

```python
result = caller.poll_result(
    room_id="a1b2c3d4",            # str|None - 房间短 ID（REST 兜底/日志）
    session_id="room-a1b2c3d4",    # str      - dispatch() 返回的 session_id（必填）
    timeout=600,                   # int      - 最大等待秒数（默认 600）
    poll_interval=2.0,             # float    - 轮询间隔
    stand_session_id="uuid-xxxx",  # str|None - 用于检测 Stand 提前退出
    after_id=0,                    # int      - 只看 id>此值的消息（续跑）
)
```

#### Stand 回复识别

只把**非 Caller、非用户**的消息算作 Stand 的执行结果（排除 `Hermes` / `用户` / `all` / `system`）。

#### 提前退出检测

若传入 `stand_session_id`，轮询期间每 10s best-effort 查 `GET /api/sessions` 的 `status`；
Stand 已 `exited` 但仍无回复时立即返回 `status: "error"`，避免空等满 timeout
（直击「Stand 经常退出前没回执」的痛点）。

#### 返回值

```json
{
    "session_id": "room-a1b2c3d4",
    "room_id": "a1b2c3d4",
    "status": "completed",                // completed | timeout | error
    "result_text": "已完成…\n要点1…",      // Stand 回复合并文本（completed 才有）
    "stand_replies": [ /* 仅 Stand 的消息 */ ],
    "elapsed": 12.34,                     // 耗时（秒）
    "completed_at": "2026-07-25T12:00:00Z",
    "messages_count": 10,
    "error": null
}
```

---

### `relay_to_wechat()`

把 Stand 结果**代发到微信**（Caller 主动回执）。

```python
result = caller.relay_to_wechat(
    message="已完成…正文…",      # str        - Stand 结果正文（poll_result['result_text']）
    summary="一句话结论",        # str|None   - 一句话结论；None 时自动提炼首行
    file_path="/path/to.docx",   # str|None   - 产物文件路径
    dry_run=False,               # bool       - True=只拼装不发送（测试用）
)
```

底层调用：

```bash
HOME=$HOME $CC_SEND_BIN \
  -s weixin:dm:<你的会话id>@im.wechat -m "<内容>"
```

纯文字消息（`-m`）不经 `.ok` gate。微信消息格式：

```
✅ <一句话结论>
📄 文件：<路径 或 （无）>
核心要点：
1. …
2. …
（最多 5 条）
```

#### 返回值

```json
{ "ok": true, "dry_run": false, "content": "…", "stdout": "…", "returncode": 0 }
```

可被环境变量覆盖：`CC_SEND_BIN`、`WECHAT_TARGET`、`STANDCODE_HOME`。

---

### `dispatch_and_relay()`

**一键派发 → 主动轮询 → 代发微信**。

```python
result = caller.dispatch_and_relay(
    request="请总结这份转写",
    task_type=None,
    request_summary="某教程转写摘要",  # 一句话结论
    role="worker",                               # thinker | worker | None
    file_path="/path/to/transcript.docx",
    poll_timeout=600,
    dry_run=False,                               # 测试时 True
)
# 返回 dispatch() + poll_result() + {relay_summary, wechat, relayed}
```

- Stand 完成 → 代发结果；超时/异常 → 代发一条「任务未完成」告知（dry_run 时只拼不发）。

---

### `plan_and_execute()`

**Caller 两段式**：任务含规划需求时，先派 Thinker 出计划，再把计划交给 Worker 执行。

```python
result = caller.plan_and_execute(
    request="帮我调研并产出一份 AI 工作流教程的摘要文档",
    request_summary="…",
    file_path="…",
    poll_timeout=600,
    dry_run=False,
)
# 返回 {stage, plan, execute, plan_text, result_text, wechat, relayed}
```

- `stage="plan_failed"` 表示 Thinker 未产出计划，跳过执行阶段。

---

### `dispatch_and_wait()`

派发 + 等待（不含微信代发，旧便捷方法，保留向后兼容）。

```python
result = caller.dispatch_and_wait(request="…", task_type="analysis", timeout=300)
# 返回 dispatch() + poll_result() 的合并结果
```

---

### `aggregate_results()`

把**多个 Stand 并行结果 / 追问**汇总成一条微信消息（多 Stand 并行召回、或部分 Stand 需用户裁决时用）。

```python
msg = caller.aggregate_results([
    {"room_id": "r1", "stand": "Glm5.2",  "role": "thinker",
     "status": "done",    "summary": "结论1", "files": ["/path/a"], "questions": []},
    {"room_id": "r2", "stand": "Reasonix", "role": "worker",
     "status": "blocked", "summary": "",     "files": [],          "questions": ["请确认…"]},
])
# msg 是纯文本，可直接 caller.relay_to_wechat(msg) 或 cc-send 发出
```

#### 输入

`results: list[dict]`，每项字段：

| 字段        | 类型     | 说明                                   |
| ----------- | -------- | -------------------------------------- |
| `stand`     | str      | Stand 名（展示用）                     |
| `role`      | str      | `thinker` \| `worker`（展示用）        |
| `status`    | str      | `done` \| `blocked` \| `error` \| …    |
| `summary`   | str      | 一句话结论                             |
| `files`     | list[str]| 产物文件路径                           |
| `questions` | list[str]| 需用户裁决的追问                       |
| `room_id`   | str      | （可选）来源房间                       |

#### 输出格式（5 段纯文本）

```
📊 总体状态：N 个 Stand —— X 完成 / Y 阻塞 / Z 个追问

各 Stand 结论：
  · [Glm5.2·thinker / done] 结论1
  · [Reasonix·worker / blocked] （无结论）

文件：
  · /path/a

⚠️ 需你裁决的追问：
  · [Reasonix] 请确认…

下一步建议：先回复上述追问 / 解除阻塞，我再让 Worker 续跑。
```

> 无模块级便捷函数 `aggregate_results(results)` 等价于 `Caller().aggregate_results(results)`。

---

### Stand 注册表

`stand/registry.json`（v0.2+ 格式）：

```json
{
  "version": "0.2.0",
  "default_template": "claude-glm52",
  "default_thinker": "claude-glm52",
  "default_worker": "reasonix",
  "templates": [
    {
      "id": "claude-glm52",
      "name": "GLM-5.2",
      "role": "thinker",
      "description": "Thinker 默认，规划/分析/判断/路由",
      "task_types": ["general", "search", "coding", "writing", "analysis", "complex"],
      "default_timeout": 600
    },
    {
      "id": "reasonix",
      "name": "Reasonix QClaw DeepSeek-v4-flash",
      "role": "worker",
      "description": "Worker 默认，执行型",
      "task_types": ["general", "coding", "writing", "analysis"],
      "default_timeout": 600
    }
  ]
}
```

`default_thinker` / `default_worker` 决定角色分派的默认模板；每个模板的 `role` 字段标识其性质。改注册表即可调整默认映射，无需改代码。

---

### 低层接口

| 方法                              | 说明                         |
| --------------------------------- | ---------------------------- |
| `caller.create_room(name)`        | 创建房间                     |
| `caller.delete_room(room_id)`     | 删除房间（级联清理 Stand）   |
| `caller.add_stand(room_id, tid)`  | 添加 Stand 到房间            |
| `caller.remove_stand(room_id, name)` | 移除 Stand                |
| `caller.send_message(team, to, body)` | 发送消息到房间（直写 SQLite） |
| `caller.get_messages(team)`       | 获取房间消息（SQLite）       |
| `caller.get_room_messages_rest(room_id)` | 获取房间消息（REST API） |
| `caller.list_rooms()`             | 列出所有房间                 |

---

## 消息协议

### 消息表结构（areco `tasks.db`，REST 与 SQLite 同源）

```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,          -- 房间 team 名（如 "room-a1b2c3d4"）
    from_agent TEXT NOT NULL,    -- 发送方（"Hermes" / Stand 名称 / "用户"）
    to_agent TEXT NOT NULL,      -- 接收方（Stand 名称 / "all"）
    body TEXT NOT NULL,          -- 消息正文
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    human_relay INTEGER NOT NULL DEFAULT 0
);
```

### 消息流转

```
Caller 发消息 → SQLite INSERT → 房间 relay 检测到新消息
→ 注入到 Stand 终端 → Stand 处理 → 输出文本
→ 回复消息落库 → Caller poll_result 主动读到 → relay_to_wechat 代发微信
```

---

## 房间生命周期

### 临时房间（默认）
- `dispatch()` 每次新建房间（命名 `Stand-<role>-<task_type>-<rand>`）
- 完成后通过 `delete_room()` 清理（测试加 `--cleanup`）

### 复用房间
- 传入 `room_id` 复用已有房间

### 房间清理
- `delete_room()` 级联删除房间内专属 Stand 会话
- 不调用删除的房间会保留在 areco 看板中，需手动归档

---

## 错误处理

| 场景                 | 行为                                                |
| -------------------- | --------------------------------------------------- |
| areco 服务不可达     | `requests.ConnectionError` 抛出                     |
| 模板 ID 不存在       | areco API 返回 error，Caller 抛出异常               |
| Stand 提前退出无回复 | poll_result 返回 `status:"error"`（传入 session ID 时） |
| 轮询超时             | poll_result 返回 `status:"timeout"`                 |
| 微信发送失败         | relay_to_wechat 返回 `ok:false` + returncode        |

---

## 环境变量

| 变量             | 默认值                              | 说明                   |
| ---------------- | ----------------------------------- | ---------------------- |
| `ARECO_BASE`     | `http://127.0.0.1:8790`             | areco 服务地址         |
| `ARECO_ROOT`     | `~/Code/StandCode/areco`                | areco 数据目录         |
| `CC_SEND_BIN`    | `cc-send`（或 config/local.json）   | 微信代发脚本           |
| `WECHAT_TARGET`  | `weixin:dm:<你的会话id>@im.wechat` | 微信目标会话 |
| `STANDCODE_HOME` | `$HOME`                             | cc-send 的 HOME 前缀   |

---

## 测试

> ⚠️ `test_dispatch.py` / `test_stand_dispatch.py` 是 e2e 冒烟：打生产 areco、
> 建真房间、烧真 token。**必须显式加 `--live` 才真实派发**；不加只做离线自检
> （2026-07-29 起）。「跑全套测试」的电池直接全跑即可，这两个会自动走离线自检。

```bash
cd $STANDCODE_ROOT

# 主动轮询 + 微信代发（dry-run，只验证轮询链路，不发微信）
python3 caller/test_dispatch.py --live --relay --task-type general --poll-timeout 120 --cleanup

# 按角色分派：Worker（默认 Reasonix）
python3 caller/test_dispatch.py --live --relay --role worker --poll-timeout 120 --cleanup

# 按角色分派：Thinker（默认 GLM-5.2）
python3 caller/test_dispatch.py --live --relay --role thinker --poll-timeout 120 --cleanup

# 真正发送微信（确认无误后再用）
python3 caller/test_dispatch.py --live --relay --role worker --send-wechat \
    --summary "测试结论" --file-path /tmp/out.docx

# Caller 两段式：Thinker 出计划 → Worker 执行
python3 caller/test_dispatch.py --live --plan --poll-timeout 300 --cleanup

# 旧路径：只派发不等完成 / 等待完成
python3 caller/test_dispatch.py --live --task-type search
python3 caller/test_dispatch.py --live --task-type general --wait --timeout 60
```

---

## CLI 命令行入口

`caller.py` 自带 CLI，Hermes 一行命令即可派发任务（支持后台）、查状态、汇总。后台模式下 caller 自己 1s 轮询、结果/出错都自动回微信，Hermes 无需手动轮询。

### `run` —— 派发 + 主动轮询 + 代发微信

```bash
# 后台（推荐）：立刻返回 task_id，caller 自己轮询并回微信
python3 $STANDCODE_ROOT/caller/caller.py run "任务描述" --bg

# 指定角色：worker=Reasonix / thinker=GLM-5.2
python3 caller/caller.py run "总结这份转写" --bg --role worker --file /path/x.docx --summary "一句话结论"

# 两段式：Thinker 出计划 → Worker 执行
python3 caller/caller.py run "调研并产出方案" --bg --plan --timeout 600

# 前台同步（不后台，阻塞到完成）
python3 caller/caller.py run "用一句话说明你能做什么" --role thinker --timeout 120
```

| 参数 | 说明 |
| --- | --- |
| `request` | 任务描述（位置参数） |
| `--bg` / `--background` | 后台运行，立刻返回 task_id |
| `--role {thinker,worker}` | 角色分派（ thinker=GLM-5.2 / worker=Reasonix ） |
| `--task-type` | 任务类型（默认 general） |
| `--template` | 强制指定模板 id |
| `--room-id` | 复用现有房间 |
| `--summary` | 一句话结论（代发微信用） |
| `--file` | 产物文件路径（代发微信用） |
| `--timeout` | 轮询超时秒数（默认 600） |
| `--no-relay` | 不代发微信，只取结果 |
| `--plan` | 两段式 Thinker→Worker |

> 轮询间隔固定 1s（准实时）。后台任务状态落在 `~/.standcode/tasks/<task_id>.json`，日志 `~/.standcode/tasks/<task_id>.log`。

### `status` / `list` —— 查看后台任务

```bash
python3 caller/caller.py status <task_id>        # 查看单个任务状态/结果
python3 caller/caller.py status <task_id> --json # 原始 json
python3 caller/caller.py list                    # 列出所有后台任务
```

### `aggregate` —— 汇总多个后台任务（接 aggregate_results）

```bash
# 打印汇总（不发微信）
python3 caller/caller.py aggregate <task_id_1> <task_id_2>

# 直接把汇总发微信
python3 caller/caller.py aggregate <task_id_1> <task_id_2> --send
```

把多个 `run --bg` 的结果按 aggregate_results 格式（总体状态 / 各结论 / 文件 / 追问 / 下一步）汇总成一条微信消息。

### 行为约定

- **后台**：`run --bg` 用 `start_new_session` 派生独立进程，Hermes 立刻拿回 task_id；caller 自己 dispatch → 1s 轮询 → 完成或超时后**写 inbox + 发极简触发消息到微信**（不再直接发完整结果）。Hermes 读到触发消息后，读取 inbox 文件并按模板汇总发回完整结果。
- **出错也写 inbox**：worker 捕获异常 / 超时，会写 inbox 并发出极简触发消息（summary_hint=异常），Hermes 读取后汇总异常信息发回微信。状态写 error/timeout。
- **与 aggregate_results 兼容**：每个后台任务状态可转成 aggregate 条目（`_result_to_aggregate_entry`），供 `aggregate` 子命令汇总。

---

## 依赖

- Python ≥ 3.12
- `requests`（HTTP 客户端）
- `sqlite3`（Python 标准库）
- `cc-send.sh` → `cc-connect`（微信代发，`~/.npm-global/bin` 需在 PATH）
