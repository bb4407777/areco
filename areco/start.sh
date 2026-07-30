#!/usr/bin/env bash
# Areco 生产启停：pid 文件 + 身份校验（绝不按端口杀无辜进程）
# 用法: ./start.sh {start|stop|restart|status}
set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$REPO_DIR/data/areco.pid"
# 改名前的旧 pid 文件：新名不存在而旧名在时沿用，防止改名后第一次 stop 找不到活进程
[ ! -f "$PID_FILE" ] && [ -f "$REPO_DIR/data/agent-remote.pid" ] && PID_FILE="$REPO_DIR/data/agent-remote.pid"
LOG_DIR="$REPO_DIR/data/logs"
LOG_FILE="$LOG_DIR/server.out"
ENTRY="dist/server/index.cjs"

# 运行环境自钉死：不依赖调用方 shell（agent 会话常带隔离 HOME / 净化 PATH，
# 曾因此让 soffice ENOENT、transcript 落点漂移）。真实 HOME 从 passwd 库取（~username
# 展开不读 $HOME 环境变量），隔离 HOME 的会话代启也能落回本用户真身。
export HOME="${ARECO_HOME:-${AGENT_REMOTE_HOME:-$(eval echo "~$(id -un)")}}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

NODE_BIN="${ARECO_NODE:-${AGENT_REMOTE_NODE:-$(command -v node)}}"

mkdir -p "$LOG_DIR"
cd "$REPO_DIR" || exit 1

pid_alive() {
  # 校验 pid 存在且命令行确实是本服务，防止 pid 复用误杀
  local pid="$1"
  [ -n "$pid" ] || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "$ENTRY"
}

current_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true
}

config_port() {
  local port
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' config.json 2>/dev/null | head -1)"
  echo "${port:-8790}"
}

# 端口上「验明是本服务」的进程 pid（身份不符输出空——绝不把无辜进程当自己人）
port_owner() {
  local pid
  pid="$(lsof -nP -tiTCP:"$(config_port)" -sTCP:LISTEN 2>/dev/null | head -1)"
  if pid_alive "$pid"; then echo "$pid"; fi
}

do_status() {
  local pid
  pid="$(current_pid)"
  if pid_alive "$pid"; then
    echo "运行中 pid=$pid"
    return 0
  fi
  echo "未运行"
  return 1
}

do_start() {
  local pid
  pid="$(current_pid)"
  if pid_alive "$pid"; then
    echo "已在运行 pid=${pid}，拒绝重复启动"
    return 1
  fi
  # pid 文件失效但端口被本服务进程占用（孤儿/pid 错位）：收编校正，不盲起撞 EADDRINUSE
  local orphan
  orphan="$(port_owner)"
  if [ -n "$orphan" ]; then
    echo "$orphan" > "$PID_FILE"
    echo "端口已被本服务进程占用（pid=${orphan}），已校正 pid 文件；如需换新代码请用 restart"
    return 1
  fi
  [ -f "$REPO_DIR/$ENTRY" ] || { echo "缺少 ${ENTRY}，先 npm run build"; return 1; }
  [ -n "$NODE_BIN" ] || { echo "找不到 node"; return 1; }

  echo "启动 Areco…（node: ${NODE_BIN}）"
  nohup "$NODE_BIN" "$ENTRY" >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  # 等 healthz，且响应必须带 version 字段（验明正身：防同端口他人服务的假阳性）
  local body=""
  local port
  port="$(config_port)"
  for _ in $(seq 1 30); do
    if ! pid_alive "$new_pid"; then
      echo "启动失败（进程已退出），最近日志："
      tail -8 "$LOG_FILE"
      rm -f "$PID_FILE"
      return 1
    fi
    body="$(curl -s --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null)"
    echo "$body" | grep -q '"version"' && break
    sleep 1
  done
  if ! echo "$body" | grep -q '"version"'; then
    echo "警告：healthz 未确认为本服务（端口 $port 可能被其他进程占用）"
    tail -5 "$LOG_FILE"
    return 1
  fi
  # pid 文件以实际监听者为准（$! 在并发/失败竞态下会错位并链式传递到下次 restart）
  local listen_pid
  listen_pid="$(port_owner)"
  if [ -n "$listen_pid" ] && [ "$listen_pid" != "$new_pid" ]; then
    echo "$listen_pid" > "$PID_FILE"
    new_pid="$listen_pid"
  fi
  echo "healthz: $body   pid=$new_pid   日志: $LOG_FILE"
  grep -E 'Tailscale|局域网|本机' "$LOG_FILE" | tail -4
}

