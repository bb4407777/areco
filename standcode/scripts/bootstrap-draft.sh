#!/usr/bin/env bash
# bootstrap-draft.sh — StandCode 一键部署骨架（DRAFT，未联调）
#
# 设计出处：/Users/gao/Desktop/头脑风暴/Windows组网两案并评-20260729.md §11
# 三条铁律：
#   1. 幂等可重跑：每步先探后做，重跑 N 次结果一致；
#   2. 凭证不入库：本脚本不接受/不打印/不写入任何 key/token/密码，
#      只探测「缺哪些」并打印人工注入指引；
#   3. DRY-RUN 默认：默认只打印将执行的动作，显式 --apply 才真动手。
#      服务注册段（S5）在 draft 阶段即使 --apply 也只打印模板。
#
# 用法：  ./bootstrap-draft.sh [--apply] [--repo-dir DIR] [--standcode-home DIR]
# 平台：  macOS / Linux / WSL2 / Windows-Git-Bash（Git for Windows 自带；
#         schtasks/winget 段通过 cmd //c 转调）

set -u
APPLY=0
REPO_DIR="${HOME}/Code/StandCode"
STANDCODE_HOME="${HOME}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --repo-dir) shift; REPO_DIR="${1:?--repo-dir 需要参数}" ;;
    --standcode-home) shift; STANDCODE_HOME="${1:?--standcode-home 需要参数}" ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── 平台探测 ────────────────────────────────────────────────
uname_s="$(uname -s 2>/dev/null || echo unknown)"
case "$uname_s" in
  Darwin)            PLATFORM=darwin ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl2; else PLATFORM=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=gitbash ;;
  *)                 PLATFORM=unknown ;;
esac

# ── 输出助手 ────────────────────────────────────────────────
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
# do_ <幂等判据描述> <命令...>：DRY-RUN 只打印；--apply 才执行
do_() {
  desc="$1"; shift
  if [ "$APPLY" -eq 1 ]; then
    say "  [RUN] $desc"
    "$@"
  else
    say "  [DRY] $desc"
    say "        \$ $*"
  fi
}

say "StandCode bootstrap（DRAFT）  platform=$PLATFORM  apply=$APPLY"
say "repo=$REPO_DIR  standcode_home=$STANDCODE_HOME"

# ── S1 clone / 更新主仓 ─────────────────────────────────────
step "S1 clone/更新 areco 主仓"
REPO_URL="https://github.com/gaochengbin/areco.git"   # TODO 联调时核对真实远端
if [ -d "$REPO_DIR/.git" ]; then
  if [ -z "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
    do_ "仓库已存在且工作区干净 → fetch + ff-only" \
        git -C "$REPO_DIR" fetch --all
    do_ "快进合并（不覆盖 WIP）" \
        git -C "$REPO_DIR" pull --ff-only
  else
    say "  [SKIP] 工作区 dirty——跳过并警示，不覆盖 WIP（07-26 stash 吞 WIP 教训）"
  fi
else
  do_ "仓库不存在 → clone 到 $REPO_DIR" \
      git clone "$REPO_URL" "$REPO_DIR"
fi

# ── S2 依赖探测（draft 不自动装，只打印指引）────────────────
step "S2 依赖探测"
need_node=18; need_py="3.10"
ok=1
if command -v node >/dev/null 2>&1; then
  v="$(node -e 'process.stdout.write(String(parseInt(process.versions.node)))' 2>/dev/null || echo 0)"
  [ "${v:-0}" -ge "$need_node" ] && say "  [OK] node $(node -v)" || { say "  [MISS] node $v < $need_node"; ok=0; }
else
  say "  [MISS] node 未安装"; ok=0
fi
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null \
    && say "  [OK] python $(python3 -V 2>&1 | awk '{print $2}')" \
    || { say "  [MISS] python < $need_py"; ok=0; }
else
  say "  [MISS] python3 未安装"; ok=0
fi
command -v git >/dev/null 2>&1 && say "  [OK] git" || { say "  [MISS] git 未安装"; ok=0; }
python3 -c "import requests" 2>/dev/null && say "  [OK] pip requests" \
  || { say "  [MISS] python requests（指引: python3 -m pip install --user requests）"; ok=0; }
if [ "$ok" -eq 0 ]; then
  case "$PLATFORM" in
    darwin)  say "  安装指引: brew install node python git" ;;
    linux|wsl2) say "  安装指引: sudo apt install nodejs python3 python3-pip git" ;;
    gitbash) say "  安装指引: winget install OpenJS.NodeJS Python.Python.3.12 Git.Git" ;;
    *)       say "  安装指引: 请按本平台包管理器安装 node>=$need_node python>=$need_py git" ;;
  esac
fi

