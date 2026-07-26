# StandCode 工作模式规范

> 定稿：2026-07-26 | 落地：2026-07-26 | 作者：Opus5（Claude Fable 5）
> 依据：`caller/caller.py`（3182 行）、`stand/registry.json`、`config/presets.json`、
> `~/skills/StandCode/SKILL.md`、`docs/workflow-hardening.md`
> 结论一句话：**当前不是 3 种模式，是 1 条运维车道 + 2 条派发车道，另有 2 条已写进代码但没进taxonomy的车道（thinker-only、fan-out）。第 4 种模式该加，而且它 90% 已经建好了——缺的是命名、门控和一个 CLI flag。**

---

## 0. 先纠一个命名错误

现有说法「模式 1 = caller 直接做」把两件性质完全相反的事塞进了同一个格子：

| 实际是两回事 | 性质 | 代码怎么判 |
|---|---|---|
| **1a. Caller 干 Caller 的活**（派发、轮询、回执、查状态、健康检查） | 这是 Caller 的**本职**，不是一种「工作模式」 | `check_should_dispatch` → `category="operator"` |
| **1b. Caller 干 Worker 的活**（grep / git commit / 读源码做汇总 / 探索 CLI） | 这是**故障态**，是 `workflow-hardening.md` 整篇文档要消灭的东西 | `category="production"` → 必须派发 |

`docs/workflow-hardening.md` 第 4 节记着 2026-07-25 的账：08:21→09:03 共 42 分钟，高律师纠正 6 次，平均 7 分钟一次；案例 1 单轮 32 次直干。**把 1b 叫做「模式一」，等于给故障态发了合法身份证。** 本文之后一律：

- **模式 1 = Operator 自持车道**（边界 = `_OPERATOR_LEADING_TOOLS` 白名单，仅 5 个工具 + 4 条带条件规则）
- 1b 不是模式，是违规，归 Gatekeeper 管

---

## 1. 模式全景（含代码落点）

```
                     ┌─ 模式 1  Operator ──────────────  Caller 自己跑（白名单 5 个工具）
                     │        零 Stand · 零 room · 秒级
                     │
  微信 ── Caller ────┼─ 模式 2  → Worker ───────────────  1 room · 1 session · 1 poll
        (Hermes)     │        dispatch_worker + poll_result
                     │
                     ├─ 模式 3  → Thinker → Worker ─────  2 room · 2 session · 2 poll（串行）
                     │        plan_and_execute
                     │
                     ├─ 模式 4  → Thinker ⚠️未命名 ─────  1 room · 1 session（--role thinker 已通）
                     │
                     └─ 模式 5  → Worker × N ⚠️无 CLI ──  N room · N session（并行）
                              dispatch_parallel（仅 Python API）
```

| 模式 | 代码落点 | CLI | 自动路由可达 | SKILL.md 有 |
|---|---|---|---|---|
| 1 Operator | `check_should_dispatch` (caller.py:331) | `run check <cmd>` | — | ✅ |
| 2 Worker | `dispatch_worker` / `dispatch_and_relay` (1169/1616) | `run --wait` | ✅ `should_plan=False` | ✅ |
| 3 Thinker→Worker | `plan_and_execute` (1699) | `run --wait --plan` | ✅ `should_plan=True` | ✅ |
| **4 Thinker only** | `dispatch_thinker` (1145) | `run --wait --role thinker` ✅**已通** | ❌ 二元门控够不着 | ❌ |
| **5 Fan-out** | `dispatch_parallel` (2033) | ❌ 无子命令 | ❌ | ❌ |

`auto_dispatch`（caller.py:1916）的门控是**二元的**——`should_plan(request)` 真则 `plan_and_execute`，假则 `dispatch_worker`。模式 4、5 在自动路由里**结构性不可达**：不是没实现，是没有分支能选到它们。

---

## 2. 三种模式逐项分析

### 模式 1 · Operator 自持车道

**适用场景（这就是全部，白名单是穷举的）**

