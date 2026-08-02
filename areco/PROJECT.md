# areco 驻场工作纪要

> 多 agent 交接上下文。新条目在最上、带日期。对外说明以 SKILL.md 为准，本文件只放工作过程记录。

## 工作纪要

### 2026-08-01 Hermes：角色统一 + 新建会话固定模板 + 自动保存
- 高律师令：角色统一为 Caller/Thinker/Worker（快速/重活 Worker 退役，重活并入 Thinker=kimi-k3）；新建会话去掉角色模式只留模板；角色设置改完自动保存（删保存按钮）
- 改动（dev 仓 commit）：SpawnDialog.vue 重写为纯模板；SettingsView.vue 角色砍 3 行+@update:value 自动保存+删新建会话模式选项；ui.ts 默认 spawnMode=template 且不再读服务端残留键+删 setSpawnMode；useSpawnWorker.ts HANDOFF_ROLES 砍两档
- 服务端：PUT /api/standcode/defaults 清 fastWorker/heavyWorker+thinker 锚 kimi-k3（写 deploy config.json 即时生效，无需重启）
- **关键教训：8790 服务真身是 StandCode-deploy/areco（部署副本），不是 dev 仓！前端 build 后必须 rsync dist/client 到 deploy 才生效；vite build 须在仓根跑（monorepo）**
- 验收：bundle grep 旧字符串 0 匹配；8790 实测吐新 chunk；config 三向回读一致


### 2026-08-01 kimi 对话模式空白根治：历史恢复必须启动前钉死原生会话 id（Fable5，commit 76ffc87）
- **报障**：kimi 卡片对话模式一直空白。根因链：用户走「历史→kimi→恢复」，api.ts 只传 `extraArgs:['-S',id]` **不传 resumeAgentSessionId**→卡片 agentSessionId=null→kimi `-S` 续写的是旧 wire.jsonl（birth 在本卡启动前 80 分钟）→locate 时间窗认亲（startedAt±60s）永远排除它→transcript 永远 exists:false。日志实锤：locate 每 750ms 双行刷屏「未找到」（ff490705）。
- **修法（commit 76ffc87，3 文件 +40）**：① historyResume kimi/codex 传 `resumeAgentSessionId`，spawn 对非 workbuddy harness 也 `bindAgentSession`（复用重复绑定守卫）；② restart(resume) kimi/codex 从定位文件推出 sid 后回写绑定（否则恢复换 epoch 后同样丢档）；③ codex 附带修：resume 用**同一 session id 回放历史写新 rollout**（磁盘实证 1 id×4 文件），locate 同 id 多文件旧序取最旧=恢复后冻结，改为取最新 + 运行中缓存命中 epoch 前出生文件视为陈旧重扫。
- **验证**：211 测试全过、typecheck 过；staged 内容在临时 worktree 独立编译过（工作区满是并行 WIP，用 `git apply --cached` 选择性提交，**P2-10 退避/harness 字段/ENOENT 降噪等他人未提交 hunk 一律未动**——其中 agent-transcript.ts 有一个我的+P2-10 熔合 hunk 是手拆的）。存量 6 卡（qclaw×2/workbuddy×2/claude×2）transcript API 全部有内容。
- **部署**：deploy 分支 ff 到 76ffc87、deploy 树已 build。因本会话自身跑在 areco pty 里（kickstart=自杀），走 detached 脚本 `data/deploy-restart-verify-20260801.sh`：等全卡空闲（≤30min）→kickstart→API 恢复 kimi 历史会话 session_e433091e（用户被删卡片的原对话）→验证预绑定+transcript 非空，结果写 `data/logs/deploy-verify-20260801.log`。
- **遗留**：reasonix historyResume 走交互 `--resume` 选择器无法预置 id，同样的时间窗洞理论存在；本机无任何 reasonix 会话数据，未盲修。kimi 二进制 08-01 11:42 自更新过，本次空白与其无关（wire 格式未变）。
- **教训**：凡「原生恢复续写旧文件」的 agent（kimi wire 追加、codex 同 id 换文件），绑定都不能靠时间窗事后认亲，必须在 spawn/restart 时把确定性 id 钉进卡片。

