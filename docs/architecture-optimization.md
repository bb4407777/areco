# StandCode 架构优化方案

> 版本: v0.1 | 定稿: 2026-07-25
> 来源: 元宝讨论（2026-07-24 会话 naQivTmsDa）+ 当前架构审计
> 角色: Thinker via WorkBuddy DeepSeek-v4-pro（stand-thinker-workbuddy）

---

## 1. 当前架构全景图

### 1.1 角色层级

```
                    微信（Client）
                         │
                    Hermes（Caller）
                    路由 / 决策 / 派发 / 轮询 / 回执
                         │
           ┌─────────────┼─────────────┐
           ▼                           ▼
    Thinker (stand-thinker-      Worker (claude)
    workbuddy)                   Claude CLI + GLM-5.2
    WorkBuddy DeepSeek-v4-pro    执行型
    规划 / 分析 / 判断
           │                           │
           └──────────┬────────────────┘
                      ▼
                 areco（底座）
             room + session 生命周期
             SQLite 消息投递 / relay
```

### 1.2 当前角色-模型-模板映射

| 角色 | 模型 | areco 模板 ID | 职责 |
|------|------|---------------|------|
| Caller | Hermes（微信平台） | — | 路由、决策、派发、主动轮询、代发微信 |
| Thinker | WorkBuddy + DeepSeek-v4-pro | `stand-thinker-workbuddy` | 规划、分析、判断、路由 |
| Worker | Claude CLI + GLM-5.2 | `claude` | 代码、搜索、文书、下载、总结 |

备选 Worker：`workbuddy-deepseek`（DeepSeek-v4-flash）、`workbuddy-deepseek-pro`、`codex`（gpt-5.6-sol）、`zcode`。

### 1.3 任务流转（完整管线）

```
微信消息
    │
    ▼
[1] Hermes 秒回确认（cc-send）
    │
    ▼
[2] 判断任务类型
    ├─ should_plan=True  → plan_and_execute（Thinker 出计划 → Worker 执行）
    └─ should_plan=False → dispatch_worker（直派 Worker）
    │
    ▼
[3] Caller.dispatch()
    ├─ 选模板（template_id > role > task_type > default）
    ├─ areco REST API 创建房间（create_room）
    ├─ 添加 Stand（add_stand → 3s 等待 TUI boot）
    └─ SQLite 直写消息（send_message，human_relay=1）
    │
    ▼
[4] 房间 relay 注入 Stand 终端 → Stand 处理
    │
    ▼
[5] 结果回执（两条路径）
    ├─ 前台同步：Caller.poll_result()（1s 轮询 + 提前退出检测）
    │       → Caller.relay_to_wechat() 代发微信（模板格式化）
    │
    └─ 后台异步（run --bg）：
            caller 独立进程 dispatch → poll → write_inbox
            → cc-send 极简触发消息 → Hermes 读到触发
            → process_inbox_callback() 读取 inbox
            → summarize 模板汇总 → relay_to_wechat → 清理 inbox
    │
    ▼
[6] 多 Stand 并行结果：aggregate_results() 合并回执
```

### 1.4 消息投递机制

```
Caller.send_message()
    → SQLite INSERT（projects.db / messages 表）
        team=<room team>  from_agent="Hermes"  human_relay=1
    → areco room-relay 检测到新消息
        humanRelayAgents=["Hermes"] 白名单内 → 清零链深、投全体
    → 注入 Stand 终端 → Stand 处理 → 回复落 messages 表
    → Caller.poll_result() 增量拉取（after_id 游标）
        get_messages(team, after_id=last_id) → 过滤 NON_STAND_SENDERS
```

### 1.5 核心组件矩阵

| 组件 | 路径 | 说明 |
|------|------|------|
| Caller 引擎 | `caller/caller.py` | 调度核心：dispatch / poll / relay / plan / aggregate |
| 注册表 | `stand/registry.json` | 7 模板 + 5 类任务映射 + 角色默认 |
| API 文档 | `docs/api.md` | v0.4 完整协议 |
| 行为手册 | `skills/StandCode/SKILL.md` | Hermes Caller 行为约束 |
| areco 模板 | `Code/areco/config.json` | 15 个模板含 StandCode 4 个 |
| Inbox 目录 | `data/inbox/` | 异步回调结果中转 |
| Gatekeeper | `caller.py:check_should_dispatch()` | 命令分类：operator vs production vs gray |
| 流程固化 | `docs/workflow-hardening.md` | 根因 + 方案 A-D + 4 起错误案例 |