# ── S3 目录铺设（mkdir -p 天然幂等）─────────────────────────
step "S3 目录铺设"
do_ "$STANDCODE_HOME/.standcode/harvest" mkdir -p "$STANDCODE_HOME/.standcode/harvest"
do_ "$STANDCODE_HOME/.standcode/tmp"     mkdir -p "$STANDCODE_HOME/.standcode/tmp"
do_ "standcode/data/inbox"               mkdir -p "$REPO_DIR/standcode/data/inbox"
if [ "$PLATFORM" = gitbash ]; then
  do_ 'E:\ai\{work,tmp,npm-cache}（Windows 盘符规划见组网方案 §2）' \
      mkdir -p /e/ai/work /e/ai/tmp /e/ai/npm-cache
fi

# ── S4 配置生成（文件存在即跳过，不覆盖）─────────────────────
step "S4 配置生成"
LOCAL_JSON="$REPO_DIR/standcode/config/local.json"
if [ -f "$LOCAL_JSON" ]; then
  say "  [SKIP] local.json 已存在，不覆盖"
else
  say "  local.json 缺 → 生成本机版（home_dir=当机、cc_send_bin 留空；本机私有配置 gitignore 不进仓）"
  if [ "$APPLY" -eq 1 ]; then
    cat > "$LOCAL_JSON" <<EOF
{
  "comment": "本机私有配置（gitignore，不进仓）：caller.py 读取，优先级低于同名环境变量",
  "cc_send_bin": "",
  "wechat_target": "",
  "home_dir": "$STANDCODE_HOME",
  "human_name": "TODO"
}
EOF
    say "  [RUN] 已生成 $LOCAL_JSON"
  else
    say "  [DRY] 将写入 $LOCAL_JSON（cc_send_bin 留空待人工填）"
  fi
fi
say "  [SKIP] registry.json 元信息跨平台，原样随仓，不生成"
if [ "$PLATFORM" = gitbash ]; then
  say "  [WARN] Windows 版 harnesses 需从 example 派生并人工把 CLI 路径改成 .cmd（组网方案 §10）"
fi

# ── S5 常驻服务（draft 只打印模板，不注册）──────────────────
step "S5 常驻服务注册模板（draft 阶段只打印，即使 --apply 也不注册）"
case "$PLATFORM" in
  darwin)
    if launchctl list 2>/dev/null | grep -q standcode; then
      say "  [SKIP] launchd 已注册 standcode"
    else
      say "  [TPL] launchd plist：Label=com.standcode.harvest，ProgramArguments=python3 $REPO_DIR/standcode/caller/caller.py harvest --loop，RunAtLoad=true"
    fi ;;
  linux|wsl2)
    if systemctl is-enabled standcode-harvest >/dev/null 2>&1; then
      say "  [SKIP] systemd 已启用 standcode-harvest"
    else
      say "  [TPL] systemd unit：[Service] ExecStart=/usr/bin/python3 $REPO_DIR/standcode/caller/caller.py harvest --loop；Restart=on-failure"
    fi ;;
  gitbash)
    if cmd //c "schtasks /query /tn StandCodeHarvest" >/dev/null 2>&1; then
      say "  [SKIP] schtasks 已存在 StandCodeHarvest"
    else
      say "  [TPL] schtasks /create /tn StandCodeHarvest /sc hourly /tr \"python $REPO_DIR\\standcode\\caller\\caller.py harvest\""
    fi ;;
  *)
    say "  [TPL] 未知平台，人工注册 caller.py harvest 常驻巡检" ;;
esac

# ── S6 凭证引导探测（只读探测存在性，永不触值）──────────────
step "S6 凭证引导探测（只测存在，不读值不入库）"
for var in GLM_CODING_KEY ANTHROPIC_AUTH_TOKEN DEEPSEEK_API_KEY; do
  if [ -n "$(eval "printf '%s' \"\${$var:-}\"")" ]; then
    say "  [OK] env $var 已设置"
  else
    say "  [MISS] env $var 未设置"
  fi
done
say "  人工注入指引："
case "$PLATFORM" in
  gitbash) say "    Windows: setx $PLATFORM 环境变量（setx GLM_CODING_KEY <值>），或写 \$HOME/.env 并 chmod 600" ;;
  *)       say "    POSIX: 写入 ~/.zshrc 或 ~/.bashrc（export GLM_CODING_KEY=<值>），或写 ~/.env 并 chmod 600" ;;
esac
say "  CLI 登录态目录探测（存在即跳过）："
for d in "$STANDCODE_HOME/.claude" "$STANDCODE_HOME/.codex" "$STANDCODE_HOME/.qclaw-hermes"; do
  [ -d "$d" ] && say "    [OK] $d" || say "    [MISS] $d（对应 CLI 需人工登录一次）"
done

step "完成"
if [ "$APPLY" -eq 0 ]; then
  say "以上为 DRY-RUN。人工核对动作清单后加 --apply 真跑（S5 服务注册仍需联调后放开）。"
else
  say "--apply 已执行可写动作（S5 服务注册段 draft 仍只打印模板）。"
fi
