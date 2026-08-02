---
name: shared-repo-commit-surgery
description: >
  多 agent 并行共用同一 git 工作区（如 StandCode/areco monorepo）时，只提交自己改动的三段递升技法：
  整文件 add → git apply --cached 按 hunk 选段 → blob 重建法（hash-object + update-index --cacheinfo）
  处理 hunk 内交错。含提交前 git diff --cached 三向核验。
---

# 共库提交外科手术：并行会话工作区里只提自己的改动

## 何时用

多个 agent 会话在同一 git 仓的工作区并行施工（StandCode/areco monorepo 是常态），
`git status` 里混着别人的未提交 WIP。你要提交自己的成果时，**只提交自己动过的 hunk**，
别人的 WIP 原样留在工作区，等其主自己提交（带他们自己的 commit message 与验收）。

铁律：
- 提交前逐文件 `git diff <f> | grep '^@@'` 过一遍 hunk 归属；可疑的看 hunk 内容再归类，
  别凭文件名猜（同一文件常有 2-3 个会话的改动）。
- 绝不 `git add -A` / `git commit -a`。

## 三段递升（能用前一段就不用后一段）

### 段位 1：整文件干净 → 直接 add

文件的全部 hunk 都属于本特性线（含同特性前一会话的接力改动，接力 = 你的）：`git add <f>`。

**坑：pathspec 按 cwd 解析，不按仓根。** 在子目录（如 `areco/`）里跑 `git add areco/packages/...`
会报 `did not match any files`——用相对 cwd 的路径，或先确认 `git rev-parse --show-toplevel`。

### 段位 2：hunk 可分离 → git apply --cached 选段

外来 hunk 与你的 hunk 各自独立（中间隔着未改的行）：`git diff <f> > /tmp/x.patch`，
手工删掉外来 hunk（保留 header 与你要的 hunk），`git apply --cached /tmp/x.patch`。

### 段位 3：hunk 内交错 → blob 重建法

外来改动与你的改动在**同一 hunk 里交错**（如别人删了一个函数，而你在相邻行加import，
两个改动落在同一 @@ 块内）——patch 选段拆不开。此时为每个混合文件重建
「只含你改动」的暂存版本，直接塞进 index：

1. 取基底：HEAD 版本（你的改动是基于 HEAD 的）或工作区版本（外来改动可精确还原时）。
2. 用脚本在内存中应用你的 old→new 替换（就是你自己编辑时用的那组，内容匹配、带唯一性断言），
   或反向还原外来改动（取工作区内容，把外来的几处改回 HEAD 原样）。
3. `git hash-object -w <临时文件>` 拿 blob sha，
   `git update-index --cacheinfo 100644,<sha>,<仓根相对路径>` 入暂存。
   注意 cacheinfo 的路径是**仓根相对**，与 cwd 无关。
4. 工作区文件一个字节都不动——外来 WIP 留在原地。

完整可跑的 Python 配方（含两种重建策略与断言模板）见 `references/git-surgical-staging.md`。

## 提交前三向核验（不可省）

```
git diff --cached --stat          # 文件清单 = 你的特性线
git diff --cached | grep '^@@'    # hunk 逐个对归属
git diff --stat                   # 工作区残留应 = 纯外来改动
git diff --cached | grep -c '<外来特征串>'   # 应为 0
```

确认外来特征串（如被删函数名）在暂存 diff 中出现 0 次，再 commit。

## 善后

- commit message 注明接力关系（如 `(Hermes 接力 codebuddy)`），外来 WIP 的事不在你的 message 里提。
- 若外来 WIP 后来发现是**无主孤儿**（原会话已死），另行向用户汇报处置，不顺手吞并。

## 你的 hunk 被并行会话捎带提交（2026-07-31 实录）

并行施工时你 patch 完、build 完，正要 `git add` 却发现 `git status -- <f>` **干干净净**——
别慌、别重改、更别以为自己没改上：

- **先查是不是刚被别人捎带走了**：`git log -1 --format='%h %ci %s' -- <f>`——最近一次
  提交是几十秒前、且是别会话的特性 commit，再 `git show <sha>:<path> | grep '<你的特征串>'`
  确认内容已在库里。（实录：SettingsView.vue 板块重排两 patch 后，接力会话提交 e8220dd
  「角色模式 handoff」时把该 hunk 一起 commit，工作树==HEAD，`git add` 自然无货可提，
  `git commit` 只吐出整仓 status 长输出——见到这种"commit 输出变 status 长文"也是信号。）