---

## 2. 元宝讨论中的关键洞察

### 2.1 机会窗口：约 12-18 个月

开源编排层（Orca、Remote-Code、herdr、graith、Emdash）正在快速成熟。窗口期内完成差异化定位、建立竞争壁垒，是大厂进入前的关键。

### 2.2 StandCode 差异化定位

```
                    企业管控（弱） ←→ 企业管控（强）
                          │
    微信通道 ─────── StandCode ───── 终端多路复用
                          │
                    远程访问 + 自托管
```

交叉点上做差异化：

| 竞品 | 我们的差异 |
|------|-----------|
| herdr / graith | 多远程通道（微信/Web）+ 企业管控层 |
| Orca / Remote-Code | 私有部署优先 + 审计合规 |
| Coder | 不绑架 IDE/Agent 选择 + 轻量快速启动 |
| Codex / Cursor 云 Agent | **数据不出域** 是核心差异化 |

### 2.3 企业自托管控制平面参照（Coder 四层模型）

| 层 | 功能 | StandCode 当前对应 |
|----|------|-------------------|
| 1. 认证网关 | AI Gateway 集中认证，API Key 永不下发工作区 | 无（Hermes 无身份校验） |
| 2. 观测采集 | 自动发现 agent 行为、敏感信息脱敏 | 无（仅调用日志） |
| 3. 策略执行 | pre-commit/CI 硬卡、append-only 审计 trail | 无（软约束 SKILL.md 规则） |
| 4. SSO / SIEM | 身份与合规对接 | 无 |

### 2.4 远程访问架构参照（areco 大概率走 B 路线）

- 路线 B：服务端 VTE + 会话持久化（PTY → agent → 中继 → WebSocket）
- 锁屏不断 = tmux/守护进程 + caffeinate
- 换设备接着看 = 中继存会话状态 + 终端缓冲
- **10 分钟 TTL** 是架构设计时的硬边界

### 2.5 本地 vs 云端路线判断

| 维度 | 云端 | 本地+远程 |
|------|------|-----------|
| 成本 | OPEx 流（<2h/day 划算） | CapEx 一次性（>4h/day 更省） |
| 安全 | 数据出域 | 数据不出域（核心卖点） |
| 合规 | 金融/医疗/政务通常不允许 | 天然兼容 |
| 协作 | 审计更成熟 | 需自建 |

StandCode 走本地+远程，核心卖点 = 数据不出域 + 灵活定制。

---

## 3. 架构差距分析

### 3.1 当前架构 vs 目标架构

| 维度 | 当前状态 | 目标状态 | 差距 |
|------|---------|---------|------|
| **通道** | 仅微信 | 微信 + Web 管理控制台 + REST API 外部触发 | 缺 Web 面 |
| **身份认证** | 无（insecureNoAuth） | API Key / OAuth 网关，Key 不下发工作区 | 缺整层 |
| **多 Agent 并行** | Thinker→Worker 串行 pipeline | Fan-out 并行分派 + 结果比对/合并 | 缺 fan-out |
| **工作区隔离** | 共享文件系统 | git worktree 隔离（每个 agent 独立 workspace） | 缺隔离 |
| **会话可靠性** | Stand 退出无回执（痛点） | 心跳 + 状态对账 + 自动重启/切换 | 仅 poll 提前退出检测 |
| **审计追踪** | 无（偶有调用日志） | Append-only 审计 trail + 可 nop 查询 | 缺整层 |
| **策略执行** | SKILL.md 软约束（经常被跳） | Gatekeeper 硬闸（策略引擎、pre-commit 卡） | 缺硬闸 |
| **模型白名单** | 无（所有模板任意启动） | 模型白名单 + 配额管理 | 缺管控 |
| **网络出口控制** | 无 | 默认拒绝外网 + 白名单放行 | 缺控制 |
| **可观测性** | poll_result / status 查询 | Agent 行为自动发现 + 敏感信息脱敏 + Dashboard | 缺观测面 |

