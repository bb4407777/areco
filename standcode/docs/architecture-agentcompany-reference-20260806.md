# AgentCompany（PetAgent）架构参考 —— 供 StandCode 借鉴

> 定稿：2026-08-06 | 作者：Hermes（高律师 08-06 令：读透 AgentCompany 后提炼架构参考，与 father 设计文档配套）
> 来源：`/Users/gao/clone/AgentCompany/`（depth 1，36M，2026-08-06 clone，独立仓库非 fork）
> 对应设计：`architecture-father-role-20260806.md`（father 角色 = 本参考 §2 Psychologist 的简化版）
> 状态：**参考文档，不直接改 StandCode 代码**

## 0. 一句话

PetAgent（AgentCompany）是「1 人 AI 公司操作系统」：CEO（你）+ 6 个内置 role 员工
（Coordinator / Explorer / Planner / Executor / Reviewer / Psychologist），
任务分 Goal → Issue 三层，预算可见、审批把关，卡住了 Psychologist 介入，
做完了 Reflector 写经验，每周 SkillMiner 提炼成新 skill 让团队进化。
**它的 Psychologist 子系统 = 你 father 设想的完整成熟版。**

## 1. 角色全景（与 StandCode 对照）

| PetAgent 角色 | 职责 | StandCode 对应 |
|---|---|---|
| Coordinator | 拆 Goal 为 Issue、派活 | Caller / 编排层 |
| Explorer / Planner | 探索、规划 | thinker（Kimi k3） |
| Executor | 执行 | worker（DeepSeek-v4-flash） |
| Reviewer | 审查（逻辑 bug 归它管） | gate_result 验收闸 |
| **Psychologist** | **监听情绪/行为信号，卡住时介入纠正** | **father（你的新角色）** |
| Reflector / SkillMiner | 写反思、周批提炼 skill | StandCode 无（可借鉴） |

关键差异：PetAgent 把「纠错者」做成了**独立旁路角色 + 事件驱动**——正是你 father 的定位。

## 2. Psychologist 子系统（father 的成熟参考，重点读）

### 2.1 链路：BehaviorMonitor → Classifier → InterventionDispatcher

```
每个 agent 的 run 记录 ──▶ BehaviorMonitor（信号检测）
                              ├─ consecutive_failures  连续失败 ≥ 3 次（RUN_HISTORY_DEPTH=5）
                              ├─ output_length_drop    输出坍缩（近 3 轮长度掉 > 2σ）
                              └─ tool_error_rate_high  工具错误率 > 50%（≥ 5 次采样）
                              └─▶ 6 信号分类（frustration / low_confidence / confusion /
                                  over_cautious / giving_up / angry）
                              └─▶ severity 分级（mild / moderate / severe / escalated）
                              └─▶ InterventionDispatcher 注入干预
```

源码实测（`packages/psychologist/src/`）：
- `behavior_monitor.ts`：阈值全部常量，连续失败=3、工具错误率=0.5、输出坍缩=2σ
- `intervention_crafter.ts`：**每种信号有专门的一次性提示词**（MILD_BY_SIGNAL），
  不是笼统说「加油」——frustration 让它列「已确认有效/假设未验证/失败间差异」，
  low_confidence 让它「删掉委婉词直接跑验证」，confusion 让它「一句话重述任务」

### 2.2 分级干预（核心设计）

| 级别 | 动作 | 对应 father 建议 |
|---|---|---|
| mild | 注入一次安抚 prompt（内部声音，目标 agent 看不见） | father 给建议 |
| moderate | 注入 + 在看板发评论（可见） | father 建议 + 微信汇报 |
| severe | 暂停 issue + 开疗愈对话 | 暂停任务 + 报人工 |
| escalated | 3 次干预失败 → 拆 issue / 叫人类 | 升级人工兜底 |

### 2.3 预防模式（比 father 设想更前一步）

Psychologist 在**其他角色启动时**自动注入「元认知前言」：
- 该角色最近 Top 3 反复失败模式
- 常见合理化借口（如「我以为是环境问题」）
- 「Recognize and do the opposite」教练式提醒

→ StandCode 借鉴：worker/thinker 每次启动时，father 可以预注入「本模板最近踩过的坑」。

### 2.4 透明策略（γ 严苛度）