- **工作树 == HEAD 即已安全入库**，不要重复 commit；在汇报与 PROJECT.md 里写明署名实况
  （你的改动被哪个 commit 捎带），方便审计归属。
- **同一条用户指令可能被两个会话同时接走**（微信房 + areco 房各接一份）。完工写 PROJECT.md
  前先读现有条目：已有对方的纪要就**另起一条订正/补充，不覆盖改写别人的条目**——驻场纪要
  是多作者日志，改写他人条目会抹掉对方的视角与证据。

## areco 仓验证口径（2026-07-31 定谳）

- **测试 = `npx tsx --test <文件相对路径>`**（node test runner；仓根 package.json 的
  `test` 脚本即 `tsx --test "packages/**/*.test.ts"`）。**vitest 已装但不可用**——
  workspace root 解析错乱（从 server 包跑会把 root 拼成 `packages/server/packages/client`），
  任何路径过滤都报 `No test files found`，别在它身上烧轮次。
- **patch 工具对 server 侧 TS 文件的 lint 输出全是假错**：它用裸 tsc、不带仓 tsconfig
  （无 esModuleInterop、无 koa 类型），一片 TS1192/TS1259/TS2339/TS2802——真验证以
  仓根 `npm run build` 为准（vue-tsc client + tsc server + vite build 三段，过即过）。

## 关联坑（施工时常同场出现）

- **tsx 跑 /tmp 临时验证脚本：import 必须绝对路径。** ESM 相对导入按脚本自身位置解析，
  不按 cwd——`./packages/...` 会解析到 /tmp 下报 `ERR_MODULE_NOT_FOUND`。
- **常驻服务的部署边界**（以 areco 为例）：纯前端改动 build 即生效（dist 直读、不重启）；
  服务端改动须服务重启——会话内禁自重启（自杀红线），汇报「已改待重启」交用户或会话外 agent；
  重启前新 API 按旧代码报错，汇报时主动写明，免得用户当成 bug。
  **areco 前端具体口径（2026-07-31 定谳）**：源码 SoT = `areco/packages/client/`（旧 `areco/web/`
  树已删，搜到 web/ 内容即 stale）；构建 = areco 根 `npm run build`，产物 `areco/dist/client`。
  vite 代码分包——路由级组件在独立 chunk（如 `assets/js/SettingsView-*.js`），首页 loader chunk
  grep 不到路由页字符串是正常的；CLI 核验用 `grep -l '<特征串>' areco/dist/client/assets/js/*.js`
  定位 chunk 再 `curl -s --compressed http://127.0.0.1:8790/assets/js/<chunk>` 核内容。
  浏览器核验走 hash 路由 `http://127.0.0.1:8790/#/<route>`（裸路径被重定向回首页）；
  勿用 browser_console 跑 `location.reload()`——会把 tab 干成 about:blank，要刷新就重新 navigate。

## 同功能撞车：活跃 sibling 在施工同一特性（2026-07-31 handoff 四档实录）

区别于「断手/热手 WIP 是别人的另一件事」——本场是**同一用户指令被两个会话同时接走，
对方已在同几个文件写了同一功能的半成品**。处理法不是绕开也不是推倒，是收编：

- **patch 工具的 `_warning: <文件> was modified by sibling subagent '<id>' at HH:MM:SS`
  是正式信号，不是噪音。** 出现后第一步不是继续 patch，而是 `git diff <f>` 查对方改了
  什么、与自己的特性线是否同一件事。（实录：patch api.ts 时收到警告，diff 发现对方已加了
  我正需要的 StandCodeRole import——白捡，不冲突。）
- **patch 模糊匹配会在 sibling 改过的文本上报"成功"，但 diff 里出现你没写的名字**
  （实录：useSpawnWorker.ts patch 后 diff 显示对方写的 `handoffWithRole`/`HANDOFF_ROLES`
  雏形）。成功提示后务必看一眼返回的 diff；发现陌生标识符 = 文件里有对方的活，先 read 全
  文件摸清现状再决定下一步，别在想象的老版本上继续叠 patch。
- **收编三原则**：①保留对方已写的好件（如模块级导出的常量表，正是防两处漂移的正确形态）；
  ②统一命名与函数签名（只留下一个入口，如 `handoffRole(id, role, label)`），把对方起的
  别名收敛掉；③全仓搜旧名的所有调用点一并修齐（`grep 旧函数名` 清零才算完）。
- **验收与署名照旧**：typecheck/build/测试全绿后只提交特性线文件；commit message 与汇报里
  注明「收编了 <sibling 会话id> 的半成品 WIP」，归属可审计。
