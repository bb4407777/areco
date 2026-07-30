# StandCode 代码图谱导览

> 写给第一次接触本代码库的技术人员（和想看懂系统在干什么的老板）。
> 行号以 2026-07-30 的代码为准；代码演进快，行号漂移时按函数名搜索即可。

## 一句话定位

StandCode 是一个**三层 agent 编排框架**：常驻入口 agent（Caller，当前是接微信的 Hermes）识别用户请求，把活派给 Thinker（出计划）或 Worker（执行）这两类「替身 Stand」，每个 Stand 都是 areco 看板上的一个真实终端会话，干完结果落收信箱（`data/inbox/`），Caller 醒来拉取、回执微信。**Caller 只指挥，不亲自干活。**

底座是姊妹项目 areco（通用会话底座，PTY 会话/房间/消息/看板，跑在 `127.0.0.1:8790`），本仓库是它的编排语义层。

**索引规模**：codegraph 已对本仓建索引——15 个 Python/JS 文件、671 个节点、2027 条边（索引在 `.codegraph/`）。其中 `caller/caller.py` 一个文件占 326 个符号，是绝对核心。

## 仓库模块划分

```
standcode/
├── bin/standcode.js      npm 薄壳（13 行）：spawn python3 跑 caller.py，只为 npm 分发和 PATH 入口
├── caller/
│   ├── caller.py         调度核心，8404 行单文件，326 符号——CLI 入口 + Caller 类全在这里
│   └── test_*.py         10 个测试文件（guards/modes/quota/dispatch/rooms/standby/
│                         session_reuse/ask/acceptance/stand_dispatch）
├── config/               配件字典：harnesses.json（壳）、models.json（模型）、presets.json（预设）、
│                         providers.json；local.json 是本机私有配置（微信代发脚本等，不进仓）
├── stand/registry.json   角色登记表：default_thinker / default_worker / default_heavy_worker /
│                         default_fast_worker + task_type_defaults + 模板清单（Thinker/Worker
│                         没有自己的代码，它们就是 areco 模板派生出的会话，本文件是唯一「角色配置」）
├── data/inbox/           收信箱：任务结果落盘 {task_id}.json，汇报完改名加 .done
├── scripts/              3 个运维脚本（见下）
└── docs/                 设计文档：work-modes.md（四格路由依据）、workflow-hardening.md、
                          api.md、progress.md 等
```

scripts/ 三个脚本各管一件事：

- `audit-direct-work.py` — 派发审计：统计 Caller「直干率」（该派没派的比例），超阈值微信告警。
- `sweep-task-rooms.py` — 任务房清扫器：删掉「已归档且任务房命名（⚙ 前缀）」的房间，与 caller 的自动归档形成「完成→归档→删除」流水。
- `scan_weekly_learn.py` — 每周采矿：扫本周 inbox 完成单 + 飞书功过格，提炼候选 lesson（主动学习机制）。

## caller.py 深度导览（8404 行，326 符号）

单文件但内部有清晰的功能分区，从上到下大致是：

| 区段 | 行号范围 | 内容 |
|---|---|---|
| 配置与常量 | 1–483 | 环境变量/`config/local.json` 三层配置、轮询/合并窗等时长常量、路由关键词表（405–478）、`HEAVY_LANE_STAND` 改道常量（248） |
| 验收栏 | 774–1122 | 任务验收判据的提取、机检、打回话术 |
| 审计/配额/Gatekeeper | 1123–1393 | 审计日志、额度打满信号、`check_should_dispatch` 红线判定 |
| 台账/健康闸/心跳 | 1394–1665 | 房间台账 jsonl、模板失败隔离、等待者心跳 |
| `class Caller` | 1666–4987 | 全部调度逻辑（下表详列） |
| 模块级薄包装 | 4988–5086 | `dispatch()`/`poll_result()` 等函数版接口（内部 new 一个 Caller） |
| 计划库/inbox/回调 | 5088–5531 | 历史计划相似度复用、收信箱读写、处理锁、回调触发 |
| 等待者收尾/后台进程 | 5532–5770 | `_finalize_waiter`（三处共用收尾）、`_bg_worker`（已弃用的后台模式） |
| 模式执行归一 | 5771–5950 | `_run_by_mode`：四种模式 × 三个调用点的分支归一 |
| CLI 子命令 | 5951–8127 | `_cmd_run/go/ask/reconcile/harvest/report/inbox/...` |
| argparse 与入口 | 8128–8404 | `_build_parser`（15 个子命令）、`_cli` |