| 命令 | 用途 |
|---|---|
| `caller.py …` | 派发 / status / list / rooms / aggregate |
| `areco-msg.mjs …` | 房间内投递 |
| `cc-send` | 微信出站 |
| `pgrep` | 健康检查 |
| `hermes-switch-model.py` | 换模型（**会话外**，见硬红线） |
| `ps aux` / `launchctl list` / `cat .qclaw-hermes` / `echo '收到…'` | 只读自检、秒回 |

**优点**

- 零成本、零延迟：不建 room、不起 session、不烧 Stand token
- 唯一能做「秒回」的车道——流水线第 1 步（`收到，现在安排 <角色> <动作>`）只能在这条道上跑
- 灰区判定保守：`check_should_dispatch` 第 4 分支默认**派发**，宁可多派不可漏派

**缺点（都是真的，都有代码依据）**

1. **只有软约束**。`check_should_dispatch` 的 docstring 自己写着 advisory——只判定、不拦截。硬拒绝只发生在一处：`dispatch()` 里命中 `category="blocked"` 抛 `GatekeeperBlockedError`。也就是说 **`production` 类不会被拦，只会被记审计**。Hermes 完全可以不调用 Gatekeeper 就直接跑 `grep`——没有 pre-tool hook，Hermes v0.19.0 没有 `command_prefix`（`workflow-hardening.md` 附录已确认）。
2. **工具对称性陷阱**。`platform_toolsets.weixin` 只给 `terminal` 一个工具，它既是合法派发通道也是非法直干通道，工具层无法区分。
3. **审计闸没闭环**。`log_audit()` 已实现（写 `/tmp/standcode-audit.jsonl`），但 `scripts/audit-direct-work.py` 在 `progress.md` 里仍是 ⏳ 待做，`scripts/` 目录是空的。约定的「直干率 > 30% 微信告警」**目前不存在**。
4. **BLOCKED 有误伤面**。`_BLOCKED_PATTERNS` 匹配的是任务描述全文小写，所以「写篇文档解释为什么禁止 `rm -rf /`」这种**讨论型**请求会被硬拒。低频但真实。

---

### 模式 2 · Caller → Worker（默认车道）

**适用场景**

- 单步可完成、判据明确、无取舍空间的执行类活
- 门控信号：`DIRECT_KEYWORDS` = 总结 / 摘要 / 翻译 / 转格式 / 改成 / 找一下 / 查找 / 下载 / 套模板 / 提取
- 典型：下载法院文书、套模板生成文书、格式转换、指定路径查文件、单文件改动

**优点**

- 链路最短：1 room / 1 session / 1 次 poll，延迟和 token 都是模式 3 的一半
- `preset=direct`（`presets.json`）给 `thinking: minimal`、`timeout: 600`——不浪费推理预算在不需要推理的活上
- 失败面小：只有一个 Stand 会挂，`poll_result` 有 `stand_session_id` 提前退出检测（10s 心跳），不用空等满 timeout
- 收口干净：`finish_room()` 在 completed 时自动归档房间，失败留看板看现场

**缺点**

1. **执行层模型被迫兼任规划**。默认 Worker 是 `claude`（Claude CLI + GLM-5.2）、preset `thinking: minimal`。任务一旦比关键词暗示的复杂，Worker 要么自己临时规划（超出 `presets.worker` 的「只执行不重新规划」定位），要么交出浅结果。
2. **门控是纯关键词，无语义**。`should_plan` 只做 `any(k in text)`。「帮我总结一下这三套方案哪个可行」命中 `总结`（DIRECT）也命中 `方案`/`可行性`（PLAN）——按 `should_plan` 的实现（`direct_hit and not plan_hit → False`，否则 `return plan_hit`）会走模式 3，这次对了；但「把这个下载下来然后设计一个归档方案」同样双命中、同样走模式 3，规划的其实是下载后的事——**关键词无法表达任务结构**。
3. **无预算维度**。选模式 2 还是 3 完全不看任务值多少钱、等多久。

---

### 模式 3 · Caller → Thinker → Worker（两段式）

**适用场景**

