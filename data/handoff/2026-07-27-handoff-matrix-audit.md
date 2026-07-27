# Areco 接手矩阵审计（2026-07-27）

## 范围

- 看板活会话作为来源：Claude/Fable、Codex、Kimi、WorkBuddy、Qoder、Reasonix、Hermes。
- 历史会话跨 agent 接续：transcript 全文与原 cwd 保真。
- 各启用模板作为目标：首条 handoff prompt 的 argv / TUI 投递能力。

## 已修复

1. WorkBuddy/codebuddy 明确支持 `[prompt]`，改为 argv 投递，避开信任页/首屏吞键盘注入。
2. 历史接续从 chatlog 读取并保留原 cwd；Codex/WorkBuddy 不再落到目标模板默认目录。
3. Reasonix 旧式 `reasonix-stand` 包装器按原生 Reasonix transcript 读取，不再误判无记录。
4. Hermes 旧式 `env HERMES_HOME=... hermes chat` 模板从 `$HERMES_HOME/state.db` 绑定 CLI 会话并读取消息。
5. 移除“只要有 transcriptDir 就假定支持位置 prompt”的错误推断，改按明确 harness/CLI 能力白名单。

## 验证

- 全量测试：173/173。
- 生产构建：typecheck、Vite client、server bundle 均通过。
- 真实只读数据：Qoder 54 条（上一轮）、Reasonix 4 条、Hermes 4 条均能形成交接消息。
- 逐模板 spawn spec：Codex、Claude/Fable、Qoder、WorkBuddy 的 prompt 在最终 argv；Kimi、Reasonix、Hermes 保持 onceQuiet（其 CLI 仅提供会退出的单次 query/run 旗标，不冒充交互首条 prompt）。
- 未重启 8790；部署仍由高律师择时完成。
