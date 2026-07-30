#!/usr/bin/env python3
"""hermes-charter-sync — 生成 Hermes 路由器版章程镜像（2026-07-26，Fable5，管理者批"全部落地"）

原理（沿 qclaw AGENTS.md 镜像先例）：vault CLAUDE.md 是全体 agent 章程的唯一真身，
**本脚本绝不改它**；只为 Hermes（纯路由器角色）生成裁剪镜像写到
~/.qclaw-hermes/workspace/CLAUDE.md（context loader 每轮加载的落点），
每日 cron 单向覆盖，章程更新自动跟进，镜像永不写穿回真身。

裁剪口径（宁保守勿激进）：
  保留全文：硬红线 / 路由表 / 数据 SoT / 禁用退役清单 / 路径表
  保留细则：案卷检索（Hermes 查飞书 Base 定位案件要用）/ lark-cli 路径（含 Hermes 专属段）
  裁掉细则：opencli 三步 / 外部资源存档 / 代码仓库与 skill 布局 / vault 版本管理
    ——这四节是执行层操作规程，Hermes 命中即派 Worker，Worker 侧读全量章程。
  被裁节在镜像里留一行指针，Hermes 需要时可 cat 真身。

回滚 = 删镜像文件并恢复软链：
  rm ~/.qclaw-hermes/workspace/CLAUDE.md && ln -s "<vault>/CLAUDE.md" ~/.qclaw-hermes/workspace/CLAUDE.md
"""

import os
import sys
import time

VAULT = ("/Users/gao/Library/Mobile Documents/iCloud~md~obsidian/"
         "Documents/claude-obsidian/CLAUDE.md")
TARGET = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))),
                      "workspace", "CLAUDE.md")

# 三级细则(### )中要裁掉的节名前缀
DROP_H3 = ("opencli 网页操作三步", "外部资源存档", "代码仓库与 skill 布局", "vault 版本管理")

MACHINE_HEADER = """<!-- 机器生成：Hermes 路由器版章程镜像，勿手改本文件 -->
<!-- 真身: vault CLAUDE.md（全体 agent 章程）；本镜像由 hermes-charter-sync.py 每日单向覆盖 -->
<!-- 裁剪: opencli三步/外部存档/代码仓库布局/vault版本管理 —— 执行层细则，命中即派 Worker，Worker 读全量章程 -->
<!-- 同步时间: {ts} -->

"""

POINTER = ("\n### （已裁四节：opencli 三步 / 外部资源存档 / 代码仓库布局 / vault 版本管理）\n"
           "路由器不亲手干这些活——命中即派 Worker；细则见完整章程"
           "（vault CLAUDE.md，需要时 cat 真身）。\n")


def build(src: str) -> str:
    out, drop = [], False
    pointer_emitted = False
    for line in src.splitlines(keepends=True):
        if line.startswith("### "):
            title = line[4:].strip()
            drop = any(title.startswith(d) for d in DROP_H3)
            if drop and not pointer_emitted:
                out.append(POINTER)
                pointer_emitted = True
            if drop:
                continue
        elif line.startswith("## ") or line.startswith("# "):
            drop = False
        if not drop:
            out.append(line)
    return MACHINE_HEADER.format(ts=time.strftime("%Y-%m-%d %H:%M:%S")) + "".join(out)


def main() -> int:
    if not os.path.exists(VAULT):
        print(f"❌ 真身不存在，拒绝动镜像: {VAULT}", file=sys.stderr)
        return 1
    src = open(VAULT, encoding="utf-8").read()
    if len(src) < 5000:
        # iCloud 抽风/半写状态防护：真身异常小就当损坏，保住现有镜像
        print(f"❌ 真身仅 {len(src)} 字节（<5000），疑似损坏，拒绝同步", file=sys.stderr)
        return 1
    mirror = build(src)
    # 首跑：落点还是软链 → 记录原指向后替换为真文件
    if os.path.islink(TARGET):
        orig = os.readlink(TARGET)
        with open(TARGET + ".was-symlink.txt", "w", encoding="utf-8") as f:
            f.write(f"原软链指向: {orig}\n替换时间: {time.strftime('%F %T')}\n"
                    f"回滚: rm CLAUDE.md && ln -s '{orig}' CLAUDE.md\n")
        os.remove(TARGET)  # 只删软链本身，真身不动
    elif os.path.exists(TARGET):
        old = open(TARGET, encoding="utf-8").read()
        # 幂等：正文未变（忽略时间戳行）则不写
        strip = lambda t: "\n".join(l for l in t.splitlines() if "同步时间" not in l)
        if strip(old) == strip(mirror):
            print(f"镜像未变（{len(mirror)} 字节），跳过写入")
            return 0
    tmp = TARGET + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(mirror)
    os.replace(tmp, TARGET)
    print(f"✓ 镜像已更新: {len(src)} → {len(mirror)} 字节（省 {len(src)-len(mirror)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