- `PLAN_KEYWORDS`：调研 / 研究 / 方案 / 设计 / 架构 / 对比 / 规划 / 拆解 / 分几步 / 计划 / 梳理流程 / 可行性 / 评估 / 多步 / 分阶段
- 实质判据：**步骤之间有依赖，且第一步选错会让后面全废**——这才值得先花一个 Stand 把路走通

**优点**

- 强制结构化：`PLAN_TEMPLATE` 要求「目标 / 上下文 / 步骤 / 约束 / 完成判据 / 最终产物落点」六段
- **有硬闸**：`_parse_plan()` 校验必须有「步骤」段且能抓到编号行，不合格 → `plan_failed`，**不把烂 plan 喂给 Worker**。这是全系统少见的真硬闸（对比模式 1 的 advisory）
- 角色隔离靠 prompt 双向加固：Thinker 侧 `presets.thinker` 写「只规划不执行」；Worker 侧 `exec_request` 硬写「你是 Worker，只执行不决策……遇阻在结果里说明，不要擅自改方案」
- 分层用模型：Thinker = DeepSeek-v4-pro + `thinking: high`（600s），Worker = GLM-5.2 + `thinking: minimal`（900s）。贵的模型只用在想上

**缺点（含两处应当修的实现问题）**

1. **成本翻倍且串行**。2 room / 2 session / 2 次 poll 顺序执行。`run --wait` 的 `--timeout` 缺省是 **0 = 无限等**；显式给值时两段各等一次，最坏 2×timeout。
2. **⚠️ `plan_failed` 是全损**。plan 抓不到「步骤」段 → 直接 return，`result_text=""`，Worker 从不启动，用户什么都拿不到——即使 Thinker 那段分析写得完全可用，只是标题没按模板写。这是模式 3 最大的用户可见脆弱点。
3. **⚠️ 计划靠字符串搬运，两个 Stand 从不相见**。`plan_and_execute` 各建一个 room（两次 `dispatch` 都没传 `room_id`），Thinker 的输出被拼进 `exec_request` 的 prompt。后果：Worker 冷启动、拿不到 Thinker 的中间推理、**没法追问**（计划有歧义只能按 prompt 要求「在结果里说明」然后交半成品）。而 `dispatch()` 本来就支持 `room_id` 复用——能力在，没用上。
4. **Thinker 的产出被当耗材**。计划本身不落盘、不进任何台账，只在 `plan_text` 里活一次。同类任务再来一遍要重新想。
5. **没有并行拆解**。`PLAN_TEMPLATE` 里没有「可并行步骤」字段，`dispatch_parallel` 也接不上——即使 Thinker 看出 3 步能同时做，模式 3 也只能串着执行。

---

## 3. 优化建议

按「能不能今天做完」排序，每条都标了代码落点。

### P0-1 · 把「模式」升成一等字段

现在模式是**推断**出来的（看有没有 `--plan`、`--role`），没有任何地方记录「本次选了哪条车道」。

```
run --mode operator|worker|think|plan|fanout
```

- `_build_parser()`（3095）加 `--mode`，与现有 `--role`/`--plan` 互斥且向后兼容（老参数映射到新 mode）
- `log_audit()` 的固定字段加 `mode`（它已经有 `role`/`template`/`blocked`，加一个字段是一行）
- 收益：`audit-direct-work.py`（还没写）从「猜哪些 terminal 调用算直干」变成「数 mode 分布」，直干率变可数而不是可估

### P0-2 · `plan_failed` 从「全损」改「降级」

`plan_and_execute` 校验失败的两处 return（1745、1766）现在都是死路。改成三级降级：

1. 用 `PLAN_TEMPLATE` 重申一次格式，让 Thinker 再来一遍（限 1 次，防死循环）
2. 仍不合格 → **把 Thinker 原文当上下文降级走模式 2**（`exec_request` 里写明「以下是未经结构化的分析，请自行判断可执行部分」）
3. Thinker 连正文都没有 → 才是真 `plan_failed`