- **判定顺序**：先按「热手 WIP」条验 mtime 与活跃性——对方若几十秒内还在动且改的是**另一
  件事**，绕开不替写；只有确认是**同一特性**才收编，收编后自己成为该特性的唯一施工者。

## 并行工作区里的编辑安全（2026-07-31 错位毁文实录）

提交要防吞别人的 WIP，**编辑同样要防踩别人的并发写**：

- **patch 工具的模糊匹配不保证落在你读过的版本上。** old_string 基于 read 时的内容，
  若 read 与 patch 之间隔了多轮工具调用、期间另一会话改写了同一文件，patch 仍可能报"成功"
  但落在错位处（实录：SettingsView.vue 被并行会话重排后，patch 把「输入诊断」卡头错改成
  「StandCode 默认角色」，靠 `git checkout -- <f>` 还原）。**read 与 patch 之间隔了 3+ 轮
  工具调用、或目标是并行施工热点文件时，patch 前先重读目标区段或 `git status --short -- <f>`
  确认未变。**
- **动手前先查 HEAD 有没有刚动过。** 并行会话可能秒级提交（`git log --oneline -3`），
  你读到的源码快照可能已是旧版；更隐蔽的情况是**你要做的改动别人刚做完**——dist 构建产物
  或线上 DOM 与源码看似矛盾时，先对新提交做 `git show --stat`，别急着编辑。
- **文件工具与 terminal 视图矛盾 ≠ 两套文件系统/沙盒。** read_file/search_files 读得到、
  terminal `ls` 说没有（或反之），先别臆断隔离/挂载——`ps aux | grep -E 'vite build|npm|claude'`
  看有无并行会话正在构建/重构，配合 `git log --oneline -3`：多半是接力会话刚落了目录迁移
  （2026-07-31 实录：areco `web/`→`packages/client` 迁移在任务中途发生，先读到的 web/ 树
  十几分钟后消失，旧读取结果全部变 stale）。快速证伪"两套 FS"用探针法：write_file 写个
  标记文件再 terminal `cat`，能读到即同一文件系统，矛盾来自时间差而非空间差。
- **patch 失败/落点可疑后的恢复**：工作区该文件若原本干净（已提交），`git checkout -- <f>`
  直接回到 HEAD 版本，比手工反 patch 可靠；若有别人的未提交 WIP 混入则禁用此招，
  改用 `git diff` 逐 hunk 甄别。
- **typecheck 报你没写过的名字 = 别人的活 WIP，先验 mtime 再定性。** 整仓 `npm run build`
  卡在 `Cannot find name 'XXX'`（你没写过这个名字）时，八成是另一会话正在同一文件里
  施工到一半（控制器引用了还没写的 helper）。`stat -f %Sm <文件>` mtime 是几十秒前 = 活人；
  此时**不替它补完、不修它**（它的主会接着写），把自己的验证降级到不含该文件的范围
  （如 client-only `vue-tsc -p packages/client/...` + `vite build`），只提交自己的文件，
  汇报里点名「X 文件有他人进行中 WIP」。（2026-07-31 实录：codebuddy 在 api.ts 做 8020
  对齐改造留下 isLocalBrowserRequest/FINDER_OPEN_SCRIPT 未定义，mtime 22 秒前，绕开。）
- **断手 WIP 与热手 WIP 分开判：编译挂 + mtime 分钟级无活动 + 正好是本任务缺失的另一半
  = 接管收尾。** 上条的「绕开」只适用于几十秒内的热手 WIP；若 mtime 已 10 分钟级无活动、
  改动留编译错误（如引用了没 import 的类型）、内容正是你任务的服务端/客户端另一半，
  等它自愈会堵死你的交付（2026-07-31 实录：api.ts 的 handoff 四档 role 扩展缺
  StandCodeRole import 编译挂，前端四档菜单依赖它，原会话 10 分钟未动）——补上缺口、
  整树 build 验证、一并提交，commit message 注明接力关系。接管前先 `git status --short`
  + areco 看板扫一眼有无同题施工会话，确认无活跃撞车再动手。
- **改完共享仓前端要 build 时**：工作区混着别人 WIP 不代表不能 build——若当前服役 dist
  本就是含 WIP 构建的（对比 dist 里特征串与 HEAD 可知），含 WIP 重建是现状延续而非新风险；
  但 typecheck 可能被别人半成品卡住，此时只跑 `npx vite build` 跳过类型检查并在汇报里注明。
