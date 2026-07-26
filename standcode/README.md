# StandCode

> 替身使者不亲自战斗——它召唤替身。
> Caller / Thinker / Worker 三层 agent 编排框架，跑在 [areco](https://github.com/bb4407777/areco) 会话底座之上。

> **仓库布局（2026-07-26 起，StandCode 为主）**：本目录属于 [bb4407777/standcode](https://github.com/bb4407777/standcode) **主仓**——StandCode 与底座 [areco](https://github.com/bb4407777/areco) 同仓演进的 monorepo（StandCode 在 `standcode/`，底座在 `packages/`）；`bb4407777/areco` 仓是每日自动同步的全量镜像。Issue / PR 请提到 standcode 主仓。npm 双包均从本仓发布：[`standcode`](https://www.npmjs.com/package/standcode) + [`areco`](https://www.npmjs.com/package/areco)。

**StandCode 解决一个问题**：让一个常驻入口 agent（Caller，例如接微信的 Hermes）把活派给各种 CLI agent（Claude Code / Kimi / DeepSeek / 任意 TUI harness），任务全程在 areco 看板可见，做完结果落收信箱——不轮询、不推送、零多余 token。

## 三层角色

| 角色 | 干什么 | 默认 |
|---|---|---|
| **Caller** | 纯指挥：识别请求 → 派发 → 收结果回执。不亲自干活 | 你的入口 agent（如微信 Hermes） |
| **Thinker** | 只规划：把复杂任务拆成结构化计划（目标/步骤/判据） | `stand/registry.json` 的 default_thinker |
| **Worker** | 只执行：按计划或直接指令干活 | `stand/registry.json` 的 default_worker |

三层不互调、不串层。执行者（Stand）永远是 areco 会话——看板可见、可接管、可回放。

## 配置分层（只有一套执行配置）

```
角色层   Caller / Thinker / Worker
  = 「该角色默认用哪个 areco 模板」的映射，不是配置体系
  编辑面 = areco 设置页「StandCode 默认角色」（GET/PUT /api/standcode/defaults）
  回落   = stand/registry.json（areco 未设置/不可达时）
      ↓ 选择（直接引用 areco 现有模板 id，不在 areco 里新建模板）
模板层   areco Template（执行配置唯一落点，areco config.json / 设置页维护）
  可带 harness / model / preset 三个可选字段 = 模板的深度自定义
  spawn 时 areco standcode-resolver 现场解析成 command/args/env
      ↓ 引用
配件字典  config/：harnesses.json（壳）models.json（模型）
  presets.json（预设）
```

## 派发与回收：收信箱拉模式

```bash
# 标准派发（等待者模式）：阻塞到 Stand 完成，结果写 data/inbox/ + stdout 全文
python3 caller/caller.py run --wait "调研 X 并输出报告" --role worker --summary "X调研"

# 两段式：Thinker 出计划 → Worker 执行
python3 caller/caller.py run --wait "设计一个方案" --plan

# 查任务 / 列任务
python3 caller/caller.py status <task_id>
python3 caller/caller.py list
```

- 任务完成只落 `data/inbox/{task_id}.json`，**不推送**；Caller 下次醒来 `ls data/inbox/` 拉取，汇报完 `mv` 加 `.done`。
- 长任务可选：支持后台进程追踪的宿主（如 Hermes gateway terminal 工具 `background=true + notify_on_complete=true`）跑 `--wait`，进程退出原生唤醒一次——事件、非轮询。
- 禁 shell 级 `&`/`nohup`/`setsid` 脱管（宿主追踪不到 = 唤不醒），`--bg` 已弃用。

## 快速开始

```bash
# 1. 前置：areco 跑在 127.0.0.1:8790，python3 ≥ 3.10
# 2. 角色映射：stand/registry.json 的 default_thinker / default_worker
#    直接填 areco 现有模板 id（areco 设置页可查），不新建模板
# 3. 配件字典（可选，仅当模板用 harness/model/preset 深度自定义时）
cp config/harnesses.example.json config/harnesses.json   # 改成你的 harness 路径
# 4. 本机私有配置（可选，微信代发用；不进仓）
cat > config/local.json <<'EOF'
{ "cc_send_bin": "<你的发信脚本>", "wechat_target": "weixin:dm:<你的会话id>@im.wechat" }
EOF
# 5. 派第一个任务
python3 caller/caller.py run --wait "回复两个字：成功"
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARECO_BASE` | `http://127.0.0.1:8790` | areco 服务地址 |
| `ARECO_ROOT` | `~/Code/areco` | areco 仓根（直写 projects.db 用） |
| `CC_SEND_BIN` | `cc-send`（或 config/local.json） | 微信代发脚本 |
| `WECHAT_TARGET` | 空（或 config/local.json） | 微信目标会话；空 = 跳过代发 |
| `STANDCODE_TASKS_DIR` | `~/.standcode/tasks` | 任务状态目录 |

## 与 areco 的关系

姊妹项目：areco 是通用会话底座（PTY 会话/房间/消息/看板/模板），StandCode 是其上的编排语义层。集成面：

- **REST**：建房、加 Stand（`/api/rooms`）；任务面板（`/api/tasks`）
- **projects.db**：房间消息直写（带 `human_relay` 转述闸）
- **模板引用**：`stand/registry.json` 的角色默认直接填 areco 现有模板 id；模板若带 harness/model/preset 字段，spawn 时 areco 侧 `standcode-resolver` 读本仓 `config/` 字典现场解析
- **看板**：Stand 即 areco 会话，活动任务自动置顶

## License

Apache-2.0
