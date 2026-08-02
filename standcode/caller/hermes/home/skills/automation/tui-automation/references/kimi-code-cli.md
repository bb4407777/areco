# Kimi Code CLI 插件机制与非交互安装实录（2026-07-30）

## 本体
- 二进制：`/Users/gao/.kimi-code/bin/kimi`（当日从 0.28.1 自升级到 0.31.0）。
- 配置/数据家目录：`~/.kimi-code/`（注意：模型自查时容易猜成 `~/.kimi`，不对）。
- 插件只按用户级安装，无项目级；文档站 `https://moonshotai.github.io/kimi-code/`，markdown 版页面在 URL 后加 `.md`（如 `/en/customization/plugins.md`）。

## 关键端点与文件
- 官方 marketplace 目录：`https://code.kimi.com/kimi-code/plugins/marketplace.json`（从二进制 strings 里挖到 `KIMI_CODE_CDN_BASE = "https://code.kimi.com/kimi-code"`）。
- Kimi Datasource 插件（官方，v3.3.0）：源 `./official/kimi-datasource.zip`，即 `https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip`。含 12 个数据源：元典法律 yuandian_law（法规+判例）、天眼查、Wind、IMF、SEC EDGAR、S&P、arXiv、Scholar、stock_finance_data、yahoo_finance、world_bank、gildata。依赖本机 OAuth 登录凭据（`~/.kimi-code/oauth/`），消耗套餐配额。
- 安装落点：
  - 记录：`~/.kimi-code/plugins/installed.json`，形如 `{"version":1,"plugins":[{"id":"kimi-datasource","source":"<zip url>","enabled":true,"version":"3.3.0"}]}`
  - 真身：`~/.kimi-code/plugins/managed/<id>/`，manifest 为 `kimi.plugin.json`，声明 stdio MCP server `node ./bin/kimi-datasource.mjs`。
  - 插件要求 node 在 PATH（本机 `/usr/local/bin/node` v24）。
- 插件变更需 `/reload` 或新会话生效；`/plugins mcp enable|disable <id> <server>` 管 MCP 开关。

## 非交互安装路径（已实证）
`kimi -p "/plugins install …"` 不可行——slash 命令在 -p 模式不被拦截，进程挂起到超时且零落盘。正解是 expect 驱动 TUI（模板见本 skill `templates/expect-tui-driver.exp`）：
`/plugins` 打开管理器 → Tab 切 Official → Enter 装第一项（Kimi Datasource 在 marketplace 排第一，官方源无信任确认弹窗）。

## 版本按键差异（坑）
- 0.28.1：输完命令发 `"\r"` 提交，面板正常打开。
- 0.31.0：`"\r"` 打完命令文本停在输入框不提交；逐字符输入 + sleep 0.2 后发 `"\n"` 才提交。
- 两次运行之间程序可能自升级，上一轮可用的脚本下一轮全废——先核对版本再归因。

## headless 会话的 MCP 注册缺口
`kimi -p` 会话里插件的 `mcp__plugin-kimi-datasource_data__*` 工具未注册（模型实测工具列表为空，绕路用 stdio JSON-RPC 直调 kimi-datasource.mjs 拿数据）。交互式 TUI 会话是否注册当时未及验证（/mcp 可查）。"插件已安装"≠"-p 会话可用"，按会话形态实测。

## 验证记录（元典法律实证）
查询「民法典第107条」经 yuandian_law（`get_data_source_desc` → `call_data_source_tool`，yd_law_search mode=ft_detail，law_name=中华人民共和国民法典，article_number=第一百零七条）返回：
「非法人组织解散的，应当依法进行清算。」现行有效，发布 2020-05-28、实施 2021-01-01，详情链接 ydzk.chineselaw.com（带 request-id），CSV 落盘。条文与法律原文一致=真数据源返回。
元典 API 要点：yd_law_search（semantic/ft_keyword/fg_keyword/ft_detail/fg_detail）与 yd_case_search（semantic/keyword_pt/keyword_qw/detail_pt/detail_qw）；所有调用必传 `file_path`（结果存 CSV 绝对路径）；ft_detail 无 id 时须给 law_name+article_number（中文法条号如「第十五条」）。