理由：不合格的原因九成是**标题没按模板写**，不是内容没用。为了一个 markdown 标题丢掉一整个 Stand 的产出，不划算。

### P0-3 · 两段式合并进同一个 room

`plan_and_execute` 的 Worker 阶段传 `room_id=plan_dispatch["room_id"]`（一行）。收益：

- 计划在房间历史里，Worker 原生可读，不必再往 prompt 里塞全文
- 一条链一个房间，看板上不再出现两个孤立 `⚙` 房
- 为「Worker 能向 Thinker 追问」留出通道（Thinker session 还活着就能问）

**落地注意**：`finish_room()` 会被同一 room_id 调两次（1808-1811），但**天然幂等**——它认的是 `dispatch_result["room_created"]`（840-856），不是参数来路：计划段 `room_created=True` 负责归档，执行段 `room_created=False` 记一条 `kept/reused_room` 后 no-op。两次调用都传 `exec_status`，所以归档时机仍是「整条链成功后」，语义不变。**改这行不需要额外加锁**。

### P1-1 · 门控从关键词升成「结构 + 预算」两维

`should_plan`（1828）纯 `any(k in text)`，两个词表已经在打架。改判两件事：

| 维度 | 问什么 | 落到哪个模式 |
|---|---|---|
| **结构** | 步骤间有依赖吗？第一步选错会不会让后面全废？ | 有依赖 → 要 Thinker |
| **交付物** | 用户最终要的是**东西**（文件/改动）还是**判断**（结论/取舍）？ | 要东西 → 要 Worker |

四格直接给出四种模式，**这正是第 4 种模式的位置**（见第 4 节）。再叠一层预算闸：任务预估 < N 分钟的一律不进模式 3（两段式的固定开销就吃掉了收益）。

### P1-2 · Fan-out 补 CLI + 进 taxonomy

`dispatch_parallel`（2033）实现完整（ThreadPoolExecutor、单项失败降级 `status=error` 不拖垮整批、各项自己 `finish_room`），但**只能从 Python 调**——CLI 没有子命令，SKILL.md 没写，Hermes 事实上用不到。加 `run --parallel <json>` 或 `dispatch-parallel` 子命令。

同时补 `PLAN_TEMPLATE` 的「可并行步骤」字段，让模式 3 能吐出可 fan-out 的计划——这才接上 `architecture-optimization.md` 建议 3。

**前置风险**（该文档自己也标了）：多 Worker 并发改同一文件会互相覆盖，`git worktree` 隔离（建议 4b）应当先落地。

### P1-3 · 计划复用

Thinker 产出落 `data/plans/{task_id}.md` + 一行 jsonl 台账（复用 `ledger_append` 的 append-only 写法）。同类任务先查有没有可改的旧计划，命中就省掉整个 Thinker 段。

### P2-1 · 把 Gatekeeper 从 advisory 推向硬闸

`production` 类目前只记审计不拦。Hermes 侧拦不住（无 hook），但**能在 areco 侧拦**：`room-relay` 收到消息先过 Gatekeeper 分类，`production` 类标 `deferred`（对应 `architecture-optimization.md` 建议 5，约 100 行 TypeScript）。

**⚠️ 顺序有硬约束**：areco 8790 承载会话，改完**不能在会话内重启**（CLAUDE.md 硬红线 + `agent-remote-v2-rebuild` 记忆条）。改动交高律师择时重启，别自己 kickstart。

### P2-2 · 补 `audit-direct-work.py`

`progress.md` 挂着 ⏳、`scripts/` 是空目录、SKILL.md 却已经写了「每日 cron 直干率 > 30% 微信告警」——**规则已宣布、执行体不存在**。有了 P0-1 的 `mode` 字段之后这个脚本就是读 jsonl 分组计数，半小时的活。建 cron 走 8020 API（`cron-skill-panel-20260723` 记忆条：禁手改 `jobs.json`）。

---

## 4. 额外问题：要不要加第 4 种模式（纯 caller → thinker）？

## **要加。而且它不是新建，是命名。**

### 4.1 它已经能跑了