### 关键类（4 个）

| 类 | 行号 | 职责 |
|---|---|---|
| `ModeConflictError` | 609 | `--mode` 与 `--role/--plan` 两代参数冲突时抛出 |
| `GatekeeperBlockedError` | 710 | 命中 BLOCKED 红线（rm -rf / 等灾难操作）时 `dispatch()` 硬拒抛出 |
| `_HeartbeatWriter` | 1602 | 等待者进程的心跳文件写入器（供 reconcile 判活） |
| `Caller` | 1666 | 调度核心类，约 70 个方法，承载全部派单/轮询/收口逻辑 |

### Caller 类关键方法

| 方法 | 行号 | 一句话职责 |
|---|---|---|
| `_load_registry` | 1695 | 读 `stand/registry.json`，确定默认 Thinker/Worker/重活锚模板 |
| `dispatch` | 2436 | **派单主方法**：红线闸→选模板→健康闸→（暖池/旧会话复用）→建房→add_stand→SQLite 直写任务消息 |
| `poll_result` | 2865 | **轮询收获**：按 `after_id`+`stand_name` 精确认人拉增量回复，红绿灯判完成/stuck/lost/timeout |
| `dispatch_and_relay` | 4041 | 单段全流程：dispatch→poll→（验收闸）→代发微信→`finish_room` 收口归档 |
| `plan_and_execute` | 4163 | 两段式：Thinker 出计划（同房间）→Worker 执行；计划不合格三级降级 |
| `_execute_with_plan` | 4368 | 两段式的执行段（含计划复用的直达入口） |
| `route_mode` | 4481 | **四格路由**：按「交付物（判断/东西）× 结构（单步/多步）」判 think/plan/worker/fast |
| `dispatch_parallel` | 4844 | fanout 多 Worker 并行派发（多线程各自 dispatch+poll） |
| `aggregate_results` | 4775 | 多任务结果汇总成一条消息 |
| `finish_room` | 1974 | 收口：成功归档房间、写台账；失败留看板等人看 |
| `gate_result` | 3949 | 结果把关闸：机检验收判据，不合格打回重做（**当前总开关关闭**） |
| `relay_to_wechat` | 3859 | 经 cc-send 代发微信（`WECHAT_TARGET` 为空则跳过） |
| `standby_claim/refill/sweep` | 2140/2215/2259 | 暖池：预 spawn 的空闲 Stand 认领/补位/清扫（**当前 `STANDBY_ENABLED=False`**） |
| `find_reusable_session` / `_session_reuse_decision` | 3525/3588 | 旧会话复用：同模板空闲会话直接派，省 12s 冷启动 |
| `send_message` / `get_messages` | 2363/2401 | 直写/直读 areco 的 projects.db（SQLite），这是任务投递与收获的数据面 |
| `resolve_ask_channel` / `dispatch_to_channel` | 3420/3609 | ask 直投：向已有常驻会话追问（忙则另开 fork） |

### 模块级关键函数

| 函数 | 行号 | 一句话职责 |
|---|---|---|
| `check_should_dispatch` | 1293 | Gatekeeper：判「该派还是 Caller 直干」；blocked/operator/production/gray 四级 |
| `resolve_mode` | 613 | 两代参数（`--mode` vs `--role/--plan`）唯一收敛出模式决策 |
| `extract_acceptance` / `ensure_acceptance_block` | 918/935 | 从任务正文提取/自动补齐验收三栏（判据/产物路径/红线） |
| `verify_acceptance` / `build_rejection_message` | 1055/1101 | 验收机检与打回话术生成 |
| `log_audit` | 1136 | 审计日志（每次派发/路由/收口都落） |
| `quota_signal_hit` / `handle_quota_hit` | 1183/1208 | Stand 回复命中额度打满信号词→停新单+车道改道+微信告警 |
| `write_inbox` / `read_inbox` | 5250/5261 | 收信箱落盘/读取（`data/inbox/{task_id}.json`） |
| `process_inbox_callback` | 5482 | inbox 回调处理（`_process_inbox` 隐藏子命令入口） |
| `_finalize_waiter` | 5532 | 等待者公共收尾：state 回填→机检+成本→写 inbox→标 .done（run/ask/bg 三处共用） |
| `_bg_worker` | 5666 | 已弃用 `--bg` 的执行进程（隐藏 `_worker` 子命令） |
| `_run_by_mode` | 5771 | 按模式执行一次「派发+轮询」，四种模式返回归一成同一形状 |
| `_find_inflight_dup` | 5906 | 重复派发闸：同 request 有在途任务则拒派 |

