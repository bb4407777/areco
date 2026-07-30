# standcode/caller/hermes — Hermes（精简版）运行依赖收编

把「Hermes 微信 Caller」跑起来所需的全部运行依赖收进本目录：vendored 的 `hermes-agent` 包本体、家目录配置层模板、自有 bin 脚本、launchd 存档。目标是**代码进仓可复刻**——在另一台机器（或重装后）照本 README 能复原出一个可跑的 Hermes 家目录。

> 本期只做收编，**不做切换**：在跑的 gateway 仍指向系统 pip 包与原家目录，本目录是快照副本。把在跑服务切到 vendored 代码是后续独立事项。

## 目录结构

```
standcode/caller/hermes/
├── README.md                  # 本文件
├── VENDORED.md                # 第三方代码归属（hermes-agent MIT / tirith / lens）
├── requirements.txt           # hermes-agent 0.19.0 钉版依赖（核心，不含 extras）
├── hermes_cli/                # vendored hermes-agent 0.19.0 包本体（去 __pycache__，含 MIT LICENSE）
├── bin/                       # 家目录 bin/ 自有脚本（原样收，注释级脱敏）
│   ├── qoder-llm-shim.py          # qoder 本地 LLM shim
│   ├── hermes-profile-sync.py     # profile 配置同步
│   ├── kimi-oauth-proxy.py        # 静态 api_key → Kimi OAuth 桥
│   ├── hermes-charter-sync.py     # 章程镜像生成
│   ├── hermes-token-report.py     # token 用量周报
│   ├── hermes-nightly-qclaw.sh    # 每夜维护脚本（外部 cron 调度）
│   ├── qclaw-reasonix-shim.py     # Reasonix → qclaw gateway shim
│   ├── lens                       # 瘦命令工具箱（Python）
│   └── tirith                     # 18MB arm64 二进制工具（家目录自带，原样收）
├── home/                      # 家目录配置层模板（全部脱敏，*.example.*）
│   ├── SOUL.example.md            # 通用 Caller/分身人格骨架（真身不进仓，见下）
│   ├── agent.example.json         # agent 元数据字段结构示例（真身不进仓）
│   ├── config.example.yaml        # 主配置：7 个 provider 的 api_key 全占位，路径为 <HOME>
│   ├── channel_directory.example.json  # 通道路由表：微信 id 占位
│   ├── platforms/pairing/*.example.json  # 配对表结构示例（键名保留、值占位）
│   ├── weixin/accounts/*.example.json    # 微信账号同步态结构示例（真身是通道凭证，不入仓）
│   ├── scripts/morning-todo-data.example.sh  # 晨报数据源脚本模板（<HOME> 占位）
│   └── profiles/
│       ├── second/            # config.example.yaml + SOUL.example.md + agent.example.json
│       └── secretary-01/      # 同上
└── launchd/                   # 6 个 launchd plist 存档（绝对路径保留现状值，按需改）
    ├── ai.hermes.gateway.plist
    ├── ai.hermes.gateway-second.plist      # 历史存档：连字符版 07-30 已删（launchd 早已 disabled）
    ├── ai.hermes.gateway.second.plist      # ⚠️ 见下「疑似重复」
    ├── ai.hermes.gateway.secretary.plist
    ├── ai.hermes.profile-sync.plist
    └── ai.hermes.qoder-shim.plist
```

## gateway-second 与 gateway.second 重复（已定性）

`launchd/` 里 `ai.hermes.gateway-second.plist` 与 `ai.hermes.gateway.second.plist` 是两个 Label 不同、但都指向同一 profile（`HERMES_HOME=<HOME>/.qclaw-hermes/profiles/second`）的 plist：前者带 `--profile second` 参数与 Throttle/ExitTimeOut 调优，后者带 `API_SERVER_*` 环境变量。2026-07-30 已定性：**现役 = 点号版 `ai.hermes.gateway.second`**（launchd 装载中）；连字符版 `ai.hermes.gateway-second` 早已被显式 disabled、当日其 plist 已从 LaunchAgents 删除，此处仅存档。复原时只用点号版。

## 排除清单（运行时状态不进仓）及理由

家目录约 204MB，大头是运行时状态与凭证，一律不收：

