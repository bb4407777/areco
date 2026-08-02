---
name: loopback-web-services
description: >
  本机多个 loopback web 服务（skill-server 8020 / areco 8790 / gateway 8642…）并存时，
  web UI 需要触发宿主机动作（打开文件/文件夹）的复用与集成技法：
  优先复用 8020 常驻 /open 而非各服务各加端点；浏览器跨端口调用的
  CORS/simple-request/no-cors 约束；「原生端点→常驻服务→降级」回退链模式。
---

# loopback web 服务互用：宿主机动作（打开文件）集成

## 何时用

本机某个 web 面板/座舱（areco、caselist、自建面板…）要让用户**点击就在 macOS 上打开
文件/文件夹**（Finder、默认 App），或更一般地：一个 loopback 服务的页面要调用另一个
loopback 服务的本机动作端点。

## 首选：复用 8020 skill-server 的 /open（已在跑的常驻服务）

`http://127.0.0.1:8020/open`（`/Users/gao/skills/skill-server/server.py`，launchd 常驻）：

- **GET `/open?path=<abs>`** 与 **POST `/open`（JSON `{"path": …}`，Content-Type 必须
  application/json，否则 415）** 两种形态；POST 是首选口径（路径不进 URL/访问日志）。
- **白名单**：realpath + expanduser 后必须已存在、且落在 `~/Desktop`、`~/skills`、`~/Code`
  三根之一（commonpath 判定，软链逃逸落空）→ 403。areco 产物
  （`/Users/gao/Code/StandCode/areco/data/uploads`）与案件文件夹（Desktop）都在其中。
- **打开方式**：osascript `tell application "Finder" activate + open`，**路径走 argv
  不拼 AppleScript 源码**（防引号/换行注入）；文件=默认 App 打开，文件夹=Finder 窗口。
- **来源闸** `_local_browser_request`：Host 须 loopback；`Sec-Fetch-Site` 只放行
  `''`/`same-origin`/`same-site`/`none`；Origin/Referer 的 host 须 loopback。
  **同一 IP 不同端口 = same-site**，所以 8790 页面调 8020 能过闸。

复用的价值：新功能**当下就能用**，绕过「服务端新端点要常驻服务重启才生效、会话内又禁
重启」的死锁（2026-07-31 areco 文件点击功能即靠它提前解锁）。

## 浏览器跨 loopback 端口调用的硬约束

- **POST + `Content-Type: application/json` 会触发 CORS 预检（OPTIONS）**——简单 Python
  服务不处理 OPTIONS → 被浏览器直接卡死。跨端口想用 POST JSON，服务端必须自己处理
  预检并回 ACAO 头（8020 没有）。
- **GET 是 simple request，免预检**。配 `fetch(url, {mode:'no-cors'})` 可盲发：
  服务端正常执行动作，但**响应不透明读不到**（成功/403 都 resolve）。
- 因为读不到结果，**前端必须先自查对方白名单**（把 8020 三前缀常量抄在前端，路径
  不在前缀内就不发、直接走降级），否则白名单外路径会「静默成功」什么都没开。
- 仅当本页 hostname 是 `127.0.0.1`/`localhost` 才发——局域网访问时页面里的
  `127.0.0.1` 指错机器。

## 回退链模式（服务端新端点 vs 现成常驻服务）

新功能原生端点已提交但服务未重启时，点击链分三级（2026-07-31 areco ArtifactsBar 实例）：

1. 试原生端点（如 `POST /api/files/open`）——服务重启升级后命中，长期正道；
2. 404/失败 → no-cors 盲发 8020 `GET /open?path=`（先过前端白名单自查 + loopback 页闸）；
3. 也不可用 → 降级到产品原有体验（内部预览），绝不让用户「点了没反应」。

## 验证前端改动：curl 服役包，别看浏览器/磁盘

用户报「页面板块/文案没变」要动手改代码前，先实证**正在跑的服务实际吐的是什么**——三层可能互相打架：浏览器缓存旧包、磁盘 dist 被另一个 agent 刚 rebuild、跑着的进程从另一个目录读静态文件。实证手法（2026-07-31 areco 8790 实例）：

1. `curl -s http://127.0.0.1:<port>/` 从 index.html 拿入口 JS 名（`index-<hash>.js`）；
2. curl 入口 JS，grep 出目标页面的 chunk 名（如 `SettingsView-<hash>.js`）；
3. curl 该 chunk，用 `str.find('板块文案')` 比对各关键文案的偏移，即得**线上真实**板块顺序/文案。

核 naive-ui 卡片**顺序**时注意：卡片表头有两种写法——`<n-card title="系统">` 属性式 与
`<template #header>X</template>` 插槽式，按单一模式 grep/regex 会漏卡（2026-07-31 实录：
「系统」卡用 title 属性，regex 只匹配 #header 形式漏掉它，顺序核验误报 FAIL，白跑一轮）。
两种模式都匹配（如 `<n-card title="([^"]+)"|<template #header>([^<]+)</template>`）再按偏移排序。

hash 变化即说明服役包已换；用户端仍见旧版 = 浏览器缓存，让其强制刷新（Cmd+Shift+R）即可，零改动结案。静态前端是按请求从磁盘读的——**纯前端改动（板块顺序/文案/样式）rebuild 即生效，不需要重启常驻服务**（也绕开会话内禁重启死锁）；只有服务端代码改动才要重启。

实证发现**用户的字面要求其实已满足**时（如"把 A 放 B 上方"而 A 本就在 B 上方），别急着结案也别急着改——用户的锚点很可能记错或看了缓存页：回报**完整的现状顺序**（不只用户点名的两个板块）并请其指明目标位（2026-07-31 实录：用户说"Agent 模板放输入诊断上方"——本就在上方；报全序后用户澄清真实意图是"放对话模式下面"，一句话避免往返猜测）。

## 自建端点时的对齐清单（若确需新端点而非复用）

- POST JSON 收路径；路径 argv 传给 `open`/`osascript`，禁字符串拼接进 shell/AppleScript；
- realpath + 白名单根前缀判定（复用现有 FileService.resolve 一类边界，不新造口径）；
- loopback/来源闸（Host + Sec-Fetch-Site + Origin/Referer）防 DNS-rebinding/外站 CSRF；
- timeout 10s；失败回 500 让前端走降级。
