# StandCode 全量代码知识图谱报告（Understand-Anything）

- **日期**: 2026-08-01
- **工具**: Understand-Anything v2.9.4（本地插件，确定性管线，无 LLM 语义层）
- **仓库**: /Users/gao/Code/StandCode @ commit `76ffc87873247d10621911869dd43aca4a6e99bd`
- **执行方式**: 本地 tree-sitter 确定性建图（复用插件自带 scan / import-map / extract-structure / merge / fingerprints 脚本 + core 的 GraphBuilder / detectLayers / generateHeuristicTour / validateGraph），未调用任何付费模型 API，未改动 StandCode 业务代码。

## 一、验收结论

| 验收项 | 结果 |
|---|---|
| ① 报告落盘 | ✅ `/Users/gao/Code/StandCode/standcode/docs/understand-anything-report-20260801.md` |
| ② 看板可用状态 | ✅ 已本地启动验证（Vite dev server，127.0.0.1:5173），数据接口带 token 正常返回，无 token 返回 403，路径穿越防护生效；**验证后已停止服务**（不常驻） |
| ③ 建图实际规模 | ✅ **7029 节点 / 15026 边 / 8 层 / 9 步 tour**（详见下） |

## 二、建图规模

- **扫描**: 428 文件（filteredByIgnore=29，complexity=large）
- **结构分析**: 383 文件成功提取（含 226 python / 91 ts / 27 vue / 22 md / 21 json / 13 js / 7 sh / 6 xml 等）；45 文件无解析器被跳过（主要为 .vue，已按文件节点兜底保留）
- **导入图**: 152 文件有导入，417 条 imports 边（确定性来源）
- **知识图谱**:
  - 节点 7029：`file` 382 / `function` 6339 / `class` 262 / `config` 24 / `document` 22
  - 边 15026：`contains` 6601 / `calls` 7984 / `imports` 417 / `tested_by` 24
  - 层 8：Core / External Services / UI Layer / API Layer / Middleware Layer / Service Layer / Utility Layer / Test Layer
  - Tour 9 步（按拓扑分层引导）
  - schema 校验：通过（validateGraph 成功，auto-correct 仅补齐缺失的 class summary 字段）

## 三、看板

- **启动方式**: fast path（npx release viewer v2.9.4）404 无对应 release 资产 → 按 SKILL 回退流程走 Vite dev server：`GRAPH_DIR=<project> npx vite --host 127.0.0.1`（packages/dashboard 已有 node_modules，无需重装）
- **验证 URL**（已停止服务，仅存档）: `http://127.0.0.1:5173/?token=2e491a96b803eafee5b10d83f464853c`
- 验证结果: `/knowledge-graph.json?token=` 返回完整图（7029/15026/8/9）；无 token 403；`/file-content.json` 正常返回文件内容且拒绝路径穿越（`../../etc/passwd` → "Path must stay inside the project"）
- 若需再次查看：在 `understand-anything-plugin/packages/dashboard` 目录执行 `GRAPH_DIR=/Users/gao/Code/StandCode npx vite --host 127.0.0.1`，从输出抓取带 `?token=` 的 URL

## 四、产物文件

- 知识图谱: `/Users/gao/Code/StandCode/.ua/knowledge-graph.json`（7.6MB，validateGraph 通过后的版本）
- 指纹基线: `/Users/gao/Code/StandCode/.ua/fingerprints.json`（build-fingerprints.mjs 成功后才写 meta.json，防 FULL_UPDATE 升级）
- 元数据: `/Users/gao/Code/StandCode/.ua/meta.json`
- 中间产物: `/Users/gao/Code/StandCode/.ua/intermediate/`（batch-1..25.json、assembled-graph.json、scan-result.json、batches.json 等）
- 批统计: `/Users/gao/Code/StandCode/.ua/tmp/driver-summary.json`

## 五、过程要点与已知说明

1. **确定性管线**（无 LLM）：每批调用 `extract-structure.mjs`（tree-sitter 结构提取）→ 用 core `GraphBuilder` 确定性转 nodes/edges（file/function/class 节点 + contains/imports/calls 边）→ `merge-batch-graphs.py` 合并归一化（去重、tested_by 链接、从 scan-result 恢复 imports 边）→ `detectLayers` + `generateHeuristicTour` 分层与导览 → `validateGraph` 校验。
2. **scan-result.json 补丁**: 原文件缺 `importMap` 字段（该字段是 merge 脚本 imports 恢复步骤的确定性来源），已从 `.ua/tmp/import-map.json` 回填，原文件备份于 `.ua/tmp/scan-result.backup.json`。
3. **Python 版本**: merge 脚本需要 Python 3.10+（`X | None` 语法），系统 `/usr/bin/python3` 是 3.9.6，改用 `/opt/homebrew/bin/python3.13` 执行成功。
4. **.vue 无解析器**: vue 不在语言注册表（是框架配置），45 个 skipped 文件（含 .vue）已兜底建 file 节点并保留 imports 边，保证图中文件完整。
5. **语义摘要缺失**: 确定性模式不给 function/class 写自然语言摘要，validateGraph 对 class 节点自动补齐 summary=name（auto-corrected），不影响图结构与可用性。
6. **git 状态**: 建图期间 StandCode 无业务代码改动；报告仅新增到 docs/。

## 六、未做 / 边界遵守

- ❌ 未调用 freemodel / CC / 任何付费 API key（全流程本地）
- ❌ 未改动 StandCode 业务代码（仅新增 .ua/ 数据目录与 docs/ 报告）
- ✅ 看板验证完即停，无常驻服务
