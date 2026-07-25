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