### 3.2 流程硬化差距（当前痛点）

| 痛点 | 现状 | 目标 |
|------|------|------|
| Caller 跳过派发（直干率过高） | Gatekeeper 为 Advisory 软约束 | 硬闸拦截或 post-audit 告警 |
| Stand 退出无回执 | poll 的提前退出检测（best-effort） | 心跳保活 + 超时自动拉起 |
| 无法并行 fan-out | 仅 Thinker→Worker 串行 | 同轮多 Worker 并行 + 结果合并 |
| 无文件隔离 | 全部 agent 共享文件系统 | worktree 隔离，避免相互覆盖 |

---

## 4. 优化建议

### 建议 1（P0 — 本周内启动）：多通道管理控制台

**目标**：在微信通道之外增加 Web 管理面和 REST API，实现多端访问和任务管理。

**现状问题**：
- 唯一入口是微信——无 Web 端无法吸引非微信用户
- 无法给外部系统提供 API 触发接口
- 无可视化 Dashboard 查看 agent 状态、任务队列、历史

**实施路径**：
1. **W1**：基于 areco 现有 Web 端口（8790），增加 `/api/tasks` 状态查询 API + `/api/tasks/submit` 提交 API（与 caller.py 的 dispatch 打通）
2. **W2-3**：最小 Web 控制台（可用 htmx + 精简模板）——实时 agent 状态面板、任务提交表单、历史查询
3. **W4**：微信通道 + Web 通道共存，统一走 Caller 调度

**技术依赖**：areco 现有 REST 框架 + FastAPI/Flask 薄层（嵌入 areco 服务）

---

### 建议 2（P0 — 本周内启动）：控制平面 MVP（认证 + 审计 + 白名单）

**目标**：对齐 Coder 四层模型的第一层（认证网关）+ 第三层（策略执行），建立最小可用的企业控制平面。

**现状问题**：
- areco 为 `insecureNoAuth` 模式，零访问控制
- 无 API Key 认证，任何可访问 8790 端口的进程均可创建 room 和 Stand
- 无模型白名单，模板中任意 CLI agent 均可启动

**实施路径**：
1. **W1**：areco 增加 token-based API 认证（Bearer token 或 X-API-Key header）——caller 和外部 API 调用时携带
2. **W2**：模型白名单配置（`config.json` → `modelWhitelist` 字段），限制哪些模板可被 dispatch 启动
3. **W2**：SQLite append-only 审计日志表（`audit_log`：who/what/when/room/template/result），每次 dispatch/create_room/delete_room 自动写入
4. **W3**：审计查询 API（`/api/audit` 按时间/模板/角色筛选）

**技术依赖**：areco 服务端改造（认证中间件 + 白名单校验 + 审计落库），约 200 行 Go

---

### 建议 3（P1 — 两周内启动）：多 Agent 并行调度（Fan-out）

**目标**：从 Thinker→Worker 串行管道升级为多 Worker 并行 fan-out。

**现状问题**：
- 当前仅 Thinker→Worker 串行（plan_and_execute）
- 无法同时派多个 Worker 处理同一任务的子问题
- 无法做结果比对（多模型跑同一任务互相校验）

**实施路径**：
1. **W1**：`caller.py` 新增 `dispatch_parallel(requests: list[dict])` 方法——同轮创建多个房间 → 并行 dispatch → 并行 poll → aggregate_results 合并
2. **W2**：增加 `compare_results()` 方法——多个 Stand 同一问题 → 自动对比差异 → 标注分歧
3. **W3**：Thinker 可产出「并行可拆解 plan」——在现有结构化 plan 模板中增加 `可并行步骤` 字段

**技术依赖**：caller.py 改造（主要管并行 dispatch + 合并逻辑），areco 无需变更

**关键风险**：
- 多个 agent 并行修改同一文件 → 需要 worktree 隔离（建议 4）
- 并行 fan-out 会成倍消耗 token/额度 → 需要配额管理（建议 2 白名单范围内）

---

### 建议 4（P1 — 一个月内启动）：会话可靠性 + 工作区隔离

**目标**：解决 Stand 退出无回执（痛点）+ agent 间文件冲突。

