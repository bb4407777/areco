# StandCode 代码图谱导览

> 2026-07-31 在仓库第二次搬迁后重建。
> 当前真身：`/Users/gao/Code/StandCode/`；代码图谱工具：`/Users/gao/clone/codegraph/`。
> 本文按当前工作树生成，包含尚未提交的代码改动；代码演进快，行号漂移时应按符号名查询。
> 配套：`codegraph-cheatsheet.md`（一页命令卡）、`architecture-map-20260731.md`（Mermaid 架构图，基于总仓索引实测符号）。

## 一句话定位

StandCode 现在是一个 monorepo：

- `standcode/`：Caller / Thinker / Worker 三层 agent 编排语义层；
- `areco/`：承载 Stand 的 PTY 会话、项目房间、消息、对话视图和网页看板底座；
- `standcode/caller/hermes/`：2026-07-30 收编进仓的 Hermes 常驻入口及其 CLI、网关、工具与代理能力。

Caller 识别请求并分派给 Thinker 或 Worker；真正的 Stand 是 areco 中的终端会话。任务结果进入 `standcode/data/inbox/`，再由 Caller/Hermes 拉取和回执。

## 为什么重建

旧图谱建于 2026-07-30 02:07，当时目标还是旧路径 `Code/areco/standcode/`，仅覆盖 15 个文件、671 个节点、2,027 条边。此后发生三次结构性变化：

1. `52a6b51`：本地目录 `Code/areco` 改名为 `Code/StandCode`；
2. `c8d8dfa`：areco 底座下沉至 `StandCode/areco/`，StandCode 成为总架构；
3. `4f043dc`：Hermes 收编进 `standcode/caller/hermes/`。

旧索引虽随目录搬到新位置，但只记录相对文件路径和旧时期内容，规模与现状严重不符，因此不能继续作为代码事实源。

## 当前双层索引

为兼顾快速检索和跨层分析，本次保留两份索引：

| 索引 | 路径 | 文件 | 节点 | 边 | 用途 |
|---|---|---:|---:|---:|---|
| 编排层索引 | `standcode/.codegraph/` | 230 | 7,627 | 23,778 | 快速查 Caller、Hermes、路由与收信箱 |
| monorepo 总仓索引 | `.codegraph/` | 357 | 10,526 | 33,193 | 跨 `standcode ↔ areco` 追完整调用与配置链 |

总仓索引语言分布：Python 226、TypeScript 90、Vue 27、JavaScript 11、YAML 3；数据库约 44.1 MB。

## 仓库结构

```text
StandCode/
├── .codegraph/                    monorepo 总仓索引（主索引）
├── README.md                      总仓及 areco 底座文档
├── standcode/
│   ├── .codegraph/                编排层快速索引
│   ├── bin/standcode.js           npm/CLI 薄入口
│   ├── caller/
│   │   ├── caller.py              调度核心，当前 8,592 行
│   │   ├── hermes/                Hermes 常驻入口（新收编）
│   │   └── test_*.py              Caller 路由、配额、复用、闸门等测试
│   ├── config/                    harness/model/preset/provider 配件字典
│   ├── data/inbox/                任务结果收信箱
│   ├── docs/                      设计与导览文档
│   ├── scripts/                   审计、清扫、学习等运维脚本
│   └── stand/registry.json        默认角色与模板映射
└── areco/
    ├── packages/client/           Vue 3 网页看板
    ├── packages/server/           Koa 服务、PTY、房间、Transcript、StandCode 接线
    ├── packages/shared/           前后端协议与共享类型
    └── scripts/areco-msg.mjs      agent 向房间回传消息的 CLI
```

## 主链路：用户请求如何走完一圈

```text
Hermes / 其他 Caller
  │
  ▼
standcode/caller/caller.py
  ├─ check_should_dispatch          是否应派、是否命中硬闸
  ├─ route_mode                     think / plan / worker / fast 分诊
  ├─ dispatch                       选模板、建房/复用会话、投递任务
  │    │
  │    ▼
  │  areco REST + tasks.db
  │    ├─ standcode-resolver.ts     解析角色、harness、model、preset
  │    ├─ rooms/controllers/routes  建项目房与成员
  │    └─ session-manager/session   拉起并承载真实 CLI 会话
  │
  ├─ poll_result                    按消息水位线和 Stand 身份收获结果
  ├─ _finalize_waiter               终态、验收、成本、收信箱落盘
  └─ data/inbox/{task_id}.json      Caller/Hermes 拉取并回执
```

## Caller 调度核心

`standcode/caller/caller.py` 当前 8,592 行。关键符号的新位置：

