# StandCode

微信通道为入口的多 agent 调度框架：

- **Client**：用户前端（当前是微信对话）
- **Caller**：Hermes 中间层，接收 Client 请求、决策、分发给 Stand
- **Stand**：子 agent，执行具体任务

## 当前阶段

以 areco 作为 Stand 运行底座，房间(room) + 模板工人(template worker) = 临时 Stand。
Caller 封装 areco API，提供统一调度接口。

## 目录

```
StandCode/
  caller/    # Hermes Caller 核心
  stand/     # Stand 模板与注册表
  client/    # 微信/其他 Client 适配
  docs/      # 架构与协议文档
```

## 第一里程碑

- [ ] Caller 能够接收一条自然语言请求
- [ ] 根据请求类型选择合适 Stand（模板）
- [ ] 在 areco 中创建/复用 room，派发任务
- [ ] 收集 Stand 结果并返回给 Client
- [ ] 结果模板化：一句话结论 + 文件路径 + 核心要点 3-5 条

## 流程固化：Caller 派发纪律（2026-07-25）

> 背景：Hermes（Caller）在微信平台只有 `terminal` 一个工具——它既是**合法派发通道**（`areco-msg` / `caller.py`），也是**非法直干通道**（`git` / `grep` / `curl` / `python3`）。工具本身不做区分，全凭 Caller 自觉选路，导致频繁跳过派发自己干活（2026-07-25 session `20260725_151549_e91ec1c3` 录得 4 起跳过实例，用户 42 分钟内纠正 6 次）。
> 完整根因分析、技术方案与错误案例见 `docs/workflow-hardening.md`。

### 根因（四条）

1. **工具对称性陷阱**：`terminal` 既能派发也能直干，LLM 全凭自觉。
2. **缺硬闸机制**：无 pre-tool hook / 命令白名单；SKILL.md 规则是软约束。
3. **惯性 + 局部最优**：派发要 3-5 步，直干 `cat`/`grep` 一步到位，模型本能先干。
4. **缺执行前 checklist**：旧规则是行为描述，不是「动手前先问该不该派」的决策树。

### 三道防线（已落地）

**1. SKILL.md 规则层**（`/Users/gao/skills/StandCode/SKILL.md`）
- **禁止直干清单**：`git / grep / curl / python3 / sed / vim / open` 等必须先 `dispatch_worker`。
- **允许直干清单**：仅 `areco-msg / caller.py / pgrep / cc-send / echo '收到' / launchctl list` 可直干。
- **派发铁律决策树**（自拦截口诀）：每次 terminal 前先过白/黑/灰三分类。
- **Terminal 前置声明**：每次调 terminal 在 reasoning 中声明「派发检查：此命令 [X]，属于白名单 / 禁止直干 → 改为 dispatch_worker」。

**2. caller.py Gatekeeper 层**（`check_should_dispatch`）
```bash
# 动手前先核查：返回 {should_dispatch, category, reason, suggested_action}
python3 caller/caller.py check "<任务或命令>"
# 或编程式
python3 -c "from caller import check_should_dispatch; print(check_should_dispatch('git commit'))"
```
判定顺序：高危动作（git commit/rm -rf/bootout，即便跟在白名单后）→ 以白名单工具调用开头（放行）→ 生产类信号（必须派发）→ 灰区（保守派发）。Advisory 软约束，目的是让 Caller「过一遍脑子」。

**3. Caller 流水线**（不可跳步）
```
Client 请求
  → 立刻秒回「收到，安排 <角色> <动作>」(cc-send)
  → check_should_dispatch(任务) 核查
  → should_plan? 两段式(Thinker→Worker) : 直派 Worker
  → 主动轮询 / inbox 回调（>5min 主动 caller.py status）
  → 按模板汇总回执（一句话结论 + 文件路径 + 3-5 要点）
```

### 铁律

Hermes 是**路由器，不是执行器**。「这个我能做」≠「我应该做」——能交给 Worker 的一律派出去。

### 后续（待落地）

- **方案 A** `terminal-guard.sh` 命令拦截器：待 Hermes 支持 `command_prefix` / `tool_hooks` 后部署。
- **方案 D** 每日直干率审计 cron（`audit-direct-work.py`）：直干率 > 20% 微信告警。

参考：`docs/workflow-hardening.md`（根因 + 4 技术方案 + 5 硬化措施 + 4 错误案例）。