**现状问题**：
- Stand 退出前不回报是已知痛点（poll 提前退出检测仅 best-effort）
- 多个 agent 共享同一文件系统，并行执行时可能互相覆盖
- 无法实现跨 agent 的"干净环境"重启

**实施路径**：

**4a. 会话可靠性**：
1. **W1**：Stand 启动时写入心跳（`/tmp/areco-stand-{sessionId}.heartbeat`，每 5s 更新）
2. **W2**：故障自愈——Caller 检测心跳断 > 15s → 自动重新派发相同 task 到新 Stand → 原 Stand 标记 exited

**4b. 工作区隔离**：
1. **W3**：dispatch 时自动创建 git worktree（`/tmp/standcode-workspaces/{task_id}/`）→ Stand cwd 指向隔离目录
2. **W3**：Stand 完成 → worktree 结果 merge 回主分支 → clean worktree
3. **W4**：参考 graith 的 worktree 自动隔离模式

**技术依赖**：areco 模板 `cwd` 动态化支持（当前为固定 `/Users/gao`），需改造为任务级隔离

---

### 建议 5（P2 — 一个月后启动）：Gatekeeper 硬闸 + 审计自动化

**目标**：从软约束（SKILL.md 文本规则）升级为硬闸拦截 + 事后审计自动化。

**现状问题**：
- StandCode SKILL.md 的规则是软约束，Hermes 经常跳过（06-25 四个错误案例证明）
- 当前 Gatekeeper（`check_should_dispatch`）输出 Advisory 分级，无硬拦截能力
- 无自动化审计统计（`audit-direct-work.py` 未实现）

**实施路径**：
1. **W1**：完善 `check_should_dispatch` → 作为 areco message relay 的前置过滤器（Stand 收到的消息内容先过 Gatekeeper，Production 类任务自动标注 `type: deferred`）
2. **W2**：实现 `audit-direct-work.py`（每日 cron 分析 Hermes 昨日 terminal 调用，直干率 > 30% 微信告警）
3. **W3**：在 areco room-relay 增加策略执行：对于标注 `blocked` 的消息类型，禁止 Stand 直接执行

**技术依赖**：areco room-relay 改造（消息分类 + 策略执行），约 100 行 TypeScript

**注**：本项优先级低于建议 1-4，因为当前 Caller 直干问题已通过 SKILL.md 强化 + Gatekeeper Advisory + `humanRelayAgents` 白名单得到部分缓解。硬闸机制需要 areco 端改造，宜在控制平面 MVP（建议 2）完成后推进。

---

## 5. 综合路线图

```
Week 1-2（立即）
├─ P0 #1 多通道管理控制台（Web API + 最小 Dashboard）
├─ P0 #2 控制平面 MVP（认证 + 审计 + 白名单）
└─ 继续推进 inbox 端到端验收 + caller.py 模板对齐

Week 3-4
├─ P1 #3 多 Agent 并行 fan-out
├─ P1 #4 会话可靠性 + worktree 隔离
└─ Web 控制台功能完善（agent 状态实时面板）

Month 2
├─ P2 #5 Gatekeeper 硬闸 + 审计自动化
├─ 配额管理 + 成本监控 Dashboard
└─ SSO 对接（OIDC 基础支持）

Month 3+
├─ 策略引擎（pre-commit/CI 硬卡）
├─ 跨 Agent 结果对比（多模型互校）
└─ 企业私有化部署打包（Docker Compose / one-click install）
```

---

## 6. 关键决策等待确认

| 决策项 | 当前倾向 | 待确认 |
|--------|---------|--------|
| Web 控制台技术栈 | htmx + 精简模板（低依赖） | vs React / Vue（长期可维护性） |
| API 认证方案 | Bearer token（stateless） | vs API Key（简单、外部对接友好） |
| worktree 隔离粒度 | 每 task 隔离（最安全） | vs 每 session 隔离（平衡性能） |
| 是否接入 OIDC SSO | Month 2 做基础支持 | 取决于是否有企业客户需求 |

---

*本文档由 WorkBuddy DeepSeek-v4-pro（stand-thinker-workbuddy）基于 StandCode 当前架构审计 + 元宝讨论洞察综合分析产出。*
