# CodeGraph 速查（StandCode 专用）

> 一页纸命令卡。配合 `codegraph-tour.md` 使用。
> 工具真身：`/Users/gao/clone/codegraph/`（已 build，零 API 成本，纯本地）。

## 0. 起手式（复制即用）

```bash
CG=/Users/gao/clone/codegraph/dist/bin/codegraph.js
NODE=/Users/gao/.workbuddy/binaries/node/versions/22.22.2/bin/node

# 总仓查询（默认，跨 standcode↔areco）
cd /Users/gao/Code/StandCode

# 只查编排层（caller/hermes，更快）
cd /Users/gao/Code/StandCode/standcode
```

所有命令形如 `$NODE $CG <子命令> [参数] --no-color`（管道/脚本里加 `--no-color`）。

## 1. 两份索引怎么选

| 场景 | 工作目录 | 索引 |
|---|---|---|
| 跨层问题：配置怎么进 areco、resolver、API 接线 | `/Users/gao/Code/StandCode` | 总仓 `.codegraph`（357 文件） |
| Caller 调度、路由、收信箱、Hermes 内部 | `/Users/gao/Code/StandCode/standcode` | 编排层 `standcode/.codegraph`（230 文件） |

## 2. 高频命令

| 目的 | 命令 | 例子 |
|---|---|---|
| 索引健康/规模 | `status` | `$NODE $CG status` |
| 按名字找符号（模糊） | `query <名>` | `query standcodeRoot` |
| 精确看一个符号定义 | `node <名>` | `node route_mode` |
| 谁调用了它（向上追） | `callers <名>` | `callers dispatch_and_relay` |
| 它调用了谁（向下追） | `callees <名>` | `callees dispatch` |
| 改它的影响面 | `impact <名>` | `impact standcodeRoot` |
| 文件树+每文件符号数 | `files` | `files \| head -60` |
| 自然语言找代码（本地启发式） | `explore "<问题>"` | `explore "角色配置如何接入 areco"` |

## 3. 已验证的锚点符号（不知道查什么时从这些入手）

| 符号 | 位置 | 干什么 |
|---|---|---|
| `route_mode` | standcode/caller/caller.py:4575 | think/plan/worker/fast 分诊 |
| `dispatch` | caller.py:2527 | 派单主方法 |
| `poll_result` | caller.py:2955 | 收获 Stand 结果 |
| `dispatch_and_relay` | caller.py:4134 | 派发→收获→回执全流程 |
| `write_inbox` | caller.py:5339 | 收信箱落盘 |
| `standcodeRoot` | areco/packages/server/src/services/standcode-resolver.ts:9 | areco 定位 standcode 真身 |
| `STANDCODE_CALLER` | areco/packages/server/src/controllers/api.ts | areco 侧指向 caller.py |

## 4. 维护（代码变了怎么办）

```bash
# 日常增量（两个根各跑一次，秒级）
cd /Users/gao/Code/StandCode          && $NODE $CG sync
cd /Users/gao/Code/StandCode/standcode && $NODE $CG sync

# 仓库再搬迁 / 大规模收编：重建而不是复用旧库
cd /Users/gao/clone/codegraph
$NODE dist/bin/codegraph.js index /Users/gao/Code/StandCode --no-color
$NODE dist/bin/codegraph.js index /Users/gao/Code/StandCode/standcode --no-color
```

## 5. 坑

- 索引库不入仓：`.gitignore` 已忽略 `.codegraph/` 与 `**/.codegraph/`（共 ~77MB，可随时重建）。
- `index <新根>` 报 "not initialized" → 先 `init <新根>`（init 自带首次索引）。
- 行号随代码漂移，**按符号名查**，别背行号。
- 机器上**没有**装全局 `codegraph` 命令，必须走 `$NODE $CG` 全路径。