| 排除项 | 理由 |
|---|---|
| `auth.json` / `auth.lock` | 登录凭证 |
| `*.db*`（state/kanban/memory_store/response_store/audit/verification_evidence） | 运行时 SQLite 状态，可重建 |
| `sessions/` `logs/` `cache/` `state/` `lsp/` | 会话、日志、缓存等运行时产物 |
| `memories/` `kanban*` `workspace/` | 业务数据与工作区，属使用者私有内容 |
| `gateway_state.json` `processes.json` `gateway.pid/.lock` | 进程态，每次启动重生 |
| `audio_cache/` `image_cache/` `models_dev_cache.json` 等 | 缓存 |
| `.hermes_history` `.env` `.update_check` 等隐藏文件 | 含历史命令/本地环境值 |
| `__pycache__/` `*.bak*` | 构建残留与备份 |
| `weixin/accounts/` 真身 | 微信通道同步凭证（只收结构示例） |

保险措施：仓库根 `.gitignore` 已加 `standcode/caller/hermes/**/config.yaml` 与 `standcode/caller/hermes/**/auth.json`，防止未来误把真配置/真凭证提交进仓。

## 人格文件自备（SOUL.md / agent.json 真身不进仓）

`SOUL.md` 与 `agent.json`（含各 profile 下的）是**人格层真身**：含使用者真实姓名、业务细则与通道安全闸，属内部信息，一律不进仓（2026-07-30 定）。仓里只有重写的通用骨架 `SOUL.example.md` / `agent.example.json`（身份/经历/风格三段 + 工作守则占位说明），零个人信息。

- **真身放哪**：`<HERMES_HOME>/SOUL.md`、`<HERMES_HOME>/agent.json`（profile 分身放 `<HERMES_HOME>/profiles/<name>/` 下同名文件）。
- **怎么复原**：把本地真身直接拷回复原的家目录对应位置即可（真身在你自己的备份/原机器上，不在本仓）；若从零起新分身，以 `*.example.*` 为模板填写，「工作守则」段按自己环境的工作章程重写——骨架注释里列了建议覆盖的通用主题，勿照抄任何他人守则。
- `agent.json` 的 `bio` 数组与 `SOUL.md` 各段内容保持一致（经历/风格/工作守则三段对应）。

## 从模板复原一个可跑的家目录

```bash
# 0. 装依赖（Python 3.12+，建议 venv）
pip install -r requirements.txt
#    仓内已 vendor hermes_cli/：把本目录加入 PYTHONPATH，或 pip 安装 hermes-agent==0.19.0 亦可

# 1. 建家目录
export HERMES_HOME=<你的家目录，如 ~/.hermes>
mkdir -p "$HERMES_HOME"/{profiles/second,profiles/secretary-01}

# 2. 主配置：填 7 个 provider 的 api_key，把 <HOME> 替换为实际路径
sed 's|<HOME>|'"$HOME"'|g' home/config.example.yaml > "$HERMES_HOME/config.yaml"
$EDITOR "$HERMES_HOME/config.yaml"   # 填入所有 "<在此填入>"

# 3. 通道路由表（可选，gateway 也会自维护）
cp home/channel_directory.example.json "$HERMES_HOME/channel_directory.json"
$EDITOR "$HERMES_HOME/channel_directory.json"  # 填真实微信 id

# 4. 人格层：从本地备份拷回真身（不进仓，见上节）
#    cp <你的备份>/SOUL.md <你的备份>/agent.json "$HERMES_HOME/"

# 5. profile 分身（按需）：同 2–4 步处理 profiles/second、profiles/secretary-01，
#    并各写一个 profile.yaml（一行 description: "<分身描述>" + description_auto: false）

# 6. bin 脚本：拷入家目录 bin/，脚本内本机路径按新环境核对
mkdir -p "$HERMES_HOME/bin" && cp bin/* "$HERMES_HOME/bin/"

# 7. launchd（macOS，按需）：把 launchd/ 下 plist 拷到 ~/Library/LaunchAgents/，
#    先把里面的本机绝对路径改成本机值；gateway-second 与 gateway.second 只 load 一个
launchctl load ~/Library/LaunchAgents/ai.hermes.gateway.plist
```

## 脱敏口径（本目录全量遵守）

- 真名、手机号、真实微信 id（`@im.wechat`）、`sk-`/各类 api_key：零残留，example 文件一律占位符；
- 本机绝对路径：仅 `launchd/` plist 存档（原样保留、复原时按需改）与 `bin/` 脚本注释/常量级出现；`home/` 下所有模板一律 `<HOME>` 占位；
- 收编前对每个 bin 脚本与配置层文件做过密扫（凭证/人名/手机号/通道 token），结论见 VENDORED.md 与上文排除清单。
