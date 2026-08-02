# Blob 重建法完整配方（git hash-object + update-index --cacheinfo）

来源：2026-07-31 StandCode/areco monorepo，commit e8220dd。场景：并行会话的外来 WIP
（删 `confirmRemove` 确认弹窗）与本轮特性改动在 SessionSidebar.vue / DashboardView.vue
的同一批 hunk 里交错，`git apply --cached` 选段拆不开。

## 适用判定

`git diff <f>` 的某个 @@ 块里同时出现「你的 +/- 行」和「外来的 +/- 行」，且它们
相距不足 context 行数（默认 3 行）无法劈成两个 hunk → 段位 3。

## 策略 A：HEAD + 正向应用你的改动（推荐，改动少时）

适用于你能精确列出自己的每一处 old→new（通常就是你编辑文件时用的那组替换）：

```python
import subprocess, tempfile, os

REPO = "/path/to/repo"          # 工作目录（可以是仓内子目录）
ROOT_REL = "areco/packages/server/src/controllers/api.ts"  # 仓根相对路径！

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=REPO)

head = sh(f"git show HEAD:{ROOT_REL}").stdout          # 基底 = HEAD

def must_replace(text, old, new, count=1):
    assert text.count(old) == count, f"pattern {text.count(old)}x (expected {count}): {old[:80]!r}"
    return text.replace(old, new)

staged = must_replace(head, OLD_1, NEW_1)              # 逐个应用你的改动
staged = must_replace(staged, OLD_2, NEW_2)

with tempfile.NamedTemporaryFile('w', delete=False) as f:
    f.write(staged); tmp = f.name
sha = sh(f"git hash-object -w {tmp}").stdout.strip()
os.unlink(tmp)
r = sh(f"git update-index --cacheinfo 100644,{sha},{ROOT_REL}")
assert r.returncode == 0, r.stderr
```

要点：
- `must_replace` 的 count 断言不可省——替换串匹配 0 次或多次都必须当场炸，
  否则你会提交一个静默缺改动的版本。
- cacheinfo 的路径是**仓根相对**（与 cwd 无关）；`git add` 的 pathspec 才是 cwd 相对。

## 策略 B：工作区 − 反向还原外来改动（外来改动少而明确时）

适用于外来 WIP 是少量、可精确枚举的删除/替换（如删了一个函数 + 改了 import 行）：

```python
wt = open(os.path.join(REPO, "packages/client/src/components/SessionSidebar.vue")).read()
# 把外来改动逐一改回 HEAD 原样（内容取自 git show HEAD:<path> 对照）
wt = must_replace(wt,
    "import { NButton, NDropdown, useMessage } from 'naive-ui'",
    "import { NButton, NDropdown, useDialog, useMessage } from 'naive-ui'")   # 还原 import
wt = must_replace(wt,
    "function onMenu(key: string, s: SessionSummary) {",
    FOREIGN_ORIGINAL_FUNCTION + "\n\nfunction onMenu(key: string, s: SessionSummary) {")  # 还原被删函数
# …全部还原后，同策略 A 的 hash-object + update-index 入暂存
```

还原清单务必与 `git diff` 中的外来 hunk 一一对应，漏一处 = 外来改动混进你的提交。

## 三向核验（两种策略都要跑）

```bash
git diff --cached --stat                          # 文件清单 = 你的特性线
git diff --cached -- <mixed-file> | grep '^@@'    # 混合文件暂存 hunk 逐个对归属
git diff --cached | grep -c '<外来特征串>'          # 必须 0（如被删的 confirmRemove）
git diff --stat                                   # 工作区残留 = 纯外来改动（留给其主）
```

工作区文件全程未动——外来 WIP 原样留在工作区，`git status` 里它们仍显示为未暂存修改，
其主会话之后可以正常 add/commit，互不干扰。

## 已知坑

- `git add` pathspec 按 cwd 解析：在 `areco/` 子目录里 `git add areco/packages/...` 报
  `did not match any files`；先 `git rev-parse --show-toplevel` 确认仓根，或统一用 cwd 相对路径。
- 本例同时踩到：`git commit` 在子目录跑没问题（git 自动找仓根），但 update-index 的
  cacheinfo 路径写错会在 index 里造出一个幽灵路径条目——核验时 `git diff --cached --stat`
  发现陌生路径要立刻 `git reset` 重来。