## 路由决策链：消息从微信进来到回执出去

主链路是 Hermes（Caller 角色）收到微信消息后跑 `caller.py go "<请求>"`（推荐）或 `run --wait`。完整数据流：

**第 1 步 · 分诊（`go` 入口，`_cmd_go` @6281）**
1. Gatekeeper 前置快拒：`check_should_dispatch`（@1293）判出 `blocked` → 秒退不建房不烧钱；判出 `operator`（Caller 自持白名单动作）→ 拒绝派发，提示自己跑。
2. 定模式：显式 `--mode` 优先；否则 `Caller.route_mode`（@4481）四格路由——
   - 命中「只要计划」词 → `think + plan_only`
   - 要判断不要东西 → `think`（多步则附 plan_only）
   - 要东西且多步有依赖 → `plan`（两段式）
   - 命中法律/代码重活词 → `worker`（重活车道，锚 `default_heavy_worker`，当前经 `HEAVY_LANE_STAND` 常量 @248 临时改道 kimi-k3）
   - 其余一律 → `fast`（快速 Worker hy3，2026-07-29 路由反转后的默认车道）
3. 头行 JSON 落 stdout（mode/role/template/route_reason），然后构造参数**委托 `_cmd_run`**（@6394）。

**第 2 步 · 模式收敛与组包（`_cmd_run` @5951）**
- `resolve_mode`（@613）把两代参数收敛成唯一决策，冲突直接报错退出。
- worker/fast 模式自动 `ensure_acceptance_block`（@935）给任务正文补验收三栏；plan 模式只 `extract_acceptance`。
- 重复派发闸 `_find_inflight_dup`（@5906）：同 request 在途就拒派。
- 写 state 文件（`~/.standcode/tasks/`），挂上面包屑回调（dispatch 一返回就记房间/水位线，等待者死了 reconcile 也能补收）。

**第 3 步 · 派发（`_run_by_mode` @5771 → `Caller.dispatch` @2436）**
- `_run_by_mode` 按模式分流：`plan`→`plan_and_execute`；`fanout`→`dispatch_parallel`；`fast`/`think`/`worker`→`dispatch_and_relay`。
- `dispatch` 内部：BLOCKED 硬闸 → 选模板（template_id > role > task_type > 默认）→ 模板健康闸（连续失败被隔离的模板硬报错）→ 依次尝试暖池认领（@2140，当前关）、旧会话复用（@3588）→ 未复用则 `create_room`（@1936）+ `add_stand`（@2080）spawn Stand → `send_message`（@2363）把任务直写进房间消息库。
- plan 模式走 `plan_and_execute`（@4163）：先 `dispatch_thinker` 出六段结构化计划，`_parse_plan`（@4639）校验，不合格三级降级（重申模板→降级为未结构化分析→plan_failed），合格则 `_execute_with_plan` 在同房间派 Worker。

**第 4 步 · 轮询收获（`poll_result` @2865）**
- 每 0.5s（`POLL_INTERVAL_SEC` @138）拉增量消息，用 `after_id=dispatch 返回的 message_id` + `stand_name` 精确锁定「我这条任务之后、我派的那个 Stand 的回复」——防复用房串旧话、防同房 Thinker/Worker 串台。
- 看 areco trafficState 红绿灯：`working` 继续等；`needs-user`（权限框/选择框卡住）连续命中返回 `stuck`；会话退出返回 `lost`；超时返回 `timeout`。
- 顺带扫额度信号词（`quota_signal_hit` @1183），命中即 `handle_quota_hit` 停新单+告警。

**第 5 步 · 收口回执**
- 单段模式在 `dispatch_and_relay`（@4041）内：completed 且有结果 → `relay_to_wechat`（@3859）代发微信（dry_run 只拼不发）；随后 `finish_room`（@1974）成功归档、写台账、失败留看板。
- 等待者模式（`run --wait` / `go` 的实际路径）在 `_finalize_waiter`（@5532）收口：state 回填终态 → completed 时机检产物文件 + 记每单成本 → `write_inbox`（@5250）落收信箱 → 标 `.done` → stdout 输出简报（`--brief` 截 700 字，全文在 inbox）。Hermes 侧靠 gateway 的进程退出通知唤醒，照 stdout 转述微信——全程不轮询、不推送。