```bash
python3 caller/caller.py run --wait --role thinker "分析 X 的三种路线并给推荐"
```

`--role thinker` 已在 `_build_parser()`（3113）的 choices 里，`_cmd_run` 的 wait 分支走 `dispatch_and_relay(role=args.role)` → `dispatch(role="thinker")` → 按 `registry.default_thinker` 选到 `workbuddy-deepseek-pro`。**今天就通。** 缺的只有三样：

| 缺什么 | 在哪 | 工作量 |
|---|---|---|
| 名字 | SKILL.md 没列它 → Hermes 永远不会选 | 写文档 |
| 门控分支 | `should_plan` 是二元的，够不着 | P1-1 的四格 |
| `plan_only` 没暴露 | 只有 `plan_and_execute` 内部设 `plan_only=True`（1730）；CLI 无 flag → `--role thinker` 拿到的是**自由格式回答**，不是结构化计划 | 加 `--plan-only` |

最后一条不是 bug，是**两种不同用途**，都该留：

- `--role thinker`（现状）= **问判断**，要的是分析和推荐，自由格式正合适
- `--role thinker --plan-only`（待加）= **要计划**，六段结构化，产物可以后续单独喂给 Worker

### 4.2 为什么必须有它——现在没有它，任务会被错误路由

| 任务 | 现在会走 | 问题 |
|---|---|---|
| 「这两套架构选哪个，为什么」 | 模式 3（`架构`/`对比` 命中 PLAN） | 白烧一个 Worker 段去「执行」一个只需要结论的判断 |
| 「梳理一下这三种模式的优缺点」 | 模式 3（`梳理流程` 命中） | 同上 |
| 同上，但用户加了「快点」 | 模式 2 | GLM-5.2 + `thinking: minimal` 去做需要 `thinking: high` 的活——**用错档位的模型** |

**当前这个任务就是标准模式 4**：高律师要的是「整理 + 优化建议 + 一个是否的判断」，交付物是**判断和文档**，没有任何东西需要 Worker 去执行。用模式 3 就是多烧一个 Stand 段；用模式 2 就是拿执行档模型做规划档的活。

### 4.3 补上后的四格闭合

```
                     交付物 = 东西（文件/改动）    交付物 = 判断（结论/取舍）
                   ┌──────────────────────────┬──────────────────────────┐
  单步 · 无依赖    │  模式 2  → Worker        │  模式 4  → Thinker  ★新  │
                   │  下载、套模板、转格式     │  选型、评估、复盘、给建议 │
                   ├──────────────────────────┼──────────────────────────┤
  多步 · 有依赖    │  模式 3  → Thinker→Worker│  模式 4 + --plan-only    │
                   │  调研并产出报告、重构     │  只要计划，执行另议/人做  │
                   └──────────────────────────┴──────────────────────────┘
              （N 个互不依赖的子任务 → 模式 5 fan-out，正交于本表）
```

四格填满，没有空格也没有重叠。这是判断「模式集合完整了」的标准——**不是数量对了，是划分维度闭合了**。

### 4.4 反方意见，以及为什么不成立

| 反对 | 回应 |
|---|---|
| 又多一种模式，Hermes 更容易选错 | 现在是**二元门控里塞四类任务**，必然错配（4.2 三例）。四格比二选一好选，不是更难 |
| Thinker 不落产物，等于「只说不做」 | 判断本身就是产物。选型结论、复盘、风险评估——这些的价值恰在于**别急着动手** |
| 用户想要的最终还是东西 | 那用户会接着说「按这个做」——第二轮走模式 2/3，计划已在手（配合 P1-3 计划复用直接接上）。**分两轮不是浪费，是给了一个审查点**——正是 `git commit` 类动作被要求「提 diff 由用户审查」的同一个道理 |

### 4.5 落地清单（半天量）