- 所有干预**写 audit log**（`emotional_incidents` 表），人随时可查可关
- 干预默认**不可见**（写「内部声音」，不说「Psychologist 说」），避免干扰 agent
- 被 @mention 才透明对话
- 参考「Intervention Paradox」论文：盲目介入会让 agent 表现掉 26%——
  **介入不是越多越好**，所以做透明面板 + 严苛度滑杆 + 一键关闭

### 2.5 边界（Psychologist 不做什么，直接转对口渠道）

| 情况 | 转给谁 |
|---|---|
| 逻辑 bug | Reviewer |
| 环境问题（缺 env / API down） | 用户 / 平台 |
| 模型能力不够 | 建议升级模型 |
| 目标不清 | CEO / 用户澄清 |

→ StandCode father 同理：**不重复修 Gatekeeper/模板的活，只做运行期行为纠正**。

### 2.6 模型选择（关键）

Psychologist 用 **claude-haiku（轻量模型）**，不是最强模型——
因为干预是「低频、短提示词」任务，不需要重推理。
→ father 同理：可用轻量模型，不必上 kimi-k3（省 token）。

## 3. SkillMiner 自进化（StandCode 缺的一环，可借鉴）

- **Notes 记忆层**：每次 heartbeat 写一条反思（templated 或 Haiku-backed），
  pgvector 语义检索按意义召回（非关键词）
- **SkillMiner 周批**：上周所有 notes 喂 LLM，找 **≥3 次重复的 patterns**，
  提炼成 Skill 候选 —— 你只批不写
- **KPI 比较器 + Auto-Rollback**：Trial skill 成功率不达标自动 retire；
  **30 天没用过的自动归档**（Ebbinghaus 遗忘曲线：agent 也需要主动遗忘）
- **项目记忆 git sync**：notes + skills 自动 push 私有 git remote

→ StandCode 借鉴思路：areco 会话消息可以像 notes 一样周批，
把高频错误模式提炼成 skill（你们已有 skills 目录 + memory 中台，这是天然落点）。

## 4. 预算与治理（StandCode 已有雏形）

- 每次 LLM 调用成本可见，**70/90/100% 阈值告警** + 硬停（auto-pause）
- 敏感操作必须审批
- V1 决策：预算按月 UTC 窗口；软告警 + 硬上限自动暂停

## 5. 执行语义（值得 StandCode 抄的硬规则）

- **单 assignee 硬不变量**：issue 最多一个 assignee（agent 或人，不能同时）
- **in_progress 不允许静默死状态**：agent 拥有的 in_progress 必须有执行路径
- 结构（父子 issue）/ 依赖（blocker）/ 归属（谁负责）/ 执行（有没有活路）**四概念分离**
- 恢复不自动重派：work recovery 保持手动/显式（避免乱抢活）

→ StandCode 对照：派发时「单 assignee + 显式状态」基本一致，
「in_progress 不许静默死」对应你们 poll_result 的 stall/超时兜底。

## 6. 外部 adapter（混合编队）

- 8 种外部 agent（Claude Code / Codex / Cursor / OpenClaw / OpenCode / Pi / Hermes / Gemini）
  同一块看板协作，当「外包实习生」
- 归一化 Hook 总线：Psychologist 也能干预外部 adapter

→ StandCode 已有类似（harness 支持 openclaw/claude/kimi/codex/qoder/hermes）。

## 7. 对 StandCode 的落地建议（优先级排序）

1. **father 角色直接抄 Psychologist 的分级干预**（mild/moderate/severe/escalated +
   按信号定制提示词 + audit log）——father 设计文档里补上这层细节
2. **预防模式**：worker/thinker 启动时预注入「本模板最近踩坑 Top3」——低成本高收益
3. **father 用轻量模型**（Psychologist 用 haiku 的先例），不必 kimi-k3
4. **SkillMiner 思路**：areco 会话消息周批 → 提炼高频错误模式为 skill
5. **γ 严苛度**：father 介入强度做成可调（滑杆/开关），参考 Intervention Paradox

## 8. 源码速查（要抄时看这里）

- `packages/psychologist/src/behavior_monitor.ts` —— 信号检测阈值
- `packages/psychologist/src/intervention_crafter.ts` —— 分级提示词（可直接改写成 FATHER_TEMPLATE）
- `packages/psychologist/src/dispatcher.ts` —— 注入链路
- `packages/skill-miner/src/types.ts` —— 周批 Skill 挖掘
- `packages/my-agent-adapter/built-in-roles/*.md` —— 6 个 role 的 instruction 全文