| 符号 | 当前行号 | 职责 |
|---|---:|---|
| `resolve_lane_anchors` | 318 | 从配置解析 think/worker/fast/heavy 车道锚点 |
| `resolve_mode` | 697 | 收敛新旧 CLI 模式参数 |
| `verify_completion` | 893 | 检查任务结果是否构成真实完成 |
| `extract_acceptance` | 1,002 | 提取验收判据 |
| `ensure_acceptance_block` | 1,019 | 给执行任务补齐验收块 |
| `check_should_dispatch` | 1,349 | Gatekeeper：判断直持、派发或阻断 |
| `class Caller` | 1,722 | 调度核心类 |
| `finish_room` | 2,045 | 成功归档、失败留场、写台账 |
| `send_message` | 2,434 | 向 areco 房间写任务消息 |
| `get_messages` | 2,492 | 从 areco 房间读取增量消息 |
| `dispatch` | 2,527 | 派单主方法 |
| `poll_result` | 2,955 | 轮询并精确收获 Stand 结果 |
| `resolve_ask_channel` | 3,511 | 找可直接追问的常驻会话 |
| `find_reusable_session` | 3,616 | 复用同模板空闲会话 |
| `dispatch_to_channel` | 3,700 | 直接向指定通道/会话派发 |
| `relay_to_wechat` | 3,951 | 经消息桥回执微信 |
| `gate_result` | 4,041 | 结果验收闸 |
| `dispatch_and_relay` | 4,134 | 单段派发、收获、回执全流程 |
| `plan_and_execute` | 4,256 | Thinker 规划后交 Worker 执行 |
| `route_mode` | 4,575 | think/plan/worker/fast 四格分诊 |
| `aggregate_results` | 4,864 | 汇总 fanout 结果 |
| `dispatch_parallel` | 4,933 | 并行分派多个 Worker |
| `write_inbox` | 5,339 | 结果写入收信箱 |
| `_finalize_waiter` | 5,621 | 等待者统一收尾 |
| `_run_by_mode` | 5,860 | 按模式选择执行链 |
| `_cmd_run` | 6,091 | `run` 子命令入口 |
| `_cmd_go` | 6,422 | 自动分诊入口；调用 `route_mode` |
| `_cmd_ask` | 6,600 | 向常驻会话追问 |
| `_cmd_reconcile` | 7,037 | 补收异常/迟到任务 |
| `_cmd_harvest` | 7,414 | 巡检并收割无人跟踪的房间结果 |
| `_build_parser` | 8,316 | CLI 子命令定义 |
| `_cli` | 8,577 | 进程入口 |

实测调用关系：`route_mode` 的生产调用者是 `_cmd_go`（6422）和 `_cmd_route`（7958）；其余调用来自测试。

## 新收编的 Hermes 子树

`standcode/caller/hermes/` 是本轮扩图的最大来源：编排层索引从 15 个文件扩大到 230 个文件，主要就是因为 Hermes 进入同仓。

重要组成：

- `hermes_cli/main.py`：Hermes CLI 主入口，当前约 15,321 行；
- `hermes_cli/dashboard_auth/`：看板认证、Cookie、Token、WebSocket ticket；
- `hermes_cli/proxy/`：模型/API 代理与适配器；
- `hermes_cli/subcommands/`：auth、gateway、cron、mcp、memory、skills、tools 等子命令；
- `bin/*-shim.py`：Kimi、QClaw/Reasonix、Qoder 等运行时适配；
- 其他 gateway、agent、tool、memory、skills 模块：构成 Hermes 常驻入口的完整运行面。

因此，今后只把 `caller.py` 当作 StandCode 全部核心已经不准确：`caller.py` 是调度核心，Hermes 是入口运行面，areco 是执行与观察底座。

## StandCode 与 areco 的跨层接线

总仓索引已验证以下接线进入同一张图：

- `areco/packages/server/src/services/standcode-resolver.ts: standcodeRoot()`：定位 `standcode/` 真身；
- `STAND_REGISTRY_PATH`：指向 `standcode/stand/registry.json`；
- `STANDCODE_CONFIG_DIR`：指向 `standcode/config/`；
- `areco/packages/server/src/controllers/api.ts: STANDCODE_CALLER`：指向 `standcode/caller/caller.py`；
- areco 模板的 harness/model/preset 字段由 `standcode-resolver` 现场解析；
- Caller 通过 areco REST、房间消息库和会话状态完成投递与收获。

跨层问题应优先使用总仓索引，不要分别扫两个目录后靠猜测拼接。

## 如何查询

### 总仓查询（默认推荐）

```bash
cd /Users/gao/Code/StandCode
CG="/Users/gao/clone/codegraph/dist/bin/codegraph.js"
NODE="/Users/gao/.workbuddy/binaries/node/versions/22.22.2/bin/node"

$NODE $CG status
$NODE $CG query standcodeRoot
$NODE $CG callers route_mode
$NODE $CG callees dispatch_and_relay
$NODE $CG impact standcodeRoot
$NODE $CG explore "StandCode 角色配置如何接入 areco"
```

### 只查编排层

```bash
cd /Users/gao/Code/StandCode/standcode
CG="/Users/gao/clone/codegraph/dist/bin/codegraph.js"
NODE="/Users/gao/.workbuddy/binaries/node/versions/22.22.2/bin/node"

$NODE $CG status
$NODE $CG node route_mode
$NODE $CG callers dispatch_and_relay
$NODE $CG explore "Hermes 如何调用 Caller"
```

## 维护规则

目录未变、只是代码增量修改时：

```bash
cd /Users/gao/Code/StandCode
/Users/gao/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  /Users/gao/clone/codegraph/dist/bin/codegraph.js sync

cd /Users/gao/Code/StandCode/standcode
/Users/gao/.workbuddy/binaries/node/versions/22.22.2/bin/node \
  /Users/gao/clone/codegraph/dist/bin/codegraph.js sync
```

仓库搬迁、模块大规模收编、根目录变化时，应对两个根分别执行 `index` 重建，而不是继续使用旧数据库。

## 本次边界

本次完成的是 **CodeGraph 本地确定性索引 + 导览重建**，零 API 成本。Understand-Anything / Graphify 的 LLM 图形看板未运行；如需交互式可视化，应单独确认范围和模型成本后再做，不能把当前 `.codegraph/` 数据库误称为已生成图形看板。
