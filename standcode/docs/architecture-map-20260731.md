# StandCode × areco 架构图（2026-07-31，基于总仓 CodeGraph 索引）

> 依据：`/Users/gao/Code/StandCode/.codegraph`（357 文件 / 10,526 节点 / 33,193 边）实测符号绘制。
> 图中每个节点都能在索引里查到（符号名见 `codegraph-cheatsheet.md` 第 3 节）。
> Mermaid 源码，GitHub/VSCode/Obsidian 直接渲染。

## 1. 全景：三层 + 底座

```mermaid
flowchart TB
    subgraph 入口层["入口层（微信/CLI）"]
        Hermes["Hermes 常驻入口<br/>standcode/caller/hermes/<br/>hermes_cli/main.py（15,321 行）"]
        CLI["standcode CLI<br/>bin/standcode.js → caller.py"]
    end

    subgraph 编排层["编排层 standcode/"]
        Caller["caller.py（8,592 行）<br/>check_should_dispatch → route_mode<br/>→ dispatch → poll_result → write_inbox"]
        Config["config/<br/>harnesses / providers / presets"]
        Registry["stand/registry.json<br/>角色模板映射"]
        Inbox["data/inbox/<br/>任务结果收信箱"]
    end

    subgraph 底座层["底座层 areco/（127.0.0.1:8790）"]
        API["packages/server<br/>controllers/api.ts（STANDCODE_CALLER）"]
        Resolver["services/standcode-resolver.ts<br/>standcodeRoot() 解析角色/harness/model"]
        Rooms["services/rooms.ts + projects.db<br/>项目房间/成员/消息"]
        SM["services/session-manager.ts<br/>拉起/承载真实 CLI 会话（PTY）"]
        WS["ws/gateway.ts<br/>attach/detach/resize"]
        Board["packages/client（Vue 3）<br/>网页看板"]
    end

    Stands["真实 Stand 会话<br/>Claude Code / Kimi / DeepSeek / QClaw …"]

    Hermes --> Caller
    CLI --> Caller
    Caller -->|读配置| Config
    Caller -->|读模板| Registry
    Caller -->|REST 建房+投递| API
    API --> Resolver
    Resolver -->|standcodeRoot 定位真身| Registry
    API --> Rooms
    Rooms --> SM
    SM --> Stands
    WS <-->|终端流| SM
    Board <-->|HTTP/WS| API
    Stands -->|房间消息| Rooms
    Caller -->|poll_result 按水位线收获| Rooms
    Caller -->|write_inbox 落盘| Inbox
    Inbox -->|Caller 醒来拉取+回执微信| Hermes
```

## 2. 一次派单的时序（主链路）

```mermaid
sequenceDiagram
    participant U as 高律师（微信）
    participant H as Hermes（Caller 宿主）
    participant C as caller.py
    participant A as areco server（8790）
    participant S as Stand 会话
    participant I as data/inbox/

    U->>H: 派活消息
    H->>C: caller.py run --wait …
    C->>C: check_should_dispatch（硬闸）<br/>route_mode（think/plan/worker/fast）
    C->>A: REST：建房/复用会话 + 投递任务
    A->>A: standcode-resolver 解析角色/harness/model
    A->>S: session-manager 拉起 PTY 会话
    S-->>A: 执行过程/结果落房间消息库（看板可见）
    C->>A: poll_result（消息水位线 + Stand 身份过滤）
    A-->>C: 结果消息
    C->>C: verify_completion / gate_result（验收闸）
    C->>I: write_inbox(task_id.json)
    C-->>H: --wait 返回
    H->>I: 瞄收信箱（拉模式，无轮询推送）
    H->>U: 微信汇报 + mv .done
```

## 3. 跨层接线（总仓索引实测，搬仓后仍有效）

| 接线点 | 符号 | 位置 |
|---|---|---|
| areco 定位 standcode 真身 | `standcodeRoot()` | areco/packages/server/src/services/standcode-resolver.ts:9 |
| 角色注册表路径 | `STAND_REGISTRY_PATH` | 同文件 :267 → standcode/stand/registry.json |
| 配置目录 | `STANDCODE_CONFIG_DIR` | 同文件 → standcode/config/ |
| areco 侧 Caller 路径 | `STANDCODE_CALLER` | areco/packages/server/src/controllers/api.ts → standcode/caller/caller.py |
| 会话承载 | `SessionManager` | areco/packages/server/src/services/session-manager.ts |
| 房间↔会话中继 | `room-relay.ts` | areco/packages/server/src/services/room-relay.ts:14 |
| 终端 WS 网关 | `attach/detach/resize` | areco/packages/server/src/ws/gateway.ts:232/298 |

## 4. 规模与语言（2026-07-31 索引实测）

| 层 | 索引 | 文件 | 节点 | 边 |
|---|---|---:|---:|---:|
| 编排层 | standcode/.codegraph | 230 | 7,627 | 23,778 |
| 总仓 | .codegraph | 357 | 10,526 | 33,193 |

总仓语言分布：Python 226 / TypeScript 90 / Vue 27 / JavaScript 11 / YAML 3。

## 5. 边界声明

本图是 CodeGraph 本地确定性索引的**结构化视图**（符号、调用、配置链均实测可查），
不是 LLM 生成的交互式图形看板。Understand-Anything / Graphify 看板未运行（成本待高律师确认）。
