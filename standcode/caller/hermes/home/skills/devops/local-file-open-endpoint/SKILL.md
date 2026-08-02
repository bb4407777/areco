---
name: local-file-open-endpoint
description: >
  给本机 launchd 常驻 localhost 服务（skill-server 8020、areco 8790、本机面板等）加
  「浏览器点一下 → macOS 系统默认 App/Finder 打开本机文件或文件夹」类副作用端点时的
  权威实现模式：realpath 白名单 + loopback 来源闸（防 CSRF/DNS-rebinding）+
  osascript Finder activate+open（argv 传路径）。含桌面/手机分端与验证要点。
---

# 本机常驻服务「系统打开文件」端点模式

## 触发

- 给任何跑在 launchd 下的 localhost 服务加「系统打开本机文件/文件夹」「在 Finder 中显示」类端点。
- 前端要做「桌面端系统打开、手机端内部预览」的分端点击行为。

## 铁律：先对照本机实证实现，别从零发明（2026-07-31 高律师指点）

给本机服务加副作用端点前，先找本机已有实证实现对照。权威参考 =
`/Users/gao/skills/skill-server/server.py` 的 `POST /open`（caselist「打开文件夹」按钮，
launchd `com.skill-server` 常驻实证可用）。对照清单：白名单口径、CSRF 闸、调起方式、注入防护。
（教训来源：areco 初版用裸 `spawn('open')` 且无来源闸，高律师一句「看下 8020 怎样做到的」点醒。）

## 三件套（照 8020 口径）

1. **路径白名单**：realpath + expanduser + 存在性校验 + commonpath 判根内
   （8020 只放 Desktop/skills/Code 三根；服务若已有自己的文件服务边界——如 areco
   `FileService.resolve`——复用既有边界保持同口径，realpath 挡软链逃逸）。
2. **loopback 来源闸**（防外站对 loopback 的 CSRF/DNS-rebinding，同 8020
   `_local_browser_request`）：① Host 必须 127.0.0.1/localhost/::1；② `Sec-Fetch-Site`
   只接受 空/same-origin/same-site/none；③ Origin/Referer 若存在其 hostname 必须
   loopback，解析失败即拒。**一律 POST 不接受 GET**（参数不进 URL/访问日志，也防
   `<img>` 盲打）。
3. **osascript 唤起 Finder**（不是裸 `open`——activate 把窗口带前台，launchd 常驻实证可用）：

```
on run argv
set targetPath to item 1 of argv
set targetFile to POSIX file targetPath
tell application "Finder"
  activate
  open targetFile
end tell
end run
```

   调用形态 `osascript -e <script> -- <absPath>`：路径走 argv，**禁止拼进脚本源码**
   （引号/换行注入）。超时 10s，按退出码判成败，失败让前端回退。

## 前端分端（areco 实证）

- 桌面端点击 → POST 打开端点，系统默认 App 打开；**open 失败（含服务未重启 404）必须
  自动回退内部预览**，不能点了没反应。
- 手机端保持应用内预览（系统打开在移动端无意义）。

## 验证要点（ad-hoc，非测试套件）

- 闸逻辑：抽源码真函数（TS 用 esbuild.transform 剥标注后 new Function eval）喂 mock
  请求跑正反用例：loopback 无 Origin 过 / 同源 Origin 过 / 外站 Origin 拒 / 外站 Host 拒 /
  Sec-Fetch-Site cross-site 拒 / 畸形 Origin 拒。
- 调起：真跑 `osascript -e <script> -- <无害临时目录>` 看退出码 0。
- 构建产物 grep 行为标记（路由路径、osascript、sec-fetch-site、forbidden origin）。
- 活进程 HTTP e2e 只能等常驻服务重启后点验——**会话内禁自杀式重启自己跑在其中的服务**
  （章程硬红线）；未重启期间前端必须有 404 回退路径。

## 已落地实例

- skill-server 8020 `POST /open`（参考真身，函数 `_safe_open_target` /
  `_local_browser_request` / `_open_in_finder`）。
- areco 8790 `POST /api/files/open`（commit 89fe708 初版 + 6468435 对齐 8020 加固；
  对话页「📦 成果」改「📦 文件」，桌面系统打开/手机内部预览/失败回退预览）。
