# father 角色架构设计（架构师/设计师，错误纠正者）

> 定稿：2026-08-06 | 作者：Hermes（高律师架构想法落地为设计文档）
> 状态：**设计稿，未实现**——高律师 2026-08-06 选 B 方案，先记文档不碰代码
> 依据：`caller/caller.py`（gate_result/unhealthy/classify_error_code 实测）、`work-modes.md`

## 0. 一句话

在 Caller/Thinker/Worker 之外加一个 **father 角色**：架构师/设计师，
平时隐身（不建 room 不起 session 零成本），只在系统出错时被拉起来
读错误日志 → 定位根因 → 给修复建议；是否动手修由高律师拍板。

## 1. 角色全景（高律师 2026-08-06 定）

```
Hermes（底座/入口）
 ├─ worker  = Hermes harness + DeepSeek-v4-flash   ← 执行
 ├─ thinker = Kimi k3（Hermes 子代理）             ← 规划/判断
 └─ father  = 架构师/设计师                        ← 平时隐身，出错才现身
```

## 2. 挂点分析（现成错误出口，不用新挖）

| 现有机制 | 代码落点 | 现状 | father 插入点 |
|---|---|---|---|
| 验收闸 escalated | `gate_result`（caller.py:4269） | 打回一次仍不过 → **升级人工** | 升级人工前先拉 father 诊断 |
| 模板隔离 | `template_mark_failure` / `unhealthy_until`（caller.py:1704） | 连续失败 N 次 → 隔离 TTL，**静默** | 隔离时拉 father 分析根因 |
| 错误分类 | `classify_error_code`（caller.py:987） | status/error 分类，error 不重试 | error 终态可触发 father |

## 3. 角色定义（FATHER_TEMPLATE 草案）

仿 PLAN_TEMPLATE/THINK_TEMPLATE，写进 caller.py 模板区：

```
你是 father（架构师/设计师），平时不参与运行。系统出现如下错误，
请阅读错误日志 → 定位根因 → 给出修复建议。

【任务原文】
{request}

【错误信息】
{error_context}

【输出格式】
根因：<一句话，基于日志证据，不猜测>
证据：<日志原文关键行/状态码/复现步骤>
影响：<波及范围，当前任务是否可重试>
修复建议：<改哪里/改什么/怎么验证>
风险：<修复的副作用与回滚方法>
```

**铁律：father 只诊断建议，不直接改代码/配置**——防止它自己引入新错。

## 4. 触发条件（建议，待实现时定稿）

1. `gate_result` escalated 时（注意：验收闸 `ACCEPTANCE_GATE_ENABLED=False`
   已关停 2026-07-29，此链路依赖闸开关）
2. `template_mark_failure` 达隔离阈值时（**推荐主链路**，不依赖验收闸）
3. worker 返回 status=error 终态时

## 5. 模型选择

- father 用 **kimi-k3**（与 thinker 同级，推理够强读日志做诊断）
- 实现：复用 kimi-k3 模板 + role 区分，或新注册 `father` role

## 6. 成本与边界

- 平常零成本（不建 room 不起 session，错误是低频事件）
- 出错时烧一次 thinker 级 token（K3 单轮），可接受
- 输出诊断报告 → 微信汇报 → 高律师拍板修复（或设低危自动修/高危报人分级）

## 7. 与现有体系关系

- 不是新「模式」：不占 mode 1-6 的任何一格，是错误路径上的旁路诊断
- 不替代 Gatekeeper：Gatekeeper 管派发前的拦截，father 管运行后的纠错
- 不替代 unhealthy 隔离：father 建议修复后，隔离计数正常衰减

## 8. 待办（实现时）

- [ ] 加 FATHER_TEMPLATE（caller.py 模板区）
- [ ] 注册 role：registry.json 加 father 模板映射（复用 kimi-k3）
- [ ] 接 unhealthy 触发（推荐）或 gate_result escalated 触发
- [ ] 诊断结果微信汇报链路（caller → 收信箱 → Hermes）
- [ ] 低危自动修/高危报人分级规则