1. `--plan-only` flag：`_build_parser()` 加参数，`_cmd_run` wait 分支透传到 `dispatch_thinker(plan_only=True)`（现在这个参数从 CLI 够不着）
2. `--mode think` 作为 `--role thinker` 的语义别名（配合 P0-1）
3. `should_plan` → `route_mode()`，返回四格之一（配合 P1-1）
4. SKILL.md：模式表从 2 行扩到 5 行，四格图入「两段式工作流」节（该节名也该改，它现在只讲了两种）
5. `presets.json` 加 `thinker_only` preset：`thinking: high`，**不带**「产出计划供 Worker 执行」这句——因为这条道没有下游 Worker

---

## 5. 修正后的模式总表

| # | 模式 | 何时用 | Room/Session | 硬闸 | 状态 |
|---|---|---|---|---|---|
| 1 | **Operator** | Caller 本职：派发/轮询/回执/秒回/自检 | 0 / 0 | ⚠️ advisory only | ✅ 在用 |
| 2 | **→ Worker** | 单步、判据明确、要东西 | 1 / 1 | — | ✅ 在用（默认） |
| 3 | **→ Thinker → Worker** | 多步有依赖、要东西 | 2 / 2 串行 | ✅ `_parse_plan` | ✅ 在用 |
| 4 | **→ Thinker** ★ | 要判断不要东西；或只要计划 | 1 / 1 | — | 🟡 **能跑，未命名** |
| 5 | **→ Worker × N** | N 个互不依赖子任务 | N / N 并行 | — | 🟡 **有 API，无 CLI** |

> **1b「Caller 直干生产类活」不在此表**——那不是模式，是违规，归 Gatekeeper 管，归直干率审计数。

### 一句话决策树（给 Hermes 背）

> 这活要**东西**还是要**判断**？
> → 判断 → **模式 4**（Thinker）
> → 东西 → 步骤之间有依赖吗？
>   → 有 → **模式 3**（Thinker→Worker）　→ 没有 → **模式 2**（Worker）
> → 是 N 个互不相干的子任务？ → **模式 5**（fan-out）
> → 以上都不是，是我自己的派发/回执动作？ → **模式 1**（白名单核对后直跑）

---

## 附一：落地状态（2026-07-26）

本文的建议已基本落地，8 个 commit（`66154a4`…`255bfb0`），测试从 0 断言到 56 断言
（`caller/test_modes.py`，零依赖、不碰 areco、不烧额度）。

| 项 | 状态 | 落点 |
|---|---|---|
| P0-1 模式一等字段 | ✅ | `resolve_mode` / `--mode` / `--plan-only` / `--sub` / `log_audit.mode` |
| P0-2 plan_failed 三级降级 | ✅ | `plan_and_execute` + `PLAN_RETRY_TEMPLATE` |
| P0-3 两段式共享房间 | ✅ | `_execute_with_plan(room_id=plan_dispatch[...])` |
| P1-1 四格路由 | ✅ | `Caller.route_mode` |
| P1-2 fanout CLI | ✅ | `--mode fanout --sub`（⚠️ 无文件隔离，见下） |
| P1-3 计划复用 | ✅ | `save_plan` / `find_similar_plan` / `--reuse-plan` / `caller.py plans` |
| P2-1 Gatekeeper 硬闸 | ⛔ 卡住 | 需改 areco `room-relay`——禁会话内重启 8790，且 areco 工作树有并行会话的未提交功能 |
| P2-2 直干率审计 | ✅ 有保留 | `scripts/audit-direct-work.py`——算的是**跟进率**不是真直干率，口径见脚本抬头 |
| 模式 4 五件套 | ✅ | `--plan-only` / `--mode think` / `route_mode` / SKILL.md / `presets.thinker_only` |

**落地过程中推翻的两个判断**（原文有错，此处更正）：

1. **P0-3 按原方案会把系统搞坏。** `poll_result` 按排除法认 Stand 且 `after_id` 默认 0，
   共享房间会让 Worker 的 poll **秒回 Thinker 的计划**当执行结果。已先修 `poll_result`
   （加 `stand_name` + 全部调用点传 `message_id`）才做 P0-3。顺带修掉一个**当时就存在**的
   线上 bug：`run --room-id` 复用房间会秒回旧答案。