do_stop() {
  local pid
  pid="$(current_pid)"
  if ! pid_alive "$pid"; then
    # pid 文件失效：按端口找本服务孤儿收编（身份不符绝不杀），否则 restart 的 stop
    # 会空转、新进程 EADDRINUSE 假死（2026-07-17 两晚连中的链式错位）
    pid="$(port_owner)"
    if [ -z "$pid" ]; then
      echo "未运行（或 pid 文件失效），不动任何进程"
      rm -f "$PID_FILE"
      return 0
    fi
    echo "pid 文件失效，端口上发现本服务孤儿进程 pid=${pid}，纳入正常停止"
  fi
  echo "停止 pid=${pid}（SIGTERM，优雅退出）…"
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 10); do
    pid_alive "$pid" || break
    sleep 1
  done
  if pid_alive "$pid"; then
    echo "超时未退出，SIGKILL"
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  echo "已停止"
}

# 新旧 launchd label 兼容：优先 com.areco，旧机器上还是 com.agent-remote
LAUNCHD_TARGET="gui/$(id -u)/com.areco"
launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1 || LAUNCHD_TARGET="gui/$(id -u)/com.agent-remote"
LAUNCHD_LABEL="${LAUNCHD_TARGET##*/}"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"

launchd_active() {
  launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1
}

# launchd(KeepAlive) 已装载时归属让位：stop 会被秒复活、start 必撞 EADDRINUSE、
# restart 的新进程会输给复活竞速留下尸体 pid（2026-07-17 深夜实锤）。统一转发，
# 让「一律 ./start.sh restart」在两种接管方式下都成立。
# restart 分两种调用来源：
# - API 一键重启（ARECO_RESTART_VIA_API=1，脚本本身是服务的子进程）：只 kickstart -k。
#   detached 子进程躲得过 kickstart 的杀、躲不过 bootout 的整组 teardown——
#   2026-07-23 实测：bootout 把调用方一起带走，bootstrap 永远跑不到，服务躺尸。
# - 人工命令行：bootout+bootstrap 注销后从 plist 文件重新登记——kickstart -k 只按
#   launchd 内存里已登记的定义杀拉进程，plist 改了（环境变量/ProgramArguments）也看不见。
#   plist 缺失或 lint 不过则退回 kickstart -k（bootout 后 bootstrap 失败无 KeepAlive 兜底）。
if launchd_active; then
  case "${1:-start}" in
    restart)
      if [ "${ARECO_RESTART_VIA_API:-}" = "1" ]; then
        echo "launchd 已接管（${LAUNCHD_TARGET}），API 一键重启：kickstart -k（plist 改动需命令行 restart 重读）…"
        launchctl kickstart -k "$LAUNCHD_TARGET"
      elif [ -f "$LAUNCHD_PLIST" ] && plutil -lint "$LAUNCHD_PLIST" >/dev/null 2>&1; then
        echo "launchd 已接管（${LAUNCHD_TARGET}），bootout+bootstrap 重载（重读 plist）…"
        launchctl bootout "$LAUNCHD_TARGET" 2>/dev/null
        launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST"
      else
        echo "launchd 已接管（${LAUNCHD_TARGET}），plist 缺失或 lint 未过，退回 kickstart -k（不重读 plist）…"
        launchctl kickstart -k "$LAUNCHD_TARGET"
      fi
      sleep 2
      for _ in $(seq 1 15); do
        adopted="$(port_owner)"
        [ -n "$adopted" ] && break
        sleep 1
      done
      [ -n "${adopted:-}" ] && echo "$adopted" > "$PID_FILE"
      do_status
      exit $?
      ;;
    start)
      echo "launchd 已接管（${LAUNCHD_TARGET}），转发 launchctl kickstart -k …"
      launchctl kickstart -k "$LAUNCHD_TARGET"
      sleep 2
      for _ in $(seq 1 15); do
        adopted="$(port_owner)"
        [ -n "$adopted" ] && break
        sleep 1
      done
      [ -n "${adopted:-}" ] && echo "$adopted" > "$PID_FILE"
      do_status
      exit $?
      ;;
    stop)
      echo "launchd KeepAlive 接管中：stop 会被复活。真要停请 launchctl bootout $LAUNCHD_TARGET"
      exit 1
      ;;
    status)
      echo "launchd 接管中（${LAUNCHD_TARGET}）"
      do_status
      exit $?
      ;;
  esac
fi

case "${1:-start}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