**旁路 · 巡检与补收（cron 驱动）**
- `reconcile`（`_cmd_reconcile` @6849）：扫 state 文件，给死掉的等待者补收迟到结果、补归档。
- `harvest`（`_cmd_harvest` @7226）：每 10 分钟收割巡检，把无 caller 跟踪的房间结果「拍平」进 main 通道 inbox，靠 `inbox --digest` → cc-send 送达。
- `report`（@7438）/ `inbox`（@7537）：汇报与收信箱浏览/消化。

**ask 旁路（`_cmd_ask` @6455）**：向已存在的常驻会话直接追问（不走完整路由），用文件锁（`acquire_ask_claim` @6407）防同轮并发挤进同一会话，结果同样走 `dispatch_and_relay` → `_finalize_waiter` 链。

## Thinker / Worker 在哪里？

**没有独立代码。** `stand/` 目录只有 `registry.json` 一个文件——Thinker 和 Worker 是「areco 模板 + 角色映射」的组合：Caller 派单时按 registry 选出模板 id（如 `workbuddy-deepseek` 当 Thinker、`workbuddy` 当 Worker），由 areco 侧 spawn 成真实终端会话。Thinker 与 Worker 的行为差异全部来自 Caller 注入的任务正文模板（`THINK_TEMPLATE` / `PLAN_TEMPLATE`，见 `dispatch_and_relay` @4075-4078）和所用模型本身。配置分层是：角色（registry.json）→ areco 模板 → `config/` 配件字典（harness/model/preset）。

## 如何自己查询这份索引

索引已建在 `.codegraph/`（15 文件 / 671 节点 / 2027 边）。**必须 cd 到 standcode 目录执行**，CLI 路径是 `node /Users/gao/Code/codegraph/dist/bin/codegraph.js`：

```bash
cd /Users/gao/Code/StandCode/standcode

# 按关键词探索：符号源码 + 调用路径（最常用，先粗查）
node /Users/gao/Code/codegraph/dist/bin/codegraph.js explore "路由"

# 单个符号详情（定义位置 + 源码）
node /Users/gao/Code/codegraph/dist/bin/codegraph.js node route_mode

# 谁调用了它（顺藤摸瓜找上游）
node /Users/gao/Code/codegraph/dist/bin/codegraph.js callers dispatch_and_relay

# 它调用了谁（顺藤摸瓜找下游）
node /Users/gao/Code/codegraph/dist/bin/codegraph.js callees _cmd_run

# 文件列表与各文件符号数
node /Users/gao/Code/codegraph/dist/bin/codegraph.js files
```

实测示例：`callers route_mode` 返回 `_cmd_go`（@6281）、`_cmd_route`（@7770）和两个测试——印证了「go 自动分诊、route 手动预览」两条入口。索引查不到的细节（如分支内的条件调用）就直接 Read 源码，本文所有行号均来自实读。

## 读代码时的几个「意外点」（文档与现状的差异）

1. **大量机制「建有但关着」**：验收把关闸（`ACCEPTANCE_GATE_ENABLED`）、暖池（`STANDBY_ENABLED` @206 硬编码 False）、空转/定稿/硬超时三闸（`STALL_WATCHDOG_ENABLED` 等）当前全部默认关闭——代码在、开关关。读 docstring 里复杂的闸逻辑时别误以为它们在生效。
2. **重活车道是硬编码改道**：GLM-5.2 额度打满，`HEAVY_LANE_STAND = "kimi-k3"`（@248）临时顶替 `claude-glm52`，registry.json 里也有对应 `_note_status` 备注。GLM 恢复后需手动改回。
3. **`--bg` 已弃用但代码还在**（`_bg_worker` @5666）：新姿势是 Hermes 用 `background=true + notify_on_complete=true` 跑 `run --wait`，靠 gateway 进程退出事件唤醒。
4. **README 说 caller.py 是核心但没提体量**：实际 8404 行单文件、326 符号——改动前先用 codegraph 查 `callers`，别凭印象找调用方。
5. **registry.json 里 `zcode` 模板是占位未接线**（areco config.json 无此模板），别拿它派单。
