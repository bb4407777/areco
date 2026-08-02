---
name: tui-automation
description: 非交互驱动交互式 TUI/CLI（expect 自动打字、面板导航、slash 命令）——当目标工具没有 headless/CLI 参数、只能在终端 UI 里点按时使用。含 Kimi Code CLI 插件安装实例。
---

# TUI Automation（expect 驱动交互式终端程序）

## 何时用
- 目标 CLI 的某个功能只在交互式 TUI 里有（slash 命令、面板、Marketplace），`--help` 没有对应子命令。
- `-p`/headless 模式不拦截 slash 命令（实测 kimi `-p "/plugins …"` 会把命令当 prompt 发给模型并挂起）。
- 需要批量/无人值守完成"打开 TUI → 输命令 → 切 Tab → 按 Enter → 退出"这类固定序列。

## 步骤
1. **先穷尽非交互路径**：`--help`、官方文档、配置文件中可手写的状态文件（如插件的 installed.json）。能写文件就不驱动 TUI；逆 schema 太脆时才上 expect。
2. **定位远端资源**：需要发现 marketplace/catalog URL 时，对二进制跑 `strings <bin> | grep -iE 'marketplace|cdn'`——常量 URL 都躺在里面。
3. **写 expect 脚本**（模板见 `templates/expect-tui-driver.exp`）：
   - 先 `expect` 一个 TUI 就绪标志（状态栏文字），**再**开始打字；启动期打字会被吃掉。
   - 命令逐字符发送、字符间 sleep 0.2，让自动补全稳定；整串一次发容易丢。
   - **提交键因版本而异**：同一程序 0.28.x 用 `"\r"` 提交，升到 0.31.0 后必须 `"\n"`。不灵就两个都试。
   - 面板类操作（Tab 切换、Enter 安装）后 sleep 2-8 秒等渲染；远端列表（marketplace）加载可能 10 秒级。
   - 全程 `log_file` 落盘，事后用 python 剥 ANSI 转义再分析（sed 处理不了日志里的非法字节序列）。
4. **以磁盘状态为准验收**：别信 TUI 画面，看产物文件（如 `~/.kimi-code/plugins/installed.json`、managed 目录）确认真装上了。
5. **功能验证走真实调用**：装完让程序用新能力干一次真活，并核对返回里有没有服务端痕迹（request-id、数据源链接、可核对的原文），排除模型瞎编。

## 坑
- TUI 重绘会偷按键：就绪标志出现后再等 3-5 秒才打字。
- **自动更新改行为**：两次运行之间程序可能自升级，上一轮调好的按键时序下一轮全变——脚本失败先看版本号变没变。
- headless/`-p` 会话可能不加载插件注册的 MCP server——插件"已安装"≠"该会话可用"，须在该会话形态下实测。
- 安装路径下有同名手工解压副本时，agent 可能绕过正式插件直调副本——装完清理临时解压目录。
- 交互式 TUI 工具别用本环境的 terminal(pty=true) 逐键驱动（无法续发按键）；一律 expect 脚本一把跑完。

## 支持文件
- `templates/expect-tui-driver.exp` — 通用 expect 驱动骨架（就绪等待/逐字输入/面板导航/日志）。
- `references/kimi-code-cli.md` — Kimi Code CLI 实例：插件 marketplace URL、installed.json 布局、版本按键差异、元典法律数据源验证记录。