### 2026-07-31 设置页重排补记：src 改动实为本会话（Hermes 微信房）所作，已入 git（Hermes）
- **订正上条**：上条称「本轮零改动零提交」是从接力房视角——实际 src 重排（SettingsView.vue 两 patch：Agent 模板 n-card 从 StandCode 默认角色上方移到对话模式下方）由本会话 11:05–11:10 完成并跑 `npm run build`；11:10:59 接力房提交 e8220dd（角色模式 handoff）时把该 hunk 捎带入 git，故工作树==HEAD、无独立 commit。
- **终态验证**（本会话实测）：dist/client SettingsView-CCE1I1b7.js 渲染序 对话模式<Agent 模板<输入诊断；8790 HTTP 拉取 chunk 与磁盘 MD5 一致 = 线上已生效，硬刷可见。
- **教训**：共库并行期 `git status -- <file>` 无 diff ≠ 没改上，先 `git log -1 --format=%ci -- <file>` 查是否刚被别人捎带提交；两个 Hermes 会话同接一条微信指令时，完工后先看 PROJECT.md 是否已有对方条目，补订正不覆盖。

### 2026-07-31 设置页「Agent 模板移到对话模式下方」= 现状已满足（Hermes）
- **经过**：高律师 11:0x 令把 Agent 模板挪到对话模式下面。排查发现 8790 一直在吃**旧 dist**（src 旧树 `areco/web/`，板块顺序 Agent模板在对话模式上）；11:10 并行接力会话从 `packages/client` 重跑 `npm run build`，新产物上线后实页顺序已为 系统→StandCode默认角色→对话模式→**Agent模板**→输入诊断，无需我再改。
- **架构定谳**：areco 前端源码 SoT = `areco/packages/client/`（git 跟踪，e271049 起）；`areco/web/` 旧树 07-31 上午已被移除——**别再读/改 web/，看到即 stale**。构建 = areco 根 `npm run build`（typecheck+vite+build-server），产物 `areco/dist/client`，纯前端硬刷生效无需重启 8790。
- **本轮零改动零提交**（并行会话 WIP 满工作区，不抢 commit）。

### 2026-07-31 「＋新建会话→＋worker」接力验收（Hermes）
- **前情**：codebuddy 会话 f8a03c79（handoff/f8a03c79-….md）实现角色模式下「＋ 新建」按钮直拉 Worker（不弹 SpawnDialog、无 Thinker 选项、不二次确认）；spawnMode 迁入 ui store（服务端 SoT，GET/PUT /api/ui/prefs，跨设备生效）。会话在收尾验证时被打断。
- **本轮验收结论（全绿）**：client vue-tsc ✅、server tsc ✅、vite build ✅（dist 10:50 已上线，硬刷即生效，无需重启 8790）；`/api/ui/prefs` PUT→GET→config.json 三向回读实证（8790 进程 08:18 起已含服务端 SoT）；SettingsView 无残留 spawnMode 本地 ref。
- **未提交，勿抢**：工作区 10:58–11:01 有**并行会话**在同一批文件上加「角色模式 handoff 只给 用 worker 接手」（SessionSidebar/DashboardView/SessionCard/useSpawnWorker/controllers handoff role）。同一功能族仍在施工，commit 留给该会话整体提，避免切碎 + 撞车。外来 WIP（heavyWorker/deleteGroup/pathGroups/删确认弹窗/SpawnDialog 改下拉）与本功能无关，提交时勿混入。
- **改动清单（待提交）**：client api.ts / stores/ui.ts / main.ts / SettingsView.vue（spawnMode 3 hunk，heavyWorker hunk 除外）/ SessionSidebar.vue / DashboardView.vue / composables/useSpawnWorker.ts（新）+ server config.ts ui 白名单 hunk + controllers handoff-role。

### 2026-07-31 小屏导航栏修复（Hermes）
- **问题**：iPhone SE3（375px）顶部导航栏变"两行"——实为 brand+nav 超宽后 flex 压缩 nav-link，CJK 两字标签（会话/任务…）逐字竖排。
- **修法**：`packages/client/src/App.vue` ① .nav-link 加 `white-space:nowrap + flex-shrink:0` ② 新增 ≤520px 媒体查询（header padding 10px、字号 12.5、nav 可横滑兜底）。commit c858881（StandCode 仓）。
- **部署**：`npm run build` 即生效，**无需 kickstart 8790**——koa-static 按请求读盘 + index.html no-store；在线 pty 会话（当时 Fable5 在跑）零中断。
- **验证坑**：Chrome headless `--window-size=375` 实际最小视口 500px，模拟不了 SE3；要小屏真实几何用 CDP `Runtime.evaluate` 量 getBoundingClientRect，或直接要真机截图。
- **调试残留**：调试完记得杀 headless Chrome（当时挂 9222 端口，已杀）。