2. **正文第 2 节「Thinker=thinking:high / Worker=thinking:minimal」是错的。**
   `config/presets.json`（连同 `harnesses.json` / `models.json`）**当前完全没生效**——
   areco 侧 `standcode-resolver` 开头就 `if (!template.harness) return null`，而 areco
   `config.json` 里没有任何模板设了 `harness`/`model`/`preset`。这些 thinking 档位与
   timeout 从未传给任何模型；唯一在起作用的角色约束是 `PLAN_TEMPLATE` 与 `exec_request`
   的提示词。新加的 `thinker_only` preset 同理，目前也是死的。**待定：补活还是删掉。**

## 附二：实现问题清单

| # | 问题 | 状态 |
|---|---|---|
| 1 | `plan_failed` 全损：标题不合模板 → Worker 不启动、用户零产出 | ✅ 三级降级 |
| 2 | 两段式两个 room，计划靠 prompt 搬运，Worker 冷启动且无法追问 | ✅ 共享房间 |
| 3 | `should_plan` 纯关键词，PLAN/DIRECT 词表交叉 | ✅ `route_mode` 四格 |
| 4 | `dispatch_parallel` 无 CLI 入口，事实不可用 | ✅ `--mode fanout` |
| 5 | `plan_only` 从 CLI 够不着 | ✅ `--plan-only` |
| 6 | Gatekeeper `production` 类只记审计不拦 | ⛔ 需 areco 侧改造 |
| 7 | SKILL.md 已宣布「直干率 >30% 告警」，执行体不存在 | ✅ 脚本已补（口径见附一） |
| 8 | `_BLOCKED_PATTERNS` 匹配全文，讨论型请求会被误拒 | ⬜ 未做（低频） |

### 附三：只读审计（2026-07-26）另发现并已修的 StandCode 缺陷

| 缺陷 | 后果 | 状态 |
|---|---|---|
| `poll_result` 排除法认人 + `after_id=0` | 复用房秒回旧答案（已复现） | ✅ |
| 模板 id 不存在时先建房再炸 | 孤儿房，且未进台账 → `--sweep` 扫不到 | ✅ 建房前校验 + 失败回滚 |
| 往已归档房间派任务 | areco 永不投递 + `--wait` 无限等 = 静默挂死 | ✅ 当场拒绝 |
| `ARECO_ROOT`/`TASKS_DIR` 走 `Path.home()` 而 `HOME_DIR` 走 local.json | 隔离 HOME 下建真房起真 Stand（烧额度）后炸 | ✅ 统一 `HOME_DIR` |
| `process_inbox_callback` 无条件删 inbox | cc-send 失败 → 结果唯一副本消失 | ✅ 发成功才删 |
| `get_messages` 吞 `OperationalError` | 库锁/schema 漂移 → 永久挂死 | ✅ 连续失败即抛 |
| `send_callback_trigger` 不查空 `WECHAT_TARGET` | cc-send 回落活跃会话指针 → **发错人** | ✅ 补闸 |
| `prepare_workspace` 不看 git returncode | 谎报「已建好隔离工作树」 | ✅ 检查 + 如实报 failed |
| `.processing` 锁 TOCTOU 且永不过期 | 进程被杀 → 该 task 永远 `locked`，无 CLI 可清 | ✅ `O_EXCL` + 过期抢占 + `inbox --unlock` |
| `auto_dispatch` 直派分支从不 `finish_room` | 每次调用泄一个房间 | ✅ |
| import 期裸 `float()` | 配置手误 → 整个 CLI 死在 import | ✅ `_conf_float` |
| `--adopt` 立即写且不可逆 | 误认领后该房永远被当自家的 | ✅ 干跑默认 |
| `.done` 无 GC | `data/inbox/` 只增不减（实测积压 17 个） | ✅ `inbox --gc` |
| `AUDIT_LOG_PATH` 在 `/tmp` | macOS 清 /tmp = 审计证据蒸发 | ✅ 挪 `~/.standcode/` |
