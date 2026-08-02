"""
StandCode Caller — 多 agent 调度核心

Hermes 作为 Caller，接收 Client（微信）的请求，
通过 areco REST API 创建房间、添加 Stand（worker agent），
通过 SQLite 直写消息投递任务，轮询收集结果。

依赖: requests, sqlite3 (stdlib)
"""

import json
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

try:
    import requests
except ImportError:  # 2026-08-02 P2-4：npm 包不代装 Python 依赖，缺依赖给人话而非裸 traceback
    raise SystemExit(
        "standcode: 缺少 Python 依赖 requests（需 Python >= 3.10）。\n"
        "  安装：python3 -m pip install -r requirements.txt   # 或 pip install requests\n"
        "  说明：standcode 是 Node + Python 双运行时（npm 只装 CLI 壳，见 README）。"
    ) from None

logger = logging.getLogger("standcode.caller")

# 本进程启动时刻（≈模块 import 时刻，误差远小于 2s 容差）：等待者 state / ask 席位文件
# 记录它当 start_ts，_waiter_alive 拿它对 ps lstart 做 pid 复用判别（2026-07-28 B5）。
_PROC_START_TS = time.time()

# ── 默认配置 ────────────────────────────────────────────────────────
ARECO_BASE = os.environ.get("ARECO_BASE", "http://127.0.0.1:8790")
# ── 本机私有配置 ────────────────────────────────────────────────────
# 本机私有值不进仓：优先级 env > config/local.json（gitignore）> 默认。
# WECHAT_TARGET 为空时 relay_to_wechat 直接返回未配置错误，不影响 dispatch/poll/inbox 主链。
#
# ⚠️ 这一段必须在 ARECO_ROOT 之前——HOME_DIR 是所有「家目录派生路径」的唯一源头。
# 改动前 ARECO_ROOT/TASKS_DIR 走 Path.home()、而 HOME_DIR 走 local.json，两者在隔离
# HOME 下会分裂：REST 照样连本机 8790 建出真房间、起真 Stand（烧额度），随后 send_message
# 却对着 $HOME/Code/StandCode/areco/data/projects.db 找不到库而炸——留下一个永远收不到任务的孤儿房。
# 本机大量 agent 跑在隔离 HOME 下，这不是假想（见 memory: isolated-home-tool-pitfall）。
_LOCAL_CONF_PATH = Path(__file__).resolve().parent.parent / "config" / "local.json"
try:
    _LOCAL_CONF = json.loads(_LOCAL_CONF_PATH.read_text()) if _LOCAL_CONF_PATH.exists() else {}
except Exception:
    _LOCAL_CONF = {}
CC_SEND_BIN = os.environ.get("CC_SEND_BIN") or _LOCAL_CONF.get("cc_send_bin") or "cc-send"
WECHAT_TARGET = os.environ.get("WECHAT_TARGET") or _LOCAL_CONF.get("wechat_target") or ""
HOME_DIR = os.environ.get("STANDCODE_HOME") or _LOCAL_CONF.get("home_dir") or str(Path.home())

def _detect_areco_root() -> str | None:
    # 2026-07-26 subtree 并入后 caller.py 位于 <仓根>/standcode/caller/；
    # 2026-07-30 高律师定底座收进 areco/ 子目录：仓根下 areco/ 才是底座根
    # （packages/server 标志也随之下移一级）。npm 安装场景
    # （node_modules/standcode/caller/）向上两级是 node_modules，node_modules/areco
    # 下无 packages/server 标志，同样被排除，防止把别人的目录误认成 areco。
    root = Path(__file__).resolve().parents[2] / "areco"
    return str(root) if (root / "packages" / "server").is_dir() else None


ARECO_ROOT = (
    os.environ.get("ARECO_ROOT")
    or _detect_areco_root()
    or str(Path(HOME_DIR) / "Code" / "StandCode" / "areco")
)
PROJECTS_DB = Path(ARECO_ROOT) / "data" / "projects.db"
REGISTRY_PATH = Path(__file__).resolve().parent.parent / "stand" / "registry.json"

# ── 房间来源标记 / 台账 / 自动归档 ──────────────────────────────────
# 2026-07-25 用户报障：房间名换成任务语义后（_room_label），派发房与人手建的案件房
# 在 areco「任务」列表里长得一模一样，积压无从辨认。三件套分层解决：
#   ROOM_MARK    人眼层：房间名首字符标记。必须放最前——边栏截断保留前缀，
#                原有的尾部 `·W1a2b` 正好被截掉，等于没有标记。
#   ROOMS_LEDGER 机器层：append-only jsonl 台账（room_id → 派发元信息）。名字会被用户
#                改、标记可被关，台账不会；追加写而非读改写，dispatch_parallel
#                并发派发不会互相覆盖。
#   AUTO_ARCHIVE 消积压：成功收口即归档。areco 归档房间会连带归档房内会话
#                （controllers/rooms.ts setMemberSessionsArchived），看板一并清干净；
#                失败/超时的房间**不**归档，留在看板上等人看。
#                注意：归档运行中会话 = 先 stop 再落 archived（session-manager
#                pendingArchive 链路），即会停掉 Stand 进程。结果已收完才归档，
#                需要续聊就在 UI 点「恢复任务」→ 重启即回看板。
ROOM_MARK = os.environ.get("STANDCODE_ROOM_MARK") or _LOCAL_CONF.get("room_mark") or "⚙"
ROOMS_LEDGER_PATH = Path(
    os.environ.get("STANDCODE_ROOMS_LEDGER")
    or _LOCAL_CONF.get("rooms_ledger")
    or (Path(HOME_DIR) / ".standcode" / "rooms.jsonl")
)


def _conf_bool(env_key: str, conf_key: str, default: bool) -> bool:
    """env > config/local.json > 默认 的三层布尔配置（与 CC_SEND_BIN 等同口径）"""
    raw = os.environ.get(env_key)
    if raw is None:
        raw = _LOCAL_CONF.get(conf_key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _conf_float(env_key: str, conf_key: str | None, default: float) -> float:
    """读浮点配置，解析失败只告警回落默认值。

    这些解析在 import 期执行——裸 float() 一旦遇到 `STANDCODE_SWEEP_IDLE_MIN=30m`
    这种手误就是 ValueError，**整个 CLI 连同 `import caller` 一起死在 import 上**，
    每个子命令都打 traceback。一个配置手误不该造成全量停摆。
    """
    raw = os.environ.get(env_key)
    if raw is None and conf_key:
        raw = _LOCAL_CONF.get(conf_key)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        logger.warning("%s=%r 不是合法数字，回落默认值 %s", env_key, raw, default)
        return default


AUTO_ARCHIVE = _conf_bool("STANDCODE_AUTO_ARCHIVE", "auto_archive", True)
# 清扫判定的空闲门槛（分钟）：房间最后一条消息距今超过它才算「静了」，防止把
# 用户正在里面追问的房间扫掉。
SWEEP_IDLE_MIN = _conf_float("STANDCODE_SWEEP_IDLE_MIN", "sweep_idle_min", 30)
# 连续读 projects.db 失败多少次就放弃等待（见 get_messages）
MSG_READ_FAIL_LIMIT = int(_conf_float("STANDCODE_MSG_READ_FAIL_LIMIT", None, 10))

# ── 派发/轮询节奏（2026-07-26 提速）────────────────────────────────
# BOOT_WAIT_SEC：add_stand 返回 → send_message 之间的等待。历史值 3s→1s→0（2026-07-30
# P1-5 删除）：消息落库后由 areco room-relay tick 投递，注入前还有 MIN_BOOT 下限（8s/4s）
# + onceQuiet（输出安静 1.2s）双重挡竞态——Stand 没 ready 消息也不会丢，盲等纯属重复保险
# （诊断样本 A 实测每单白付 1.0s）。留 env/config 旋钮应急：出竞态回填秒数即可，不用改码。
# MERGE_WAIT_SEC：poll 收到首条 Stand 回复后的合并窗（等可能的连发增量）。
# POLL_INTERVAL_SEC：轮询间隔；读的是本地 SQLite，0.5s 的成本可忽略。
BOOT_WAIT_SEC = _conf_float("STANDCODE_BOOT_WAIT", "boot_wait_sec", 0.0)
MERGE_WAIT_SEC = _conf_float("STANDCODE_MERGE_WAIT", "merge_wait_sec", 1.5)
POLL_INTERVAL_SEC = _conf_float("STANDCODE_POLL_INTERVAL", "poll_interval_sec", 0.5)
# 红绿灯三常量（2026-07-26 poll 接入 areco trafficState）：
# STATE_PROBE_SEC 探针节流；STUCK_CONFIRM_HITS 连续 N 个探针周期 needs-user 才判卡死
# （滤瞬时黄灯）；SETTLE_MAX_SEC 已有回复但灯一直 working 的强制定稿上限（灯坏死兜底）。
STATE_PROBE_SEC = _conf_float("STANDCODE_STATE_PROBE", "state_probe_sec", 5)
STUCK_CONFIRM_HITS = int(_conf_float("STANDCODE_STUCK_HITS", "stuck_confirm_hits", 2))
SETTLE_MAX_SEC = _conf_float("STANDCODE_SETTLE_MAX", "settle_max_sec", 1800)
# MIN_TIMEOUT_SEC 等待类派发显式 --timeout 的下限闸（0=关闸）。「Stand 永不设超时，
# 要限时必须用户明说」是 2026-07-26 高律师的决定，SKILL 写了但弱模型照传不误——
# 2026-07-27 实证：Hermes 全天逐单手填 120/180/300s（25民1000 两单 180s，Worker
# 死线前 8s 交活仍被判 timeout 丢结果）。文本约不住的纪律用闸约：低于下限一律抬到
# 下限；高律师真要短限时 → STANDCODE_MIN_TIMEOUT=0 关闸再传。
MIN_TIMEOUT_SEC = _conf_float("STANDCODE_MIN_TIMEOUT", "min_timeout_sec", 600)
# 2026-07-26 实战两洞（B4 e2e 现场捕获）：
# OUTPUT_STALL_PROBES：tool 尾假 working 判别——agent 用 areco-msg 回执后 turn 以工具调用
#   收尾，transcript 灯永不落绿；outputChars 连续 N 个探针零增长 = 没在干活，定稿。
#   2026-07-27 6→12（≈60s 零增长才判）：30s 对慢工具/长思考太短，误判提前收口会连带
#   归档杀 Stand（见 finish_room 守卫）——fast 轻量车道的 Stand 回答间隔更不均匀，宁多等。
# IDLE_STALL_PROBES：注入丢失/模型秒退判别——任务落库但会话 idle 零回复；达 N 重投一次，
#   翻倍仍空转返回 status='stall' 交人工。
OUTPUT_STALL_PROBES = int(_conf_float("STANDCODE_OUTPUT_STALL_PROBES", "output_stall_probes", 12))
IDLE_STALL_PROBES = int(_conf_float("STANDCODE_IDLE_STALL_PROBES", "idle_stall_probes", 9))
# ── ⑥ 两道闸校准（2026-07-29 高律师批；当日 6 单空转误杀 + 3 单提前收网实证）────
# FIRST_TOKEN_MAX_SEC：空转判死（status='stall'）的首字等待上限。idle×N 只是嫌疑——
#   慢思考模型（flash/Fable5/GLM/kimi/agnes 当日全部中招）首字 90s+ 是常态，杀之前
#   还须 ① 距任务投递已超本上限 ② 现场新鲜拉一次 areco 看板确认真零产出（outputChars
#   零增长且灯仍 idle，见 poll_result 2c）。重投自愈不受本上限约束，只受看板复核约束。
# PROGRESS_SETTLE_SEC：纯进度句（「我先…」「让我来…」）的续等窗。第一条回复不像交付物
#   （无结论段/产物路径/数字结果，见 _looks_like_deliverable）时不吃 MERGE_WAIT_SEC
#   短合并窗——窗内有新回复/新输出就继续等，静满本窗才按 progress_timeout 定稿。
FIRST_TOKEN_MAX_SEC = _conf_float("STANDCODE_FIRST_TOKEN_MAX", "first_token_max_sec", 300)
PROGRESS_SETTLE_SEC = _conf_float("STANDCODE_PROGRESS_SETTLE", "progress_settle_sec", 180)

# ── 三闸总开关（2026-07-29 高律师令：三闸全关，覆盖当日⑥校准口径）──────────
# 空转闸全关：不判空转、不杀会话、不重投（poll_result 2c 整段停用）；
# 定稿闸全关：收网只认 Worker 自报完成——有回复即走基础合并窗，不再判「像不像
#   交付物」（⑥的交付物门槛/进度句续等窗停用，wedge 收口退回 ⑥ 前口径）；
# 1800s 兜底也关：灯 working 等待无上限（SETTLE_MAX_SEC hold_cap 停用）。
# 明令做成开关不删死：闸逻辑原样保留，重开改 True 即可。harvest 收割巡检
# （_cmd_harvest/_room_settled）不读这三个开关——自带红绿灯 + HARVEST_SILENCE_SEC
# 静默门，独立于此。
STALL_WATCHDOG_ENABLED = False  # 空转闸：idle 判 stall / 重投自愈
SETTLE_GATE_ENABLED = False     # 定稿闸：交付物门槛 / 进度句续等窗判别
HARD_TIMEOUT_ENABLED = False    # 1800s 兜底：hold_cap 强制定稿

# ── 重复派发闸 / 模板健康闸（2026-07-28 派发机制优化 A2/A3）──────────────
# DUP_WINDOW_SEC 重复闸的时间窗：同一 request 的 running 任务只在窗口内算「在途」——
# 窗口外的 running 是陈旧 state（等待者早死、reconcile 还没扫到），不该拦新派发。
# 动机：07-28 实证同一任务 47 秒内 `go` 两次，派发链路没有任何重复闸。
DUP_WINDOW_SEC = _conf_float("STANDCODE_DUP_WINDOW", "dup_window_sec", 7200)
# 模板健康闸：同模板连续失败 ≥UNHEALTHY_FAIL_LIMIT 次即隔离 UNHEALTHY_TTL_SEC 秒。
# 动机：07-27 实证 workbuddy-gpt56-remote 已 503/404 仍被路由 3 次、暖池同模板连补
# 17 次只 warning 无 backoff。隔离期间 dispatch 硬报错（列健康模板，不静默换模板）、
# refill/claim 直接跳过；成功一次即清除，until 过期自动恢复，pool --heal 手动解除。
UNHEALTHY_PATH = Path(
    os.environ.get("STANDCODE_UNHEALTHY") or str(Path(HOME_DIR) / ".standcode" / "unhealthy.json")
)
UNHEALTHY_FAIL_LIMIT = int(_conf_float("STANDCODE_UNHEALTHY_FAILS", "unhealthy_fail_limit", 2))
UNHEALTHY_TTL_SEC = _conf_float("STANDCODE_UNHEALTHY_TTL", "unhealthy_ttl_sec", 1800)

# ── 暖池 standby pool + plan 预热（2026-07-26 提速批件；2026-07-29 高律师令关闭）────
# 一单冷派发的固定税 ≈ 12-15s：spawn 后 areco 侧 8s 注入下限（MIN_BOOT）+ relay 2s
# tick + onceQuiet 1.2s + BOOT_WAIT。暖池把这笔税移出关键路径：预先建房+spawn 好
# 「待命 Stand」（TUI 空闲不调模型 = 零 token；房名「⚙待命·<模板>」留在看板），
# dispatch 认领即注入，用掉 inline 补胎。isolated 派发不走暖池——cwd 在 spawn 时定。
# 池文件：~/.standcode/standby/<模板>--<房id>.json；认领 = os.rename 原子抢占。
# 2026-07-29 高律师令：关闭预热/驻留提速（看板上每个模板多开一个待命进程），
# 开关常量化=False、机制代码保留不删；派发回到现派现 spawn（慢 12-15s 可接受）。
STANDBY_ENABLED = False  # 原：_conf_bool("STANDCODE_STANDBY", "standby_pool", True)
STANDBY_MAX_AGE_SEC = _conf_float("STANDCODE_STANDBY_MAX_AGE", "standby_max_age_sec", 7200)
STANDBY_POOL_SIZE = int(_conf_float("STANDCODE_STANDBY_POOL_SIZE", "standby_pool_size", 1))
STANDBY_DIR = Path(
    os.environ.get("STANDCODE_STANDBY_DIR") or str(Path(HOME_DIR) / ".standcode" / "standby")
)
# plan 两段式预热：派 Thinker 的同时同房 add_stand Worker（不发任务，投递按 to_agent
# 定向不会误收）——Thinker 段跑着的时候 Worker 把 spawn+注入下限静默付清，
# 计划一出直接注入，第二段冷启动移出关键路径。
# 2026-07-29 高律师令：随暖池一同关闭（同属预热/驻留提速），代码保留不删。
PREWARM_WORKER = False  # 原：_conf_bool("STANDCODE_PREWARM_WORKER", "prewarm_worker", True)

# ── 旧会话优先复用（2026-07-29 高律师令，Kimi 施工）────────────────────
# 旧口径每单无脑 spawn 新会话：上下文缓存全浪费、进程越攒越多。本层在派单前先查
# areco 同模板下有没有空闲旧会话，命中即把任务注入旧会话（缓存是暖的），不再 spawn。
# 复用判据三条同时满足：
#   a. 会话空闲      —— status=running 且 trafficState 为 conclusion/idle
#                      （working=在干活、needs-user=屏上挂着待选框，都算忙不碰）
#   b. 上下文未近满  —— claude transcript 尾条 usage 拿得到就判
#                      （≥SESSION_REUSE_CONTEXT_LIMIT 不复用）；拿不到（非 claude
#                      harness 无 transcript）就靠 areco 侧空闲信号放行，不硬编数字
#   c. 任务不带「干净上下文」标记 —— --fresh / fresh=True / 正文含 FRESH_CONTEXT_MARKERS
# 例外（强制新会话）：擂台/基准测试（ARENA_KEYWORDS，公平性各模型同起点）、
# 法律案件类（LEGAL_CASE_KEYWORDS，复用=上下文延续，跨案件/跨项目有串味风险，
# 对齐 Hermes 案件隔离纪律）。任何异常/查不到都 fail-open 回落新会话——
# 复用只是省冷启动税，绝不该挡派发。决策一律写 route_reason（结果+审计）可见。
SESSION_REUSE_ENABLED = True  # 开关常量化（同 STANDBY_ENABLED 口径；改这里一键关停）
SESSION_REUSE_CONTEXT_LIMIT = int(_conf_float(
    "STANDCODE_SESSION_REUSE_CTX_LIMIT", "session_reuse_context_limit", 160_000))
FRESH_CONTEXT_MARKERS = ("干净上下文", "[fresh]", "[clean-context]")
ARENA_KEYWORDS = ("擂台", "基准测试", "benchmark", "对战")
LEGAL_CASE_KEYWORDS = (
    # 与 HEAVY_LAW_KEYWORDS 同源（案件/文书/法条…）——那边管路由车道，
    # 这边管会话隔离；词表分开常量化，免得一边改词另一边跟着飘。
    "案件", "文书", "法条", "核查", "立案", "保全", "证据", "判决",
    "起诉", "答辩", "上诉", "调解",
)

# ── 额度/限流检测与车道改道（2026-07-29 高律师令，GLM-5.2 额度打满事件）─────────
# 背景：GLM-5.2（智谱套餐）额度打满，重活车道（法律/代码词 → claude-glm52）瘫痪。
# ① 重活车道锚 / ③ fast 车道锚：2026-07-30 高律师定案——**真锚已迁 areco 设置页**
#    （config.json standcode 段 heavyWorker/fastWorker，GET/PUT /api/standcode/defaults），
#    每次 go 运行时读取（resolve_lane_anchors：HTTP API → areco config.json 直读 →
#    文件内常量 fallback）。下面两个常量不再是真锚，只是三级回落的兜底；
#    高律师改锚去 areco 设置页，不要再改这里。
#    备查历史：原重活锚 claude-glm52（GLM-5.2 重活主力）；备胎 kimi-k3
#    （2026-07-29 GLM 额度满 / GLM stand 连续失联期间保底，07-30 转正为真锚）；
#    qclaw-dsv4flash 模板因 protocol 不兼容已删除；fast 备胎 workbuddy-deepseek。
HEAVY_LANE_STAND = "kimi-k3"  # fallback（真锚在 areco 设置页）；2026-07-30 GLM 恢复后 stand 仍 session_exited 失联，切回 kimi-k3 保底  # fallback 常量（真锚在 areco 设置页）；2026-07-30 晚 GLM 恢复回切，kimi-k3 备胎      # fallback 常量：真锚在 areco 设置页 standcode.heavyWorker
FAST_LANE_STAND = "qclaw-flash"   # fallback 常量：真锚在 areco 设置页 standcode.fastWorker
# ② Stand 输出扫描：poll/harvest 链对 Stand 回复做大小写不敏感子串匹配，
#    命中即 a) 该 stand 标停新单（写 STAND_STOP_PATH）b) 涉及车道按备胎表改道
#    c) cc-send 微信告警高律师 d) 事件追加 StandCode SKILL.md 台账 + 审计日志。
#    词表收紧（2026-08-02 检查报告 P1-3）：裸「额度」「insufficient」「quota」在法律
#    正文里是常客（保险赔偿额度/授信额度/证据 insufficient to establish/进口配额
#    quota），单词命中会把正常业务输出误判成限流 → 停新单+改道+告警三连环——业务层
#    误杀比漏报贵得多（漏报还有 429 正则和人工兜底）。全部改上下文组合词；
#    「429」另有 _QUOTA_429_RE 边界正则防「第429条/号」误伤。
QUOTA_SIGNAL_WORDS = (
    "429",                # 特殊：经 _QUOTA_429_RE 边界匹配，不是裸子串
    "rate limit",         # rate limit / rate limited / rate limit exceeded
    "余额不足",
    "额度不足", "额度已满", "额度已用", "额度用尽", "额度打满", "超出额度",
    "模型额度", "调用额度", "使用上限",
    "quota exceed", "quota limit", "api quota", "quota_exceeded",
    "insufficient credit", "insufficient balance", "insufficient quota",
    "insufficient_quota",
)
# 车道备胎映射：stand 停新单后其涉及车道的改道目标（stand id → 备胎 stand id）。
# 轻活备胎 workbuddy-deepseek（07-30 由 codebuddy-ds-flash 回退 workbuddy 系原名，registry 已注册），接入后补录。
# kimi-k3 备胎 qclaw-flash（2026-08-02 补）：K3 是现役 thinker/heavy 锚且额度紧张、
# 台账多次停新单，无备胎时 thinker 车道停摆只 warning——落免费车道保底。
LANE_FALLBACK_MAP = {
    "claude-glm52": "kimi-k3",
    "workbuddy-deepseek": "qclaw-flash",
    "kimi-k3": "qclaw-flash",
}


# 车道锚运行时解析（2026-07-30 高律师定案：SoT = areco 设置页 standcode 段）。
# 每次 go 都是新进程、加载注册表时调一次 → 等价于「每次 go 从 areco 读锚」。
# 进程级 memo（2026-07-30 P2-9）：一次 go 进程内分诊/路由/锚解析/双 Caller 实例化
# 曾各读一遍（实测 5 次 HTTP），进程活不过一次派发，读一次就够；跨进程仍是每次新读。
_STANDCODE_CONF_MEMO: tuple[dict, str] | None = None


def _areco_standcode_conf() -> tuple[dict, str]:
    """读 areco standcode 段。返回 (配置dict, 来源)：来源 ∈ areco-api / areco-config / ''。

    ① 优先 HTTP API（:8790 GET /api/standcode/defaults，设置页保存即时生效）；
    ② areco 不可达 / 旧版无端点 → 直读 areco config.json（服务端运行期不回读文件，
       直读拿到的是「下次重启生效」的落盘值，仍优于文件内常量）；
    ③ 都失败返回 ({}, '')，调用方回落常量并横幅警告（失败结果不 memo，下次调用重试）。
    """
    global _STANDCODE_CONF_MEMO
    if _STANDCODE_CONF_MEMO is not None:
        return _STANDCODE_CONF_MEMO
    try:
        resp = requests.get(f"{ARECO_BASE}/api/standcode/defaults", timeout=2)
        if resp.status_code == 200:
            data = resp.json().get("data")
            if isinstance(data, dict):
                _STANDCODE_CONF_MEMO = (data, "areco-api")
                return _STANDCODE_CONF_MEMO
    except Exception:
        pass
    try:
        cfg = json.loads((Path(ARECO_ROOT) / "config.json").read_text(encoding="utf-8"))
        sc = cfg.get("standcode")
        if isinstance(sc, dict):
            _STANDCODE_CONF_MEMO = (sc, "areco-config")
            return _STANDCODE_CONF_MEMO
    except Exception:
        pass
    return {}, ""


def _areco_send_from_supported() -> bool:
    """服务端 rooms.send 是否收 from/humanRelay/to（P1-5 REST 快路的能力探测）。

    判据 = defaults 响应的 _caps.sendFrom（仅 areco-api 来源可信：config.json 直读
    说明服务端不可达或旧版，能力横幅无从谈起）。False → send_message 回落 SQLite 直写。
    """
    conf, source = _areco_standcode_conf()
    if source != "areco-api":
        return False
    caps = conf.get("_caps")
    return bool(isinstance(caps, dict) and caps.get("sendFrom"))


def resolve_lane_anchors() -> dict:
    """解析 heavy/fast 两车道锚。返回 {"heavy": (stand_id, source), "fast": (stand_id, source)}。

    三角色统一（2026-08-02，落实 08-01 高律师定案「角色只剩 Caller/Thinker/Worker，
    重活并入 Thinker、快速并入 Worker」——此前只是把两处配置手工设成同值，areco 设置页
    08-01 收敛三角色删掉 heavyWorker/fastWorker 字段后，本函数读不到旧字段一路落到
    文件内常量，设置页改 Thinker/Worker 两车道完全不跟，即「UI 一套、实际跑另一套」，
    2026-08-02 检查报告 P1-1）。新解析链——车道不再是独立配置源：
      heavy := 旧字段 heavyWorker（迁移期兼容，配置里还写着就尊重）→ **thinker** → 常量
      fast  := 旧字段 fastWorker（同理）→ **worker** → 常量
    设置页改 Thinker/Worker，重活/快速车道自动跟随；常量只剩 areco 全挂的兜底。
    source ∈ areco-api / areco-api(=thinker|worker) / areco-config / 常量fallback
    （横幅口径随 go 头行 JSON 输出）。逐车道独立回落，不搞一刀切。
    """
    conf, conf_source = _areco_standcode_conf()
    out: dict[str, tuple[str, str]] = {}
    for lane, legacy_key, role_key, const in (
            ("heavy", "heavyWorker", "thinker", HEAVY_LANE_STAND),
            ("fast", "fastWorker", "worker", FAST_LANE_STAND)):
        # ① 迁移期兼容：旧字段仍有值（老 config 残留/手工回填）就尊重
        value = str(conf.get(legacy_key) or "").strip()
        if value:
            out[lane] = (value, f"{conf_source}(旧字段{legacy_key})")
            continue
        # ② 三角色新口径：车道锚 = 对应角色锚（heavy=thinker / fast=worker）
        value = str(conf.get(role_key) or "").strip()
        if value:
            out[lane] = (value, f"{conf_source}(={role_key})")
            continue
        # ③ API 缺角色键（旧版服务端）：config.json 直读同链（旧字段优先，其次角色）
        if conf_source == "areco-api":
            try:
                cfg = json.loads((Path(ARECO_ROOT) / "config.json").read_text(encoding="utf-8"))
                sc = cfg.get("standcode") or {}
                value = str(sc.get(legacy_key) or sc.get(role_key) or "").strip()
                if value:
                    out[lane] = (value, "areco-config")
                    continue
            except Exception:
                pass
        out[lane] = (const, "常量fallback")
        logger.warning(
            "车道锚 %s 从 areco 读不到（来源链：%s），回落文件内常量 %s"
            "——真锚在 areco 设置页三角色（%s），请到设置页配置",
            lane, conf_source or "areco 不可达且 config.json 不可读", const, role_key,
        )
    return out
# 停新单运行期状态文件：registry 模板静态标记（"status": "停新单"）之外的
# 自动命中落点；Caller 加载时两路并集生效（_stopped_stands）。
STAND_STOP_PATH = Path(
    os.environ.get("STANDCODE_STAND_STOP")
    or str(Path(HOME_DIR) / ".standcode" / "stand-stop.json")
)
# 事件台账：命中自动追加一行到 StandCode SKILL.md（追加失败不阻断处置）。
STANDCODE_SKILL_MD = Path(
    os.environ.get("STANDCODE_SKILL_MD") or "/Users/gao/skills/StandCode/SKILL.md"
)

# ── 审计日志（Gatekeeper BLOCKED + dispatch / poll 关键节点）─────────
# 每行一条 JSON：{timestamp, event, task_id, role, template, blocked, ...}。
# STANDCODE_AUDIT_LOG 可覆盖路径（测试用 /tmp 之外的隔离）。
# 审计日志落 HOME 而非 /tmp：macOS 会清 /tmp，而这是「直干率审计」唯一的证据基础——
# 证据在分析脚本读到它之前就蒸发，等于审计不存在（2026-07-26 审计指出）。
AUDIT_LOG_PATH = os.environ.get("STANDCODE_AUDIT_LOG") or str(
    Path(HOME_DIR) / ".standcode" / "audit.jsonl"
)
try:
    Path(AUDIT_LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
except Exception:  # 建不出目录也不能拖垮主流程——log_audit 自己还有一层兜底
    pass

# ── 会话可靠性 / 工作区隔离（docs/architecture-optimization.md 建议 4）─────────
# 心跳目录：Caller 只「读」这里的 {session_id}.hb；「写」应由 Stand 宿主进程
# （areco session / wrapper 脚本）负责——只有宿主活着才等于 Stand 活着。
# Caller 进程自写的心跳只证明 Caller 跟踪循环在跑，对「Stand 是否掉线」是假信号
# （详见 _HeartbeatWriter 与 read_heartbeat 的注释）。
HEARTBEAT_DIR = Path(os.environ.get("STANDCODE_HEARTBEAT_DIR", "/tmp/standcode-heartbeat"))
WORKSPACE_DIR = Path(os.environ.get("STANDCODE_WORKSPACE_DIR", "/tmp/standcode-workspaces"))
HEARTBEAT_STALE_SEC = _conf_float("STANDCODE_HEARTBEAT_STALE", None, 15)
HEARTBEAT_TICK_SEC = _conf_float("STANDCODE_HEARTBEAT_TICK", None, 5)
# 自动重派发默认关闭：会外部 spawn 新房间 + 新 Stand 会话（消耗额度、产生持久状态、
# 不可逆）。须用户显式开 max_retries>0 才生效，对齐「对外不可逆动作事前确认」。
DEFAULT_MAX_REDISPATCH = 0

# ── 默认模板：完全由 stand/registry.json 驱动 ──────────────────────
# 历史上这里硬编码过 DEFAULT_TEMPLATE_ID="claude" 与 DEFAULT_TASK_MAP（search/coding/
# writing/analysis/general → reasonix）。那套 task_type 与模板 id 与 registry 不一致：
# registry 用 think/plan/execute/work/fast，模板用 stand-thinker-*/stand-worker-*，且
# reasonix 根本不在 registry 模板表里（孤儿）。已改为默认值全部由 Caller._load_registry()
# 从 registry.json 读取，此处不再保留任何业务硬编码默认。
# 2026-07-25：角色映射改为直接引用 areco 现有模板 id（如 workbuddy-deepseek-pro），
# 不再经 sync-areco-templates.py 新建 stand-* 模板（已清理）。
# registry.json 字段映射：
#   default_thinker     → default_thinker_id（Thinker 角色）
#   default_worker      → default_worker_id（Worker 角色 + 全局兜底 default_template_id）
#   task_type_defaults  → task_map（任务类型 → 模板 id）
# registry 文件缺失/解析失败时的紧急兜底见 _load_registry() 顶部局部常量。
# 优先级（2026-07-25 起）：areco 设置页「StandCode 默认角色」
# （GET /api/standcode/defaults，见 _apply_areco_defaults）> registry.json > 紧急兜底。

# 来自 Caller 自身的身份标识（2026-08-02 多向派发：env > config/local.json > 默认 Hermes）
# 任何 agent（QClaw/WorkBuddy/areco Stand/人工 CLI）都可携带自己的身份派发；from_agent
# 落库真实署名（署名真实纪律，禁冒名）。非 Hermes 身份走「外部编排者」路径：areco
# room-relay 2026-07-24 版起按 to_agent 列投递、from 不在花名册则链深不增不清——
# areco 侧零改动即支持。统一入口 standcode/bin/sc 负责探测身份并设本 env。
CALLER_NAME = (
    os.environ.get("STANDCODE_CALLER")
    or _LOCAL_CONF.get("caller_name")
    or "Hermes"
).strip() or "Hermes"

# 转述通道白名单：send_message 的 human_relay 只对名单内 caller 生效（须与 areco
# config.json humanRelayAgents 对齐——名单外打标 areco 只 warn 并按普通 agent 处理，
# 标了也无效还刷日志）。非白名单 caller 的任务消息 human_relay=0，靠 to_agent 列投递。
HUMAN_RELAY_CALLERS = set(_LOCAL_CONF.get("human_relay_callers") or ["Hermes"])

# 已知派发身份全集：poll/harvest/reconcile 筛「非 Stand 发言」用。只排除当前
# CALLER_NAME 不够——reconcile/harvest 由 cron 以默认身份（Hermes）跑，补收其它
# caller 派的房间时若不认识 QClaw 等身份，会把任务书本身误当 Stand 产出收割。
# local.json `known_callers` 可扩；内置集合覆盖本机现役 agent。
_DEFAULT_KNOWN_CALLERS = {
    "Hermes", "QClaw", "WorkBuddy", "Kimi", "Fable5", "Codex", "Reasonix", "cli",
}
KNOWN_CALLERS = (
    _DEFAULT_KNOWN_CALLERS
    | {CALLER_NAME}
    | set(_LOCAL_CONF.get("known_callers") or [])
)

# 房间里"非 Stand"的发件人 —— 这些消息不算 Stand 的执行结果：
#   KNOWN_CALLERS = 各派发身份（直写 SQLite 时 from_agent）
#   HUMAN_NAME = 人类用户（REST 通道的 from_agent）。名称因人而异，故走
#                env > config/local.json > 默认 的三层配置，不硬编码个人称谓。
#   all/system = 广播/系统消息；areco-调度 = areco 服务端调度指令署名
HUMAN_NAME = os.environ.get("STANDCODE_HUMAN_NAME") or _LOCAL_CONF.get("human_name") or "user"
NON_STAND_SENDERS = KNOWN_CALLERS | {HUMAN_NAME, "all", "system", "areco-调度"}

# ── 派发深度闸（2026-08-02 多向派发防套娃）────────────────────────────
# 房间链深闸管不到编排者（from 不在花名册不增不清），转派套娃要 caller 侧自控：
# 每单投递注入的「委派说明」告知 Stand 本单深度，Stand 转派时 --depth +1；
# 达上限拒派（--force 可越，须在回执里说明）。分身层退役（2026-07-29）的教训：
# 中转层正确率没增量、纯付中转税——深度 ≥2 的链路默认不该存在。
DISPATCH_DEPTH = 0
try:
    DISPATCH_DEPTH = max(0, int(os.environ.get("STANDCODE_DISPATCH_DEPTH") or 0))
except ValueError:
    logger.warning("STANDCODE_DISPATCH_DEPTH 非整数，按 0 处理")
MAX_DISPATCH_DEPTH = 2
try:
    MAX_DISPATCH_DEPTH = int(
        os.environ.get("STANDCODE_MAX_DISPATCH_DEPTH")
        or _LOCAL_CONF.get("max_dispatch_depth")
        or 2
    )
except ValueError:
    logger.warning("STANDCODE_MAX_DISPATCH_DEPTH 非整数，按 2 处理")

# ── ask 通道：点名常驻 agent，先看灯再投（2026-07-26 高律师需求）────
# 背景：「问/让 Fable5」类任务此前全走 areco-msg @成员 投常驻房间里唯一的 Fable5
# 会话，Fable5 正忙时新任务只能在同一会话里排队串行——看板上呈现为「总是派到同一个
# fable5」。ask 子命令把「观察运行状态 → 空闲直投 / 忙则另开并行」折进一条命令：
#   空闲  → 直投常驻会话（沿用其累积上下文，不铺新会话）；
#   忙/卡框/不可用/直投席位被同轮并发 ask 抢走 → dispatch 新房并行跑（同模板）。
# 通道定义走 env > config/local.json ask_channel > 默认；room_id 漂移时按成员名
# 在未归档房间里唯一定位兜底。
_ASK_CONF = _LOCAL_CONF.get("ask_channel") or {}
ASK_MEMBER = os.environ.get("STANDCODE_ASK_MEMBER") or _ASK_CONF.get("member") or "Fable5"
ASK_ROOM_ID = os.environ.get("STANDCODE_ASK_ROOM") or _ASK_CONF.get("room_id") or ""
ASK_TEMPLATE_FALLBACK = (
    os.environ.get("STANDCODE_ASK_TEMPLATE") or _ASK_CONF.get("template") or "claude-fable5"
)
# 忙判定：working=正在干活；needs-user=卡在终端交互框（投进去也没人处理）。
# conclusion/idle=空闲；exited 视为可直投——room-relay 投递时自动 restart resume。
ASK_BUSY_STATES = ("working", "needs-user")
# 直投席位 claim：两个 ask 同轮并发时都可能探到「空闲」，凭 O_EXCL 文件抢占定唯一
# 直投者，输家转并行——不然「忙则另开」在同轮多任务场景下照旧全挤进一个会话。
ASK_CLAIMS_DIR = Path(
    os.environ.get("STANDCODE_ASK_CLAIMS_DIR")
    or str(Path(HOME_DIR) / ".standcode" / "ask-claims")
)
# exited 通道直投后等 resume 拉起的上限秒数：poll_result 的 lost 判定读 status==exited，
# 不等到 running 就开轮询会在 restart 窗口内误判失联。
ASK_RESUME_WAIT_SEC = _conf_float("STANDCODE_ASK_RESUME_WAIT", "ask_resume_wait_sec", 60)

# ── Thinker/Worker 严格分工：结构化 plan 模板 + 门控 ──────────────
# plan 模板：强制 Thinker 按「目标/上下文/步骤/约束/判据/落点」结构化输出，
# Worker（registry.default_worker）拿到即可执行、不必再「理解意图」。三属性：结构化/自包含/有判据。
PLAN_TEMPLATE = (
    "你是 Thinker，只做规划、绝不执行（不写代码、不下载、不搜索、不产出最终文件）。\n"
    "请为以下任务产出【可执行计划】，严格按下方格式输出，不要输出计划以外的内容。\n\n"
    "【任务】\n{request}\n\n"
    "【输出格式】（逐段填写，缺项写「无」，不要省略段落）\n"
    "目标：<一句话、可验证的最终目标>\n"
    "上下文：<必要背景；用户原话要点；涉及的所有文件路径/URL/数据；Worker 无你的上下文，必须带全>\n"
    "步骤：\n"
    "1. <动作> | 工具或数据：<...> | 产物：<文件路径或『无』>\n"
    "2. <动作> | 工具或数据：<...> | 产物：<...>\n"
    "（继续列出所有步骤）\n"
    "约束：<口径/红线/边界/不要做什么>\n"
    "完成判据：<什么算 done，尽量可机检，如『文件存在/字段齐全/行数≥N』>\n"
    "最终产物落点：<最终交付文件的绝对路径，或『无』>\n"
)

# 模式 4（think，无下游 Worker）的角色约束。
#
# 这段本来写在 config/presets.json 的 `thinker_only.system` 里——但 2026-07-26 查证：
# areco 的 standcode-resolver 只在 harness==="openclaw" 时读 preset，且只读 timeout；
# `system` 与 `thinking` 在任何分支下都从未被读取，而本机 harnesses.json 里压根没有
# openclaw。也就是说 presets 的角色提示词是**纯装饰，从未传给任何模型**。
# 真正生效的机制是「把约束写进 dispatch 的 request 正文」——PLAN_TEMPLATE 一直这么干。
# 所以搬过来。
THINK_TEMPLATE = (
    "{request}\n\n"
    "---\n"
    "【本次角色：Thinker，没有下游 Worker——你的输出直接交给用户】\n"
    "· 要的是**判断**：结论先行，讲清取舍与依据，标明不确定处与前提。\n"
    "· 不要输出待办清单或执行步骤（用户没要计划），不要动手执行任何操作。\n"
    "· 查得到的先自查，别把能查的问题抛回给用户。\n"
    "· 拿不准就说拿不准，并说明需要什么才能定——编一个确定的答案比说不知道更贵。\n"
)

# 计划重申模板（P0-2 降级第 1 级）：首轮计划缺「步骤」段时，在同房间同 Stand 上重申格式。
# 只讲格式、不重述任务——Stand 就在房里，任务上下文它有；重述反而可能让它从头再想一遍。
PLAN_RETRY_TEMPLATE = (
    "你上一条回复没有按要求的结构输出，缺少可直接照做的「步骤」段，Worker 无法执行。\n"
    "请**不要重新思考任务**，就把你刚才的分析重排成下面这个结构再发一次：\n\n"
    "目标：<一句话>\n"
    "上下文：<必要背景>\n"
    "步骤：\n"
    "1. <动作> | 工具或数据：<...> | 产物：<文件路径或『无』>\n"
    "2. <动作> | 工具或数据：<...> | 产物：<...>\n"
    "（继续列出所有步骤，必须是「数字. 」开头的编号行）\n"
    "约束：<口径/红线/边界>\n"
    "完成判据：<什么算 done，尽量可机检>\n"
    "最终产物落点：<绝对路径，或『无』>\n"
)

# 门控信号词（should_plan 用）：命中 PLAN_KEYWORDS 且未强命中 DIRECT_KEYWORDS → 走两段式
# 2026-07-26 强弱分档（提速批件）：plan 是最贵的模式（两段串行，Thinker 段中位 95s+），
# 误入的代价 = 一整个 Thinker 段白烧 + 端到端翻倍。强信号（明说多步/要计划）单独命中
# 即 multi_step；弱信号（设计/调研这类常出现在单步小任务里的词）单个不算数，
# 凑够两个才算——「设计一个脚本存到 X」是单步 worker，不该进两段式。
PLAN_STRONG_KEYWORDS = (
    "分几步", "分阶段", "多步", "计划", "规划", "拆解", "梳理流程",
)
PLAN_WEAK_KEYWORDS = (
    "调研", "研究", "方案", "设计", "架构", "对比", "可行性", "评估",
)
# 兼容旧名：should_plan（保留兼容层）仍按全集判——它的行为刻意不变（见其 docstring）。
PLAN_KEYWORDS = PLAN_STRONG_KEYWORDS + PLAN_WEAK_KEYWORDS
DIRECT_KEYWORDS = (
    "总结", "摘要", "翻译", "转格式", "转成", "改成", "找一下", "查找",
    "下载", "生成这份", "套模板", "格式转换", "提取",
)

# ── 工作模式（docs/work-modes.md，2026-07-26 定版）────────────────────────
# 模式是一等字段：显式传 --mode，落审计（log_audit 的 mode 列），可被直干率审计统计。
#   operator — Caller 自持车道（白名单工具，不派发；由 `caller.py check` 记账）
#   worker   — → Worker：单步、判据明确、交付物是「东西」
#   think    — → Thinker：交付物是「判断」（结论/取舍/评估）；+plan_only 则只出结构化计划
#   plan     — → Thinker → Worker 两段式：多步有依赖，且交付物是「东西」
#   fanout   — → Worker × N 并行：N 个互不依赖的子任务
#   fast     — → 快速 Worker（锚 = areco 设置页 standcode.fastWorker，运行时解析）：单步轻量任务
MODES = ("operator", "worker", "think", "plan", "fanout", "fast")
DISPATCH_MODES = ("worker", "think", "plan", "fanout", "fast")  # run 能派的（operator 不派发）

# route_mode 的两个维度：
#  交付物维度 · 要「判断」——产物是文本结论，不落盘、不改外部系统 → Thinker（模式 4）
JUDGMENT_KEYWORDS = (
    "选哪个", "怎么选", "选型", "该不该", "要不要", "是否", "值不值", "有没有必要",
    "优缺点", "利弊", "取舍", "评估", "复盘", "为什么", "根因", "怎么看",
    "建议", "看法", "判断", "风险", "可行性", "对比", "比较", "分析一下",
)
#  交付物维度 · 要「东西」——落盘或改动文件/外部系统 → 必须有 Worker
#  刻意只收「明确要改动」的复合词：裸「写」「建」「存」太泛（「写点看法」是判断不是东西）。
ARTIFACT_KEYWORDS = (
    "落盘", "存到", "保存到", "生成文件", "写入", "写到", "下载", "导出",
    "转成", "转格式", "套模板", "提取", "翻译成",
    "改代码", "改文件", "改配置", "重构", "修复", "实现", "部署", "提交",
    "跑一下", "执行", "安装", "建目录", "删掉", "清理",
)
#  明确「只要计划、别动手」→ think + plan_only（六段结构化计划，执行另议）
#  刻意不收「分几步」——它在 PLAN_KEYWORDS 里表示「多步依赖」，含义是要做不是别做。
PLAN_ONLY_KEYWORDS = (
    "只要计划", "先出计划", "出个计划", "出份计划", "只规划", "不要执行",
    "先规划", "别动手", "先别做", "只出方案不执行",
)

#  fast 车道（2026-07-27）：明确轻量动词 → 快速 Worker（hy3），省掉 claude 重车的冷启动税。
#  2026-07-30 路由重构后本词表不再参与判定（默认车道已是 fast），只留作 signals 观测。
FAST_KEYWORDS = (
    # 2026-07-27 原轻量动词：查/看/找/翻译/总结/提取…单步轻量任务
    "查一下", "查下", "查看", "看一下", "看下", "找找", "找一下",
    "翻译", "总结", "摘要", "提取", "转成", "改成", "格式化", "确认一下",
    # 2026-07-29 高律师定：搜索/抓取/摘要类轻活也走快速 Worker。
    # 「去取回信息」的单步任务（搜一搜、抓公众号、找资料、调研一下）轻车足够，
    # 省掉重车冷启动税。法律重活词（案件/法院/法条…）见 HEAVY_LAW_KEYWORDS 一票升级。
    "搜", "搜索", "查文章", "抓取", "总结这篇",
    "公众号", "链接", "http", "url", "URL", "找资料", "调研",
)
#  重活车道触发词（2026-07-30 高律师令·路由逻辑重构）：只保留法律词。
#  默认走 fast 快速 Worker，只有法律类任务才走重活主力 Worker——特殊情况=法律。
#  原代码词组（CODE_KEYWORDS：代码/python/git/重构…）与「重量词」（批量/全量/迁移/
#  重构/部署/修复…）及落盘类词（存到/写到/存档…）整组从触发器移除：写代码/跑脚本/
#  git/python 一律默认 fast，flash 也能接。FAST_KEYWORDS 只留作 signals 观测。
HEAVY_LAW_KEYWORDS = (
    "案件", "法院", "文书", "法条", "合同", "核查", "立案", "保全",
    "证据", "判决", "起诉", "答辩", "上诉", "调解",
)


def _now_iso() -> str:
    """当前 UTC 时间 ISO 字符串（完成时间戳用）"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Gatekeeper：派发前置核查（docs/workflow-hardening.md 方案 B）────────────
# Hermes 在微信平台只有 terminal 一个工具——它既是合法派发通道（areco-msg / caller.py），
# 也是非法直干通道（git / grep / curl / python3 ...）。本 Gatekeeper 让 Caller 在动手前
# 先把「任务/命令」过一遍分类，对齐 SKILL.md「禁止直干清单」与「允许直干清单」。
#
# 判定策略（Advisory 软约束，非硬拦；目的是让 Caller「过一遍脑子」）：
#   0) 高危动作优先（HIGH_DANGER_SIGNALS）——即便命令以白名单工具开头，命中 git commit /
#      rm -rf / bootout 等也强制判 production，避免 `caller.py status && git commit` 被放行。
#   1) 命令以白名单工具调用开头（caller.py / areco-msg / cc-send / pgrep / ps aux /
#      launchctl list / hermes-switch-model / echo '收到 / cat .qclaw-hermes）
#      → operator，允许直干（哪怕参数里提到改代码——因为正经派发本身就是对的）。
#   2) 命中生产类信号（PRODUCTION_SIGNALS）→ production，必须派发。
#   3) 灰区 → 保守派发（对齐 SKILL.md「没有『这个简单我自己做』」）。

# 生产类信号：命中即视为 Worker 执行类，Caller 不得直干（必须 dispatch_worker）
PRODUCTION_SIGNALS = (
    # 文件 / 代码变更
    "git commit", "git add", "git push", "git checkout", "git merge", "git rebase",
    "vim ", "nvim ", "code ", "subl ",
    # 代码搜索
    "grep ", "rg ", "find ", "ag ", "ack ",
    # 外部请求
    "curl ", "wget ", "http://", "https://",
    # 代码执行 / 构建（caller.py / areco-msg 例外：以白名单工具开头时不触发）
    "python3", "python ", "pip ", "npm ", "yarn ", "node ",
    # 文件写入
    "sed -i", "echo >", "tee ", "cp ", "mv ", "rm ", "mkdir ", "ln -s", "touch ",
    # 系统配置 / 浏览器操作
    "brew ", "defaults write", "opencli", "open ",
    # 中文语义信号（任务描述里出现也判为生产类）
    "改代码", "写代码", "改文件", "搜索代码", "查找文件", "调研", "下载",
    "格式转换", "生成", "总结", "汇总", "分析", "对比", "实现", "重构",
    "调试", "修复", "部署",
)

# 高危动作：即使命令以白名单工具开头，命中下列任一也强制判 production
HIGH_DANGER_SIGNALS = (
    "git commit", "git push", "git merge", "git rebase", "git reset",
    "rm -rf", "sudo rm", " > /", "dd of=", "mkfs",
    "launchctl bootout", "launchctl load", "launchctl unload",
    "chmod -r", "chown -r",
)

# BLOCKED 红线：不可逆灾难性操作——既不直干、也不派发，dispatch 命中即硬拒绝 + 记审计。
# 与 HIGH_DANGER_SIGNALS（→production，必须派 Worker）刻意区分：BLOCKED 是更高一级的
# 「永远不该自动执行」清单。check_should_dispatch 命中即返回 category="blocked"；
# Gatekeeper 函数本身仍 advisory（只判定不拦），硬拒绝发生在 dispatch()。
#
# 用正则而非朴素子串：`rm -rf /` 必须精确到「根级抹除」，不能误伤 `rm -rf /tmp/junk`
# （后者仍走 HIGH_DANGER → production 派发，行为不变）。故 rm/chmod 模式带边界
# （其后只允许 空白/行尾/*），fork bomb 匹配常见变体。mkfs / dd of= 故意不收入此列——
# 它们已在 HIGH_DANGER_SIGNALS 里走 production，保持原行为不被打破。
_BLOCKED_PATTERNS = (
    re.compile(r"rm\s+-rf\s+/(\s|$)"),          # rm -rf /    抹除根
    re.compile(r"rm\s+-rf\s+/\*(\s|$)"),        # rm -rf /*   抹除根下所有
    re.compile(r"rm\s+-rf\s+~(\s|$)"),          # rm -rf ~    抹除家目录
    re.compile(r"rm\s+-rf\s+~\*(\s|$)"),        # rm -rf ~*   抹除家目录所有
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),  # fork bomb :(){ :|:& };:
    re.compile(r"chmod\s+-r\s+000\s+/(\s|$)"),  # 根级权限锁死（输入已 lower，故 -r）
    re.compile(r"chmod\s+-r\s+000\s+~(\s|$)"),  # 家目录权限锁死
)

# 白名单工具：命令以此开头 → 视为 Caller 正经派发 / 运维（Caller 自身职责）
_OPERATOR_LEADING_TOOLS = (
    "caller.py", "areco-msg", "cc-send", "pgrep", "hermes-switch-model",
)
_OPERATOR_INTERPRETERS = ("python3", "python", "node", "bash", "sh", "zsh")


def _basename(token: str) -> str:
    """取 token 路径末段并去 ./ 前缀（用于识别命令动词）"""
    t = token.rsplit("/", 1)[-1]
    while t.startswith("./"):
        t = t[2:]
    return t


def _is_operator_invocation(text: str) -> tuple[bool, str]:
    """判断 text 是否以白名单工具调用开头（Caller 正经派发 / 运维）。

    返回 (is_operator, matched_signal)。处理前导 env / sudo / 变量赋值；
    支持 `python3 caller.py ...` / `node .../areco-msg.mjs ...` 这类解释器前缀。
    关键：只认「命令动词」是白名单工具，避免把「帮我把 caller.py 重构一下」
    （caller.py 只是句子里的被提及对象）误判为白名单。
    """
    s = (text or "").strip()
    # 去前导 env / sudo / VAR=val
    while True:
        m = re.match(r"^(?:env(?:\s+-\w+)*\s+|sudo\s+|[A-Z_]+=\S+\s+)", s)
        if not m:
            break
        s = s[m.end():]
    if not s:
        return (False, "")
    low = s.lower()
    # 带条件的白名单
    if low.startswith("echo ") and "收到" in s:
        return (True, "echo '收到")
    if low.startswith("cat ") and ".qclaw-hermes" in low:
        return (True, "cat .qclaw-hermes")
    if low.startswith("launchctl list"):
        return (True, "launchctl list")
    if low.startswith("ps aux"):
        return (True, "ps aux")
    # 通用：首个 token（或解释器后第二个 token）是否白名单工具
    tokens = s.split()
    if not tokens:
        return (False, "")
    first = _basename(tokens[0])
    for tool in _OPERATOR_LEADING_TOOLS:
        if first == tool or first.startswith(tool):
            return (True, first)
    if first.lower() in _OPERATOR_INTERPRETERS and len(tokens) > 1:
        second = _basename(tokens[1])
        for tool in _OPERATOR_LEADING_TOOLS:
            if second == tool or second.startswith(tool):
                return (True, second)
    return (False, "")


class ModeConflictError(ValueError):
    """--mode 与旧 --role/--plan/--plan-only/--sub 组合矛盾时抛出（CLI 侧优雅回执）。"""


def resolve_mode(
    mode: str | None = None,
    *,
    role: str | None = None,
    plan: bool = False,
    plan_only: bool = False,
    subs: list[str] | None = None,
) -> dict:
    """把 CLI 参数收敛成唯一的模式决策（docs/work-modes.md P0-1）。

    模式是一等字段，但旧参数 `--role` / `--plan` 得继续能用——本函数是两代参数的
    唯一收敛点：显式 `--mode` 优先，未给则从旧参数推导；矛盾组合直接报错，
    **不做「猜用户想干什么」的静默兜底**（静默兜底会让审计里的 mode 撒谎）。

    参数:
        mode:       显式 --mode，取值见 MODES；None=从旧参数推导
        role:       旧 --role（thinker/worker）
        plan:       旧 --plan（两段式）
        plan_only:  --plan-only（只出结构化计划，不执行）
        subs:       --sub 子任务列表（fanout 用）

    返回:
        {"mode", "plan_only", "role", "subs", "reason", "source"}
        role 为 dispatch() 用的角色；plan/fanout 模式下为 None（由各自流程内部定角色）。
        source = "explicit"（用户显式给了 --mode）| "legacy"（从旧参数推导）

    抛出:
        ModeConflictError — 组合矛盾或 fanout 缺子任务
    """
    subs = [s for s in (subs or []) if (s or "").strip()]

    # ── 显式 --mode ──
    if mode:
        m = mode.strip().lower()
        if m not in MODES:
            raise ModeConflictError(
                f"未知 --mode『{mode}』；可选：{'/'.join(MODES)}"
            )
        # 与旧参数的矛盾组合
        if plan and m != "plan":
            raise ModeConflictError(f"--plan 是 --mode plan 的旧写法，不能与 --mode {m} 并用")
        if role == "thinker" and m not in ("think",):
            raise ModeConflictError(f"--role thinker 与 --mode {m} 矛盾（thinker 对应 --mode think）")
        if role == "worker" and m not in ("worker", "fanout"):
            raise ModeConflictError(f"--role worker 与 --mode {m} 矛盾")
        if plan_only and m != "think":
            raise ModeConflictError(
                f"--plan-only 只用于 --mode think（只出计划不执行）；"
                f"--mode {m} 会执行，两者矛盾"
                + ("。要「先出计划再执行」请用 --mode plan（不加 --plan-only）" if m == "plan" else "")
            )
        if subs and m != "fanout":
            raise ModeConflictError(f"--sub 只用于 --mode fanout；--mode {m} 不拆子任务")
        if m == "fanout" and len(subs) < 2:
            raise ModeConflictError(
                "--mode fanout 需要至少 2 个 --sub 子任务（1 个直接用 --mode worker 即可）"
            )
        return {
            "mode": m,
            "plan_only": bool(plan_only),
            "role": {"think": "thinker", "worker": "worker"}.get(m),
            "subs": subs,
            "reason": f"显式 --mode {m}" + ("（只出计划）" if plan_only else ""),
            "source": "explicit",
        }

    # ── 从旧参数推导 ──
    if plan:
        if plan_only:
            raise ModeConflictError(
                "--plan（两段式，含执行）与 --plan-only（只出计划）矛盾；"
                "要计划就 --plan-only，要执行就 --plan"
            )
        if subs:
            raise ModeConflictError("--sub 只用于 --mode fanout，不能与 --plan 并用")
        return {"mode": "plan", "plan_only": False, "role": None, "subs": [],
                "reason": "旧参数 --plan → mode=plan", "source": "legacy"}
    if subs:
        if role == "thinker":
            raise ModeConflictError("--sub（fanout 派 Worker）与 --role thinker 矛盾")
        if len(subs) < 2:
            raise ModeConflictError("--sub 需要至少 2 个子任务才构成 fanout")
        return {"mode": "fanout", "plan_only": False, "role": None, "subs": subs,
                "reason": f"给了 {len(subs)} 个 --sub → mode=fanout", "source": "legacy"}
    if plan_only:
        if role == "worker":
            raise ModeConflictError("--plan-only（只规划）与 --role worker（只执行）矛盾")
        # --plan-only 单独出现，意图无歧义：要计划 → 提升为 think
        return {"mode": "think", "plan_only": True, "role": "thinker", "subs": [],
                "reason": "--plan-only → mode=think（只出结构化计划）", "source": "legacy"}
    if role == "thinker":
        return {"mode": "think", "plan_only": False, "role": "thinker", "subs": [],
                "reason": "旧参数 --role thinker → mode=think", "source": "legacy"}
    return {"mode": "worker", "plan_only": False, "role": role or "worker", "subs": [],
            "reason": "未指定 → 默认 mode=worker", "source": "legacy"}


class GatekeeperBlockedError(RuntimeError):
    """dispatch 因 Gatekeeper BLOCKED 分级拒绝执行时抛出。

    check_should_dispatch 本身是 advisory（只判定、不拦截）；dispatch 对命中 BLOCKED
    的任务硬拒绝——抛本异常并记审计。调用方（_bg_worker 的 try/except、_cmd_run 前台
    专捕）捕获后优雅降级，不破坏既有正常派发流程。
    """


# ── 审计脱敏（2026-07-26 借 openworker coworker/audit.py 的 _SECRET_KEYS 思路）──
# audit.jsonl 存 request_preview/task_preview 原文——用户消息里贴过的 key 会原样进台账。
# 模式宁多勿少（与 chatlog REDACTION 同哲学）。
_AUDIT_SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9_\-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}"
    r"|glpat-[A-Za-z0-9_\-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._\-]{8,}"
    r"|(?:api[_-]?key|token|secret|password|access[_-]?token)\s*[=:]\s*[^\s'\"，。]{6,})",
    re.IGNORECASE,
)


def _audit_redact(value):
    """字符串字段脱敏；非字符串原样返回。"""
    if isinstance(value, str):
        return _AUDIT_SECRET_RE.sub("***REDACTED***", value)
    return value


# ── 失败码类型化（2026-07-26 借 open-kritt harnesses 的码表 + retryable 位）──
# 此前 status 字符串 + 自由文本 error 混用，重试逻辑只认 'lost'——限流类可重试
# 失败与真异常在审计里不可区分。码表让「哪类失败该自动重派」成为数据而非猜测。
ERROR_CODE_MESSAGES = {
    "timeout": "轮询超时（Stand 未在时限内回话）",
    "lost_session_exited": "Stand 会话已退出",
    "lost_heartbeat": "Stand 心跳超时失联",
    "rate_limited": "模型配额/限流（402/429/quota）",
    "blocked": "Gatekeeper 红线拒绝",
    "mode_conflict": "参数模式矛盾",
    "dispatch_failed": "派发中途失败",
    "error": "未分类异常",
}
# 仅这三类自动重派有意义：换个新 Stand 大概率能好。timeout 不重试（真慢任务重派
# 只会烧双份额度），error 不重试（未知因重试大概率复现）。
RETRYABLE_ERROR_CODES = {"lost_session_exited", "lost_heartbeat", "rate_limited"}
_RATE_LIMIT_RE = re.compile(r"(?:\b402\b|\b429\b|rate.?limit|quota|限流|配额|exceeded)", re.IGNORECASE)


# ── ⑥ 定稿闸：交付物判别（2026-07-29 高律师批）──────────────────────────
# 当日三单实证（任务① 25min / 任务④ 124s / 黎官检索 1167s）：Worker 第一条「开工白」
# 刚落地就被合并窗收网，真结果烂在房里。settle 前先判「像不像交付物」——含 结论段 /
# 产物路径 / 数字结果 之一才算；纯进度句（「我先…」「让我来…」）不算，改走
# PROGRESS_SETTLE_SEC 续等窗。判错代价不对称：进度句误判成交付物 = 回到旧行为
# （MERGE_WAIT_SEC 秒级收网），交付物误判成进度句 = 多等一个续等窗——所以从严认定、
# 默认续等。
_DELIV_CONCLUSION_RE = re.compile(
    r"结论|综上|汇报如下|结果如下|报告如下|已完成|完成情况|交付|验收|产物路径")
_DELIV_PATH_RE = re.compile(r"(?:^|[\s：:（(\"'`「『])(?:/|~/)[\w.~/-]{2,}")
# ≥7 位十六进制且至少一个字母（滤 20260729 这类纯数字日期）——commit hash 即数字结果
_DELIV_HASH_RE = re.compile(r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")
_DELIV_NUMBER_RE = re.compile(
    r"\d+(?:\.\d+)?\s*(?:条|个|份|行|次|案|件|篇|页|元|字|图|秒|%|％)")
_PROGRESS_OPENER_RE = re.compile(
    r"^(?:好的|收到|明白|马上|稍等|我先|我来|我去|让我|正在|开始|接下来|下面我|现在我|先让我)")


def _looks_like_deliverable(text: str) -> bool:
    """Stand 回复合并文本像不像「交付物」（定稿闸门槛，判据见上注释）。"""
    t = (text or "").strip()
    if not t:
        return False
    if (_DELIV_CONCLUSION_RE.search(t) or _DELIV_PATH_RE.search(t)
            or _DELIV_HASH_RE.search(t)):
        return True
    if _PROGRESS_OPENER_RE.match(t) and len(t) < 200:
        return False  # 短开工白：哪怕带数字（「我先花2分钟…」）也算进度句
    if _DELIV_NUMBER_RE.search(t):
        return True
    return len(t) >= 200  # 长正文按交付物放行——纯进度句写不满 200 字


def classify_error_code(status: str, error_text: str = "", lost_reason: str = "") -> str | None:
    """把 (status, 自由文本) 收敛成 ERROR_CODE_MESSAGES 里的码；completed 返回 None。"""
    if status == "completed":
        return None
    text = f"{error_text or ''} {lost_reason or ''}"
    if _RATE_LIMIT_RE.search(text):
        return "rate_limited"
    if status == "lost":
        return "lost_session_exited" if "session_exited" in text else "lost_heartbeat"
    if status in ("timeout", "blocked", "mode_conflict", "dispatch_failed"):
        return status
    return "error"


# ── 机检收口（2026-07-26 借 agentacct 的 Verified / Agent reported 证据分级）──
# PLAN_TEMPLATE 一直要求「完成判据尽量可机检」，但收口从来没人真跑——Worker 说完成
# 就算完成。本函数把可机检的部分真跑一遍，回执按级别标注：
#   verified       全部机检项通过（✅已验证）
#   check_failed   有机检项没过（❌判据未过——Worker 说完成但产物对不上）
#   agent_reported 无可机检项（⚠️自述——不是贬义，是诚实标注证据等级）
def verify_completion(files: list | None = None, output_path: str | None = None) -> dict:
    checks = []
    paths = [str(p) for p in (files or []) if p]
    op = str(output_path or "").strip()
    # plan 的「最终产物落点」可能写「无」；只有像路径的才检
    if op and op not in ("无", "None", "-") and (op.startswith("/") or op.startswith("~")):
        if op not in paths:
            paths.append(op)
    for p in paths:
        try:
            fp = Path(os.path.expanduser(p))
            passed = fp.exists() and (fp.is_dir() or fp.stat().st_size > 0)
        except OSError:
            passed = False
        checks.append({"check": f"file:{p}", "passed": bool(passed)})
    if not checks:
        return {"level": "agent_reported", "checks": [],
                "note": "无可机检判据（未给产物路径）"}
    level = "verified" if all(c["passed"] for c in checks) else "check_failed"
    return {"level": level, "checks": checks}


# ── 作业单验收栏 + 结果把关闸（2026-07-29 批件①，高律师批准）─────────────
# 三份独立评审（GLM 质检 R2 / Fable5 评审 / 飞轮日记篇6+篇10）共同 P0：派出去时
# 验收栏说清「怎么算过」，打回来时强制「差距/锚点/范围」三段式。派单侧
# ensure_acceptance_block 自动补齐两栏（判据/产物路径），回执侧 verify_acceptance
# 把能机检的全验，Caller.gate_result 负责「不过→打回一次→复检→仍不过升级人工」。
# 注：原③红线提醒栏（法条溯源/密钥禁写/回收站/脱敏）2026-07-29 高律师令删除——
# 与 CLAUDE.md 章程重复，每个 Worker 自带章程，验收栏只留任务特异信息。
#
# ── 验收闸总开关（2026-07-29 高律师令：验收闸整体关停）──────────────────
# 判据提取当日三次误伤（正文枚举误判路径 / 顿号连路径 / 自报带「」节名），
# 高律师令整个关掉。开关常量化不删死：False 时——
#   · 验收栏两栏仍照常追加（信息价值还在），只是不再机检、不打回、不升级，结果直报；
#   · dispatch_and_relay 的 gate_result 把关闸整段跳过；
#   · _finalize_waiter 的验收判据机检跳过，回执如实标注「闸停未机检」。
# 判据提取/机检/打回/升级逻辑全部保留，重开改 True 即可（同三闸先例）。
ACCEPTANCE_GATE_ENABLED = False
ACCEPT_HEADER = "【作业单·验收栏】"
# Worker 完工自报产物路径的格式约定——verify_acceptance 按它反向机检自报文件
ACCEPT_SELF_REPORT = "完工回复末尾单列一行「产物路径：/绝对路径」；纯分析/问答类无产物则写「产物路径：无」并给出结论与依据。"
# 机检判据 DSL 行（可写在作业单或验收栏里，一行一条）：
#   file:/绝对路径              → 文件存在且非空（目录算过）
#   file_contains:/路径:关键词   → 文件存在且含关键词
#   result_contains:关键词       → Worker 回复正文含关键词
#   commit:/仓库路径             → 回复里报的 commit hash 真实存在于该仓库
_CRIT_DSL_RE = re.compile(r"^(file_contains|result_contains|file|commit)\s*[:：]\s*(.+)$")
_CRIT_OUTPUT_RE = re.compile(r"^产物路径\s*[:：]\s*(.+?)\s*$")
# 产物路径行的多路径分隔符：顿号/分号/逗号（全半角）。五个路径顿号连成一串时逐个
# 拆成独立判据、独立校验——禁止把整行当成一个路径（2026-07-29 高律师令）。
_PATH_SPLIT_RE = re.compile(r"[、；;，,]")


def _output_paths(value: str) -> list[str]:
    """「产物路径：」的值 → 独立路径列表。只认 / 或 ~ 开头的绝对路径；「无/None/-」不算。"""
    out: list[str] = []
    for piece in _PATH_SPLIT_RE.split(value or ""):
        p = piece.strip().strip("`'\"")
        if p and p not in ("无", "None", "-") and (p.startswith("/") or p.startswith("~")):
            out.append(p)
    return out


# commit hash 候选：≥7 位十六进制且至少含一个字母（滤掉 20260729 这类纯数字日期）
_COMMIT_HASH_RE = re.compile(r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")


def _criteria_from_text(text: str, origin: str = "explicit") -> list[dict]:
    """扫一段文本，抽出全部可机检判据。

    只认两路显式声明（2026-07-29 高律师令·验收闸去机械化）：
    ① DSL 行（file:/file_contains:/result_contains:/commit:）
    ② 「产物路径：/xxx」行（顿号/分号分隔的多个路径逐个拆成独立判据）。
    正文其他内容一律不提取为判据——原「落盘动词后绝对路径 → file 判据」自动提取
    把任务书正文的中文枚举（顿号并列的工具名/一串路径）误判成机检目标，造成
    假打回+假升级（2026-07-29 两次实测笑话），已删。提取不到就标无可机检判据
    转人工（agent_reported），不许瞎猜。
    返回 [{"kind","arg","raw","origin"}]，按出现序去重。
    """
    crits: list[dict] = []
    seen: set[str] = set()

    def add(kind: str, arg: str, raw: str, org: str) -> None:
        arg = arg.strip().strip("`'\"").rstrip("。.，,；;")
        if kind in ("file", "commit"):
            # 剥掉尾部全角括号注释（本模板自己就写「file:/x（文件存在且非空）」，
            # 回环解析时注释不能混进路径；半角括号可能是文件名一部分，不动）
            arg = re.sub(r"（[^）]*）\s*$", "", arg).rstrip()
        key = f"{kind}:{arg}"
        if not arg or key in seen:
            return
        seen.add(key)
        crits.append({"kind": kind, "arg": arg, "raw": raw.strip(), "origin": org})

    for raw in (text or "").splitlines():
        s = raw.strip().lstrip("-·*•").strip()
        # checkbox / 编号前缀（"[ ] 1. file:…" / "1、file:…"）剥掉再匹配
        s = re.sub(r"^(?:\[[ xX✓]?\]\s*)?(?:\d+[.、）)]\s*)?", "", s)
        m = _CRIT_DSL_RE.match(s)
        if m:
            add(m.group(1), m.group(2), s, "explicit")
            continue
        m = _CRIT_OUTPUT_RE.match(s)
        if m:
            for p in _output_paths(m.group(1)):
                add("file", p, s, "explicit")
    return crits


def extract_acceptance(request: str) -> dict:
    """只解析不改写：从作业单文本里提取验收信息（plan 模式与收尾复核用）。

    返回 {"criteria": [...], "source": "explicit"|"default"}——
    explicit=用户自己写了判据/验收段/产物路径；default=什么都没抽到
    （验收只能靠 Worker 完工自报产物路径反向机检，仍抽不到 → 无可机检判据转人工）。
    """
    req = request or ""
    crits = _criteria_from_text(req)
    has_section = bool(re.search(r"验收判据|验收标准|完成判据|验收栏", req)) or ACCEPT_HEADER in req
    if has_section or crits:
        source = "explicit"
    else:
        source = "default"
    return {"criteria": crits, "source": source}


def ensure_acceptance_block(request: str) -> tuple[str, dict]:
    """派单前把「验收栏」两栏补进作业单（幂等）：①验收判据（可机检优先）②产物路径。

    红线提醒栏已于 2026-07-29 高律师令删除（与 CLAUDE.md 章程重复，Worker 自带章程，
    验收栏只留任务特异信息）。用户已写的栏目不重复追加、原文不动；缺哪栏补哪栏；
    已带 ACCEPT_HEADER 直接原样返回（防 bg 回放 / 重派发二次追加）。
    返回 (request', acceptance)。
    """
    req = (request or "").rstrip()
    acceptance = extract_acceptance(req)
    if ACCEPT_HEADER in req:
        acceptance["block_appended"] = False
        return req, acceptance

    # 话术整洁（2026-07-30 P1P2 施工附加项）：闸停态下「验收闸已关停，不机检不打回」是
    # 内部机制史，Worker 只需要行为指令——收敛为「完工按此交付，结果直报」；闸开警示不变
    lines = ["", f"——{ACCEPT_HEADER}（Caller 自动追加，完工按此交付"
                 + ("，机检不过会被打回" if ACCEPTANCE_GATE_ENABLED else "，结果直报")
                 + "）——"]
    crits = acceptance["criteria"]
    if acceptance["source"] != "explicit":
        lines.append("验收判据" + ("（能机检的会逐条真跑）：" if ACCEPTANCE_GATE_ENABLED
                                  else "（交付约定）："))
        if crits:
            for i, c in enumerate(crits, 1):
                lines.append(f"{i}. {c['kind']}:{c['arg']}（文件存在且非空）")
            lines.append(f"{len(crits) + 1}. {ACCEPT_SELF_REPORT}")
        else:
            lines.append(f"1. {ACCEPT_SELF_REPORT}")
    prestated = {c["arg"] for c in crits}
    lines.append(
        "产物路径：" + ("；".join(sorted(prestated)) if prestated
                     else ("完工自报（格式见上；报了路径就会被机检）" if ACCEPTANCE_GATE_ENABLED
                           else "完工自报（格式见上）"))
    )
    acceptance["block_appended"] = True
    return req + "\n" + "\n".join(lines), acceptance


# ── 委派基础设施说明（2026-08-02 多向派发 + memory/chatlog 统一基础设施）──────
# 每单投递给 Stand 的任务尾部注入一段「委派说明」，三件事：
#   ① 告知委派人与派发深度——Stand 转派子任务时带 --depth +1，深度闸才有依据；
#   ② 把统一记忆（memory skill）与对话史（chatlog skill）的用法送到每个 Stand 眼前——
#      「所有 agent 会用基础设施」不靠各 agent 记住，靠每单任务书自带；
#   ③ 首行含「委派」二字，命中 areco room-relay 的 DELEGATION_RE（owner|交付物|
#      验收口径|写集|交接路径|委派）——非 Hermes 派发（human_relay=0）也照样触发
#      auto-recall 记忆注入，零 areco 改动。
# 幂等（重派/bg 回放不叠加）；STANDCODE_INFRA_NOTE=off / local.json infra_note=false 可关。
INFRA_NOTE_ENABLED = _conf_bool("STANDCODE_INFRA_NOTE", "infra_note", True)
INFRA_NOTE_HEADER = "StandCode 委派说明"
SC_BIN = os.environ.get("STANDCODE_SC_BIN") or _LOCAL_CONF.get("sc_bin") or "/Users/gao/bin/sc"
_MEMORY_SCRIPTS_DIR = (
    os.environ.get("STANDCODE_MEMORY_SCRIPTS")
    or _LOCAL_CONF.get("memory_scripts_dir")
    or "/Users/gao/skills/memory/scripts"
)
_CHATLOG_MCP = (
    os.environ.get("STANDCODE_CHATLOG_MCP")
    or _LOCAL_CONF.get("chatlog_mcp")
    or "/Users/gao/skills/chatlog/mcp_server.py"
)


def ensure_infra_note(request: str, depth: int | None = None) -> str:
    """任务书尾部追加「委派说明」段（幂等）。depth 缺省取进程级 DISPATCH_DEPTH。"""
    req = (request or "").rstrip()
    if not INFRA_NOTE_ENABLED or not req or INFRA_NOTE_HEADER in req:
        return req
    d = DISPATCH_DEPTH if depth is None else max(0, int(depth))
    can_fork = d + 1 < MAX_DISPATCH_DEPTH
    lines = [
        "",
        f"——{INFRA_NOTE_HEADER}（自动注入）——",
        f"· 委派人：{CALLER_NAME}；本单派发深度：{d}。完成后直接在本会话回复结论，文件产物写绝对路径。",
    ]
    if can_fork:
        lines.append(
            f"· 需要拆活转派子任务时（禁转述本说明段）：{SC_BIN} go \"<子任务>\" "
            f"--caller \"<你的成员名>\" --depth {d + 1}"
        )
    else:
        lines.append(f"· 本单深度已达上限（{MAX_DISPATCH_DEPTH}），不得再转派子任务——亲自完成或回报拆分建议。")
    lines += [
        f"· 跨 agent 长期记忆：查 python3 {_MEMORY_SCRIPTS_DIR}/recall.py \"<关键词>\"；"
        f"跨 agent 应知的新结论用 add_memory.py --kind fact --claim/--evidence/--source 沉淀（同目录）。",
        f"· 查历史对话（本机全部 agent 会话）：python3 {_CHATLOG_MCP} \"<关键词>\" 6",
    ]
    return req + "\n" + "\n".join(lines)


def _check_file_criterion(path: str) -> tuple[bool, str]:
    """file 判据：存在且非空（目录算过）。与 verify_completion 同口径。"""
    try:
        fp = Path(os.path.expanduser(path))
        if not fp.exists():
            return False, "文件不存在"
        if fp.is_dir():
            return True, "目录存在"
        size = fp.stat().st_size
        return (size > 0), (f"{size} 字节" if size > 0 else "文件为空（0 字节）")
    except OSError as e:
        return False, f"无法访问: {e}"


def _run_criterion(kind: str, arg: str, result_text: str) -> tuple[bool, str]:
    """跑一条机检判据，返回 (passed, detail)。未知 kind 按不过处理（fail-closed）。"""
    if kind == "file":
        return _check_file_criterion(arg)
    if kind == "file_contains":
        path, _, needle = arg.partition(":")
        if not needle:
            return False, "格式应为 file_contains:/路径:关键词"
        ok, detail = _check_file_criterion(path)
        if not ok:
            return False, detail
        try:
            content = Path(os.path.expanduser(path)).read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            return False, f"读取失败: {e}"
        return (needle in content), ("含关键词" if needle in content else f"文件不含「{needle[:40]}」")
    if kind == "result_contains":
        hit = arg in (result_text or "")
        return hit, ("回复含关键词" if hit else f"回复不含「{arg[:40]}」")
    if kind == "commit":
        repo = os.path.expanduser(arg)
        if not Path(repo).is_dir():
            return False, f"仓库目录不存在: {arg}"
        hashes = _COMMIT_HASH_RE.findall(result_text or "")[:20]
        for h in hashes:
            try:
                r = subprocess.run(
                    ["git", "-C", repo, "cat-file", "-e", f"{h}^{{commit}}"],
                    capture_output=True, timeout=10,
                )
                if r.returncode == 0:
                    return True, f"commit {h} 在仓库中真实存在"
            except Exception:
                continue
        return False, ("回复未报 commit hash" if not hashes
                       else f"回复报的 hash（{hashes[0]}…）不在仓库 {arg}")
    return False, f"未知判据类型 {kind}"


def verify_acceptance(
    acceptance: dict | None,
    result_text: str = "",
    files: list | None = None,
    output_path: str | None = None,
) -> dict:
    """判据机检（verify_completion 的验收栏升级版）：作业单判据 + Worker 自报产物路径
    + 旧口径 files/output_path 全跑一遍。返回形状与 verify_completion 兼容
    （level/checks），另带 criteria_source / attempts / bounced / escalated 供把关闸回填。
    """
    acc = acceptance or {}
    crits = [dict(c) for c in (acc.get("criteria") or []) if isinstance(c, dict)]
    # Worker 完工自报的「产物路径：/xxx」也算它给出的机检承诺——报了就要对得上。
    # 2026-07-29 高律师令：自报只认「产物路径：」行，逐路径独立校验；回复正文
    # 其他内容（含 DSL 字样、落盘动词）一律不提取为判据，提取不到转人工不瞎猜。
    for raw in (result_text or "").splitlines():
        s = raw.strip().lstrip("-·*•").strip()
        m = _CRIT_OUTPUT_RE.match(s)
        if m:
            for p in _output_paths(m.group(1)):
                crits.append({"kind": "file", "arg": p, "raw": s, "origin": "self_report"})
    checks: list[dict] = []
    seen: set[str] = set()
    for c in crits:
        key = f"{c.get('kind')}:{c.get('arg')}"
        if key in seen:
            continue
        seen.add(key)
        passed, detail = _run_criterion(str(c.get("kind")), str(c.get("arg")), result_text)
        checks.append({"check": key, "passed": bool(passed), "detail": detail,
                       "origin": c.get("origin", "")})
    # 旧口径（--file / plan 最终产物落点）并入，不与判据重复
    legacy = verify_completion(files=files, output_path=output_path)
    for ch in legacy.get("checks", []):
        if ch["check"] not in seen:
            seen.add(ch["check"])
            checks.append(ch)
    source = acc.get("source") or "none"
    if not checks:
        note = ("Worker 自报「产物路径：无」，无可机检判据" if "产物路径" in (result_text or "")
                else "无可机检判据（判据未给出机检格式，产物路径也未自报）")
        return {"level": "agent_reported", "checks": [], "criteria_source": source, "note": note}
    level = "verified" if all(c["passed"] for c in checks) else "check_failed"
    return {"level": level, "checks": checks, "criteria_source": source}


def build_rejection_message(verification: dict, attempt: int = 1) -> str:
    """三段式打回话术（强制结构：差距/锚点/修改范围，禁「再改改」式零信息反馈）。"""
    failed = [c for c in (verification or {}).get("checks", []) if not c.get("passed")]
    lines = [
        f"❌【验收未过·打回第 {attempt} 次】你自称完成，但机检判据未过。按下面三段补齐，"
        "不接受「已完成/已修复」式空回复。",
        "一、差距（机检实测，不是感觉）：",
    ]
    for c in failed:
        lines.append(f"  · {c['check']} —— {c.get('detail') or '未通过'}")
    lines.append("二、锚点（对着这些落点改）：")
    for c in failed:
        kind, _, arg = c["check"].partition(":")
        lines.append(f"  · {arg}（判据类型 {kind}）")
    lines.append(
        "三、修改范围：只补上述未过项，已过的部分不要动、不要重写整份回复。"
        "补完后回复每条未过判据的落实证据（产物绝对路径 / commit hash / 关键输出原文），"
        "末尾单列一行「产物路径：/绝对路径」。"
    )
    return "\n".join(lines)


def _audit_is_stub(r: dict) -> bool:
    """审计条目是否测试桩痕迹（thinker-tpl/worker-tpl 假模板、room0 类假房号）。

    历史包袱：2026-07-25/26 的离线测试没隔离 STANDCODE_AUDIT_LOG，167 条桩事件混进
    生产 audit.jsonl——报表一度显示「派发 182 单 / plan 78 / 降级 23」，真实只有 15 单
    且零 plan。测试文件已加环境隔离（见 test_*.py 头部 _TEST_ISO），本过滤器在读取侧
    兜住既有脏数据与未来漏网；audit.jsonl 本身 append-only 不回改。
    """
    t = str(r.get("template") or "")
    rid = str(r.get("room_id") or "")
    return t.endswith("-tpl") or bool(re.fullmatch(r"room\d{0,4}", rid))


def log_audit(event: str, detail: dict | None = None) -> None:
    """审计日志：每行一条 JSON 追加写入 AUDIT_LOG_PATH（默认 /tmp/standcode-audit.jsonl）。

    固定字段：timestamp / event / mode / task_id / role / template / blocked；
    detail 中的其余字段（reason / room_id / verdict 等）透传追加，便于追溯。
    写入失败只 warning、永不抛——审计不得阻塞主流程。

    `mode` 是工作模式一等字段（docs/work-modes.md P0-1）：operator / worker / think /
    plan / fanout。有了它，直干率审计（scripts/audit-direct-work.py）就从「猜哪些
    terminal 调用算直干」变成「数 mode 分布」——可数，而不是可估。
    poll_* 事件不单独带 mode（同一 task_id 可 join 到它的 dispatch 行，不重复存）。

    参数:
        event:  事件名（如 "dispatch" / "dispatch_blocked" / "gatekeeper_check" /
                "poll_completed" / "poll_lost" / "poll_timeout"）
        detail: 审计上下文；至少应含 task_id / role / template / blocked，
                其余键原样并入记录。
    """
    d = detail or {}
    record = {
        "timestamp": _now_iso(),
        "event": event,
        # 多向派发（2026-08-02）：每条审计带派发身份——直干率/派发量统计按 caller 可分维
        "caller": d.get("caller") or CALLER_NAME,
        "mode": d.get("mode", ""),
        "task_id": d.get("task_id", ""),
        "role": d.get("role", ""),
        "template": d.get("template", ""),
        "blocked": bool(d.get("blocked", False)),
    }
    # 透传其余 detail 字段（reason / category / room_id / elapsed …），不覆盖固定字段
    for k, v in d.items():
        if k not in record:
            record[k] = v
    # 全字段脱敏（用户消息原文进 preview 字段，贴过的 key 不能进台账）
    record = {k: _audit_redact(v) for k, v in record.items()}
    try:
        with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning("审计日志写入失败 event=%s: %s", event, e)


# ── 额度/限流信号扫描与处置（2026-07-29 GLM 额度打满事件，高律师令）─────────────
# "429" 单独加边界保护：裸子串会把「第429条/第429号」（法条引用，本所场景高频）
# 误判成限流——要求前后不接数字、也不接 第/条/号。
_QUOTA_429_RE = re.compile(r"(?<![\d第])429(?![\d条号])")


def quota_signal_hit(text: str) -> str | None:
    """扫描 Stand 输出是否命中额度/限流信号词，命中返回该词，否则 None。

    大小写不敏感子串匹配（词表 QUOTA_SIGNAL_WORDS，可按需扩充）。
    """
    if not text:
        return None
    lower = text.lower()
    for w in QUOTA_SIGNAL_WORDS:
        if w == "429":
            if _QUOTA_429_RE.search(text):
                return w
        elif w.lower() in lower:
            return w
    return None


def _read_stand_stop() -> dict:
    try:
        data = json.loads(STAND_STOP_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def handle_quota_hit(stand_id: str, hit_word: str, source: str,
                     sample: str = "", dry_run: bool = False) -> dict:
    """额度/限流命中处置（2026-07-29 机制）：停新单 → 车道改道 → 微信告警 → 事件落账。

    a. stand 标停新单：写 STAND_STOP_PATH（幂等——已在册只补命中记录，不重复告警）；
    b. 涉及车道改道：LANE_FALLBACK_MAP 有备胎则改道（Caller 下次加载生效，
       见 _apply_lane_reroutes）；
    c. 微信告警高律师：cc-send 直发（WECHAT_TARGET 未配置则跳过并记录）；
    d. 事件追加 StandCode SKILL.md「额度事件台账」+ 审计日志。
    全程 fail-open：任何一步异常只记日志，不阻断 caller 主流程。
    """
    stand_id = (stand_id or "unknown").strip() or "unknown"
    fallback = LANE_FALLBACK_MAP.get(stand_id)
    actions: list[str] = []

    # a. 停新单（幂等：已停只补一条命中记录）
    already = False
    try:
        state = _read_stand_stop()
        entry = state.get(stand_id)
        already = bool(isinstance(entry, dict) and entry.get("stopped"))
        if not isinstance(entry, dict):
            entry = {"stopped": True, "stopped_at": _now_iso(),
                     "reason": f"命中额度/限流信号「{hit_word}」", "hits": []}
        entry.setdefault("hits", []).append(
            {"at": _now_iso(), "word": hit_word, "source": source,
             "sample": (sample or "")[:120]})
        state[stand_id] = entry
        STAND_STOP_PATH.parent.mkdir(parents=True, exist_ok=True)
        STAND_STOP_PATH.write_text(
            json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        actions.append("停新单已登记" if not already else "已在停新单册（补命中记录）")
    except Exception as e:
        logger.warning("停新单状态写入失败 stand=%s: %s", stand_id, e)
        actions.append(f"停新单登记失败: {e}")

    # b. 车道改道（备胎表有映射才动作；实际改道在 Caller 加载时生效）
    if fallback:
        actions.append(f"车道改道 {stand_id} → {fallback}（下次 Caller 加载生效）")
    else:
        actions.append("备胎表无映射，仅停新单不改道")

    # c. 微信告警（同一 stand 只告警一次，避免 poll 每轮刷屏）
    alerted = False
    if not already and not dry_run:
        msg = (f"🚨 Stand 额度/限流告警：{stand_id} 命中「{hit_word}」（{source}）。"
               f"已自动停新单" + (f"，涉及车道改道 {fallback}。" if fallback else "。")
               + f"样本：{(sample or '')[:80]}")
        if not WECHAT_TARGET:
            logger.warning("WECHAT_TARGET 未配置，额度告警未发（stand=%s）", stand_id)
            actions.append("微信告警跳过（WECHAT_TARGET 未配置）")
        else:
            try:
                proc = subprocess.run(
                    [CC_SEND_BIN, "-s", WECHAT_TARGET, "-m", msg],
                    capture_output=True, text=True, timeout=15,
                    env={**os.environ, "HOME": HOME_DIR,
                         "PATH": f"{HOME_DIR}/.npm-global/bin:{os.environ.get('PATH', '')}"},
                )
                alerted = proc.returncode == 0
                actions.append("微信告警已发" if alerted
                               else f"微信告警失败 rc={proc.returncode}")
            except Exception as e:
                logger.warning("额度告警发送异常 stand=%s: %s", stand_id, e)
                actions.append(f"微信告警异常: {e}")

    # d. 事件落账：SKILL.md 台账 + 审计日志（失败均不阻断）
    try:
        line = (f"- {_now_iso()[:16]} stand `{stand_id}` 命中「{hit_word}」（{source}）→ "
                f"停新单" + (f"，车道改道 `{fallback}`" if fallback else "")
                + ("，已微信告警" if alerted else "") + "\n")
        with open(STANDCODE_SKILL_MD, "a", encoding="utf-8") as f:
            f.write(line)
        actions.append("SKILL.md 台账已追加")
    except Exception as e:
        logger.warning("SKILL.md 台账追加失败: %s", e)
    log_audit("quota_hit", {
        "template": stand_id, "blocked": False, "hit_word": hit_word,
        "source": source, "fallback": fallback or "", "alerted": alerted,
        "already_stopped": already, "actions": "; ".join(actions),
    })
    return {"stand": stand_id, "hit": hit_word, "fallback": fallback,
            "alerted": alerted, "already_stopped": already, "actions": actions}


def check_should_dispatch(task_description: str) -> dict:
    """Gatekeeper：判断一个任务 / 命令是否必须派发给 Worker（而非 Caller 直干）。

    对齐 SKILL.md「禁止直干清单」+ docs/workflow-hardening.md 方案 B。
    Caller（Hermes）在用 terminal 做任何非派发操作前，应先调用本函数核查：

        should_dispatch=True  → 必须 dispatch_worker，不得直干；
        should_dispatch=False → Caller 职责内（派发 / 状态 / 回执），允许直干。

    判定顺序：
        0. BLOCKED 红线（rm -rf / / mkfs / dd of=/dev/ …）→ blocked，拒绝执行
        1. 高危动作（git commit / rm -rf / bootout…）→ production（即便以白名单开头）
        2. 以白名单工具调用开头                    → operator，允许直干
        3. 命中生产类信号                         → production，必须派发
        4. 其余灰区                              → 保守派发

    BLOCKED 分级本身是 advisory（只判定、不拦截）——本函数无副作用、不抛异常；
    硬拒绝发生在 dispatch()：production 类任务（BLOCKED 隐含 production 级危险）
    命中即 raise GatekeeperBlockedError + 记审计。

    参数:
        task_description: 任务描述或即将执行的 terminal 命令（自然语言或命令行均可）

    返回:
        {
            "should_dispatch": bool,   # blocked 时为 False（既不直干也不派发）
            "category": "blocked" | "operator" | "production" | "gray",
            "blocked": bool,           # 仅 blocked 分级为 True，其余恒 False
            "reason": str,             # 命中依据 / 判定理由
            "suggested_action": str,
        }
    """
    text = (task_description or "").strip()
    if not text:
        return {
            "should_dispatch": True,
            "category": "gray",
            "blocked": False,
            "reason": "空任务描述；按保守原则默认派发",
            "suggested_action": "dispatch_worker(明确任务后再派)",
        }
    low = text.lower()

    # 0) BLOCKED 红线优先：不可逆灾难性操作 → 既不直干也不派发，dispatch 硬拒
    for pat in _BLOCKED_PATTERNS:
        if pat.search(low):
            return {
                "should_dispatch": False,
                "category": "blocked",
                "blocked": True,
                "reason": f"命中 BLOCKED 红线『{pat.pattern}』——不可逆灾难性操作，拒绝执行",
                "suggested_action": "拒绝（Gatekeeper advisory：仅判定；dispatch 会硬拒并记审计）",
            }

    # 1) 高危动作：即使以白名单工具开头也强制派发
    for sig in HIGH_DANGER_SIGNALS:
        if sig in low:
            return {
                "should_dispatch": True,
                "category": "production",
                "blocked": False,
                "reason": f"命中高危动作『{sig.strip()}』——必须派 Worker，不得直干",
                "suggested_action": "dispatch_worker(task_type=按内容选, request='...')",
            }

    # 2) 以白名单工具调用开头 → operator，允许直干
    is_op, op_sig = _is_operator_invocation(text)
    if is_op:
        return {
            "should_dispatch": False,
            "category": "operator",
            "blocked": False,
            "reason": f"命令以白名单工具『{op_sig}』调用开头——Caller 职责内，允许直干",
            "suggested_action": "直接执行（属于 Caller 自身职责）",
        }

    # 3) 命中生产类信号 → 必须派发
    for sig in PRODUCTION_SIGNALS:
        if sig.lower() in low:
            return {
                "should_dispatch": True,
                "category": "production",
                "blocked": False,
                "reason": f"命中禁止直干清单（生产类）『{sig.strip()}』——必须派 Worker",
                "suggested_action": "dispatch_worker(task_type=按内容选, request='...')",
            }

    # 4) 灰区：保守派发（避免直干）
    return {
        "should_dispatch": True,
        "category": "gray",
        "blocked": False,
        "reason": "未命中白名单也未命中明确生产信号；按保守原则派发，避免直干",
        "suggested_action": "dispatch_worker（确属纯内部运维且不可派时，Caller 可直干但需先自问 3 秒）",
    }


# ── 心跳工具（建议 4·会话可靠性）──────────────────────────────────
# 心跳键统一用 stand_session_id：Stand 宿主进程知道自己的 session id，可据此写文件；
# task_id 是 Caller 内部生成、Stand 侧无从得知，作心跳键会让「Stand 写、Caller 读」
# 永远对不上。任务原文写 {task_id}.hb，这里改成 {session_id}.hb 才能闭环。
def _room_label(request: str, summary: str | None, role: str) -> str:
    """新建房间名：来源标记 + 任务摘要 + 角色单字母 + 4 位 hex。

    2026-07-25 用户报障（一）：areco 项目边栏清一色 Stand-worker-general-xxx，截断后零识别度。
    边栏截断保留的是前缀，所以摘要必须放最前；summary 缺省时取 request 前 16 字兜底。
    2026-07-25 用户报障（二）：只剩任务语义后，派发房与人手建的案件房无从分辨。
    补一个单字符 ROOM_MARK 打头——占 1 字宽、扛得住截断，语义仍在后面完整可读：
        ⚙房源纠纷调研…·W1a2b
    机器侧不靠名字认（用户随时能改名），认 ROOMS_LEDGER 台账；名字只服务人眼。
    """
    text = " ".join((summary or request or "").split())
    label = text[:16] + ("…" if len(text) > 16 else "")
    tag = "T" if role == "thinker" else "W"
    # 多向派发（2026-08-02）：非 Hermes 派的房带来源标，看板一眼可辨谁派的。
    # 标记紧跟 ROOM_MARK 之后（边栏截断保留前缀）；机器侧仍认台账不认名字。
    src = f"[{CALLER_NAME}]" if CALLER_NAME != "Hermes" else ""
    return f"{ROOM_MARK}{src}{label or 'Stand'}·{tag}{uuid.uuid4().hex[:4]}"


# ── 房间台账（append-only jsonl）─────────────────────────────────────
# 一行一事件：{"ts", "event", "room_id", ...}。读取时按 room_id 折叠、后写覆盖前写，
# 所以并发派发只追加、永不丢更新。event 取值：
#   created  = StandCode 新建了这个房间
#   adopted  = 历史房间被 `rooms --adopt` 认领进台账（补台账，不改房间本身）
#   archived = 已归档（自动收口或 sweep）
#   kept     = 收口时决定留在看板（失败/超时/复用房间/开关关闭），带 reason
_LEGACY_ROOM_RE = re.compile(r"^Stand-(worker|thinker)-")
_ROOM_TAIL_RE = re.compile(r"·[TW][0-9a-f]{4}$")


def ledger_append(event: str, room_id: str, **fields) -> None:
    """追加一条房间台账。台账是辅助设施，写失败只告警不影响主链。"""
    if not room_id:
        return
    fields.setdefault("caller", CALLER_NAME)  # 多向派发：台账记谁派的房
    rec = {"ts": _now_iso(), "event": event, "room_id": room_id, **fields}
    try:
        ROOMS_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        with ROOMS_LEDGER_PATH.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except OSError as e:
        logger.warning("房间台账写入失败 %s: %s", ROOMS_LEDGER_PATH, e)


# ── 模板健康闸（2026-07-28 A3）────────────────────────────────────
# 状态文件 ~/.standcode/unhealthy.json：{template_id: {"failures": n, "last_error": str,
# "until": epoch}}。读写全部 try/except 兜底——健康闸是辅助设施，绝不能影响派发主链。

def _read_unhealthy() -> dict:
    """读模板黑名单。文件不存在/损坏一律当空。"""
    try:
        d = json.loads(UNHEALTHY_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_unhealthy(d: dict) -> None:
    try:
        UNHEALTHY_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = UNHEALTHY_PATH.with_name(UNHEALTHY_PATH.name + ".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(UNHEALTHY_PATH)
    except Exception as e:
        logger.warning("模板黑名单写入失败（不影响派发）: %s", e)


def unhealthy_until(tpl: str) -> float:
    """模板隔离截止 epoch；0 = 未隔离（until 过期自动视为恢复）。"""
    if not tpl:
        return 0.0
    ent = _read_unhealthy().get(tpl) or {}
    try:
        until = float(ent.get("until") or 0)
    except (TypeError, ValueError):
        return 0.0
    return until if until > time.time() else 0.0


def template_mark_failure(tpl: str, err) -> None:
    """记一次模板连续失败；达 UNHEALTHY_FAIL_LIMIT 即隔离 UNHEALTHY_TTL_SEC 秒。"""
    if not tpl:
        return
    try:
        d = _read_unhealthy()
        ent = d.get(tpl) or {}
        failures = int(ent.get("failures") or 0) + 1
        rec = {"failures": failures, "last_error": str(err)[:300],
               "until": ent.get("until") or 0}
        if failures >= UNHEALTHY_FAIL_LIMIT:
            rec["until"] = time.time() + UNHEALTHY_TTL_SEC
            logger.warning("模板『%s』连续失败 %d 次，隔离 %.0f 分钟（last_error: %s）",
                           tpl, failures, UNHEALTHY_TTL_SEC / 60, err)
        d[tpl] = rec
        _write_unhealthy(d)
    except Exception as e:
        logger.warning("模板黑名单记录失败（不影响派发）: %s", e)


def template_mark_success(tpl: str) -> None:
    """模板成功一次即清除黑名单记录（连续失败计数归零）。"""
    if not tpl:
        return
    try:
        d = _read_unhealthy()
        if tpl in d:
            d.pop(tpl, None)
            _write_unhealthy(d)
    except Exception as e:
        logger.warning("模板黑名单清除失败（不影响派发）: %s", e)


def _parse_iso_ts(s: str | None) -> float | None:
    """_now_iso 产出的 "%Y-%m-%dT%H:%M:%SZ" → epoch；解析失败 None。"""
    try:
        return datetime.strptime(s or "", "%Y-%m-%dT%H:%M:%SZ") \
            .replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def _norm_request(text: str) -> str:
    """重复派发闸（A2）的 request 规范化：去全部空白 + lower。

    验收栏（2026-07-29 批件①）是 Caller 附加的样板、不是用户意图：比对前剥掉，
    否则改动前落盘的旧 state（原文）对上新派发（已追加验收栏）会漏判重复。
    """
    t = text or ""
    i = t.find(ACCEPT_HEADER)
    if i != -1:
        j = t.rfind("\n", 0, i)  # 追加块从行首剥（行首带「——」装饰）
        t = t[: j if j != -1 else i]
    return "".join(t.split()).lower()


def ledger_load() -> dict:
    """读台账并按 room_id 折叠成 {room_id: 合并后的记录}（后写覆盖前写）"""
    merged: dict[str, dict] = {}
    if not ROOMS_LEDGER_PATH.exists():
        return merged
    try:
        lines = ROOMS_LEDGER_PATH.read_text().splitlines()
    except OSError as e:
        logger.warning("房间台账读取失败 %s: %s", ROOMS_LEDGER_PATH, e)
        return merged
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue  # 半行/脏行跳过：append-only 下最多损失最后一条
        rid = rec.get("room_id")
        if not rid:
            continue
        cur = merged.setdefault(rid, {"room_id": rid})
        cur.update({k: v for k, v in rec.items() if v is not None})
        cur["event"] = rec.get("event", cur.get("event"))
    return merged


def is_standcode_room(room: dict, ledger: dict | None = None) -> bool:
    """这个 areco 房间是不是 StandCode 派发出来的。

    判定顺序 = 可信度顺序：台账（机器写、用户改不到）> 名字标记 > 历史命名模式。
    名字类判据只是为了认领台账上线之前的存量房间（rooms --adopt），不作为长期依据。
    """
    rid = room.get("id") or ""
    if ledger is None:
        ledger = ledger_load()
    if rid in ledger:
        return True
    name = room.get("name") or ""
    if ROOM_MARK and name.startswith(ROOM_MARK):
        return True
    return bool(_LEGACY_ROOM_RE.match(name) or _ROOM_TAIL_RE.search(name))


def heartbeat_path(session_id: str) -> Path:
    """Stand 心跳文件路径（键 = stand_session_id）"""
    return HEARTBEAT_DIR / f"{session_id}.hb"


def read_heartbeat(session_id: str) -> Optional[float]:
    """读心跳文件 mtime（epoch 秒）。文件不存在/不可读返回 None。

    Caller 只读不写：心跳须由 Stand 宿主（areco session / wrapper）写入才反映 Stand
    真实存活。Caller 进程自写的心跳只反映 Caller 自己，是假信号（见 _HeartbeatWriter）。
    """
    if not session_id:
        return None
    try:
        return heartbeat_path(session_id).stat().st_mtime
    except (FileNotFoundError, OSError):
        return None


def heartbeat_stale(
    session_id: str, stale_sec: float = HEARTBEAT_STALE_SEC
) -> Optional[bool]:
    """心跳是否过期（距今 > stale_sec）。

    返回 None = 无心跳文件（Stand 端尚未实现心跳写入，无法据此判定）。
    返回 True = 心跳过期，Stand 宿主大概率已失联。
    """
    mtime = read_heartbeat(session_id)
    if mtime is None:
        return None
    return (time.time() - mtime) > stale_sec


class _HeartbeatWriter:
    """用 threading.Timer 周期更新心跳文件的独立线程（每 tick_sec 一次）。

    ⚠️ 适用边界（重要）：本类写出的心跳只证明「这个 Caller 跟踪循环还活着」，
    不证明 Stand（areco 内独立 pty 子进程）活着。要检测 Stand 掉线，心跳须由
    Stand 宿主写入、Caller 只读（read_heartbeat）。因此 dispatch 默认【不】启动
    本类；仅当需要 Caller 侧存活标记（如 bg_worker 崩溃后被外部巡检发现）时显式调用。

    用法：
        hw = _HeartbeatWriter(session_id).start()
        try: ...
        finally: hw.stop()
    """

    def __init__(
        self,
        session_id: str,
        tick_sec: float = HEARTBEAT_TICK_SEC,
        stale_sec: float = HEARTBEAT_STALE_SEC,
    ):
        self.session_id = session_id
        self.tick_sec = tick_sec
        self.stale_sec = stale_sec
        self.path = heartbeat_path(session_id)
        self._timer: Optional[threading.Timer] = None
        self._stopped = True
        self._lock = threading.Lock()

    def _tick(self) -> None:
        """Timer 回调：touch 心跳文件并重新 arm（threading.Timer 单次触发，靠重 arm 循环）"""
        try:
            HEARTBEAT_DIR.mkdir(parents=True, exist_ok=True)
            # 写当前时间戳内容 + touch mtime（内容便于人读，mtime 供判定）
            self.path.write_text(f"{time.time():.3f}\n")
        except OSError as e:
            logger.warning("心跳写入失败 %s: %s", self.path, e)
        with self._lock:
            if self._stopped:
                return
            self._timer = threading.Timer(self.tick_sec, self._tick)
            self._timer.daemon = True
            self._timer.start()

    def start(self) -> "_HeartbeatWriter":
        with self._lock:
            if not self._stopped:
                return self
            self._stopped = False
        self._tick()  # 立即写一次，再由 Timer 续命
        return self

    def stop(self, remove_file: bool = False) -> None:
        with self._lock:
            self._stopped = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        if remove_file:
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                pass


class Caller:
    """StandCode Caller — 调度 Stand 执行任务"""

    def __init__(
        self,
        base_url: str = ARECO_BASE,
        projects_db: str | Path = PROJECTS_DB,
        registry_path: str | Path = REGISTRY_PATH,
    ):
        self.base_url = base_url.rstrip("/")
        self.projects_db = Path(projects_db)
        self.registry_path = Path(registry_path)
        self._http = requests.Session()
        self._http.headers.update({"Content-Type": "application/json"})

        # 加载注册表（默认值全部由 registry.json 驱动，此处不预填任何业务默认）
        self.task_map: dict[str, str] = {}
        self.registry: dict = {}
        self.default_template_id: str = ""
        self.default_thinker_id: str = ""
        self.default_worker_id: str = ""
        self.default_heavy_worker_id: str = ""  # ⑤ 重活车道锚（法律/代码词）；加载层由 resolve_lane_anchors 应用 areco 真锚
        self.default_caller_id: str = ""  # areco 设置页的 caller 默认（仅记录，caller 角色由入口 agent 自任）
        self.lane_anchor_sources: dict = {}  # 车道锚来源（横幅口径）：{"heavy": "kimi-k3@areco-config", ...}
        self.template_names: dict[str, str] = {}
        self.roles: dict[str, str] = {}  # template_id → "thinker" | "worker"
        self._load_registry()

    # ── 注册表加载 ──────────────────────────────────────────────

    def _load_registry(self) -> None:
        """从 registry.json 加载默认值与模板元信息（默认值完全由 registry 驱动）

        字段映射：
          default_thinker      → default_thinker_id（--role thinker / dispatch_thinker）
          default_worker       → default_worker_id（--role worker / dispatch_worker）
                                 同时作为全局兜底 default_template_id
          task_type_defaults   → task_map（任务类型 → 模板 id）
          templates            → template_names / roles（仅元信息）

        正常路径取值 100% 来自 registry.json，不掺任何模块级业务硬编码。
        registry 缺某字段时回退到「同文件内更宽的默认」(default_template→default_worker)
        或紧急兜底常量；registry 文件完全不可读时使用紧急兜底。

        兼容两种 task_type_defaults 写法：值可为字符串（模板 id）或
        {"template_id": "..."}（旧嵌套格式）。
        """
        # registry 文件完全不可用时的紧急兜底（与 registry.json 当前取值一致；
        # 仅在文件缺失/解析失败时启用，正常路径不参与）
        # ⑤ 路由反转（2026-07-29）：默认 Worker=hy3（workbuddy），重活锚 claude-glm52。
        # 2026-07-29：默认 Thinker 统一 flash（07-28 高律师设置页选定）。
        # 2026-07-29：非 workbuddy 系模板 id 改 harness-模型 格式；workbuddy 系 id
        # 经高律师纠正保留原名（本意只是设置页显示名写清 harness+模型，不动底层 id）。
        _FALLBACK_THINKER = "workbuddy-deepseek"
        _FALLBACK_WORKER = "workbuddy"
        _FALLBACK_HEAVY = "claude-glm52"

        def _apply_fallback(reason: str) -> None:
            logger.warning(
                "%s；改用紧急兜底 thinker=%s worker=%s",
                reason, _FALLBACK_THINKER, _FALLBACK_WORKER,
            )
            self.default_thinker_id = _FALLBACK_THINKER
            self.default_worker_id = _FALLBACK_WORKER
            self.default_heavy_worker_id = _FALLBACK_HEAVY
            self.default_template_id = _FALLBACK_WORKER
            self.task_map = {}
            self._apply_areco_defaults()  # registry 挂了仍吃 areco 设置页的角色默认
            self._apply_lane_reroutes()   # 重活改道/停新单改道照样生效

        if not self.registry_path.exists():
            _apply_fallback(f"注册表不存在 {self.registry_path}")
            return
        try:
            data = json.loads(self.registry_path.read_text())
        except Exception as e:
            _apply_fallback(f"加载注册表失败: {e}")
            return

        self.registry = data
        # 角色默认 + 全局兜底：完全由 registry 驱动
        self.default_thinker_id = data.get("default_thinker") or _FALLBACK_THINKER
        self.default_worker_id = data.get("default_worker") or _FALLBACK_WORKER
        # ⑤ 重活车道锚（2026-07-29 路由反转）：default_worker 反转为 hy3 后，法律/代码
        # 重活的模板必须有独立锚点。2026-07-30 定案：真锚 = areco 设置页 standcode.heavyWorker
        # （设置页直达旋钮），registry 这里的 default_heavy_worker 只是镜像 + areco 全挂时的
        # 兜底来源——加载尾段 _apply_lane_reroutes 会用 resolve_lane_anchors 的解析值覆盖它。
        _exec_default = (data.get("task_type_defaults", {}) or {}).get("execute")
        if isinstance(_exec_default, dict):  # 旧嵌套写法 {"template_id": "..."}
            _exec_default = _exec_default.get("template_id")
        self.default_heavy_worker_id = (
            data.get("default_heavy_worker") or _exec_default or _FALLBACK_HEAVY
        )
        # registry 无独立 default_template 字段时，全局兜底 = default_worker
        self.default_template_id = data.get("default_template") or self.default_worker_id
        # task_map：完全由 registry 的 task_type_defaults 构建（不再预填业务默认）
        self.task_map = {}
        for task_type, cfg in data.get("task_type_defaults", {}).items():
            self.task_map[task_type] = (
                cfg["template_id"] if isinstance(cfg, dict) else cfg
            )
        # templates 元信息（id→name / id→role）
        self.template_names = {}
        self.roles = {}
        for t in data.get("templates", []):
            if not isinstance(t, dict) or not t.get("id"):
                continue
            self.template_names[t["id"]] = t.get("name", t["id"])
            role = t.get("role", "worker")
            if role in ("thinker", "worker"):
                self.roles[t["id"]] = role
        logger.info(
            "已加载注册表 %s（默认=%s thinker=%s worker=%s，%d 种任务类型映射）",
            self.registry_path,
            self.default_template_id,
            self.default_thinker_id,
            self.default_worker_id,
            len(self.task_map),
        )
        self._apply_areco_defaults()
        self._apply_lane_reroutes()

    def _stopped_stands(self) -> set[str]:
        """停新单 stand 集合（2026-07-29 额度机制）：registry 模板静态标记
        （templates[].status 含「停新单」）+ 运行期状态文件 STAND_STOP_PATH
        （额度信号命中自动写入）两路并集。状态文件读不动 = 只用静态标记。"""
        stopped: set[str] = set()
        for t in (self.registry or {}).get("templates", []):
            if isinstance(t, dict) and t.get("id") and "停新单" in str(t.get("status", "")):
                stopped.add(t["id"])
        try:
            data = json.loads(STAND_STOP_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                stopped.update(k for k, v in data.items()
                               if isinstance(v, dict) and v.get("stopped"))
        except Exception:
            pass
        return stopped

    def _apply_lane_reroutes(self) -> None:
        """车道锚应用 + 停新单改道（2026-07-30 高律师定案：锚 SoT 迁 areco 设置页）。

        ① 重活车道锚：resolve_lane_anchors() 运行时读 areco（API→config.json→常量），
          强制到 default_heavy_worker_id；registry/areco 侧取值不动，只在加载层生效。
        ② fast 车道锚：同链解析后强制 task_map["fast"]。
          必须压住 _apply_areco_defaults 的旧版覆盖——本方法在其后调用。
        ③ 停新单改道：默认锚/task_map 命中停新单 stand 且备胎表 LANE_FALLBACK_MAP
           有映射的，改道备胎；无映射只 warning（宁可报警也不静默滑错车）。
        决策一律 logger.warning 留痕；锚来源记 self.lane_anchor_sources（横幅口径，
        go 头行 JSON 输出；route_reason 由 route_mode 写明）。
        """
        anchors = resolve_lane_anchors()
        heavy_stand, heavy_src = anchors["heavy"]
        fast_stand, fast_src = anchors["fast"]
        self.lane_anchor_sources = {"heavy": f"{heavy_stand}@{heavy_src}",
                                    "fast": f"{fast_stand}@{fast_src}"}
        # ① 重活车道锚（真锚 = areco 设置页 standcode.heavyWorker）
        if self.default_heavy_worker_id and self.default_heavy_worker_id != heavy_stand:
            logger.warning(
                "重活车道锚应用：%s → %s（来源 %s；SoT=areco 设置页，2026-07-30 高律师定案）",
                self.default_heavy_worker_id, heavy_stand, heavy_src,
            )
            self.default_heavy_worker_id = heavy_stand
        # ② fast 车道锚（真锚 = areco 设置页 standcode.fastWorker）
        if self.task_map.get("fast") != fast_stand:
            logger.warning(
                "fast 车道锚应用：%s → %s（来源 %s；SoT=areco 设置页，2026-07-30 高律师定案）",
                self.task_map.get("fast"), fast_stand, fast_src,
            )
            self.task_map["fast"] = fast_stand
        # ③ 停新单 stand 涉及车道改道备胎
        stopped = self._stopped_stands()
        if not stopped:
            return
        lanes = [("default_thinker_id", "thinker 默认"),
                 ("default_worker_id", "worker 默认"),
                 # heavy 锚三角色统一后跟随 thinker（2026-08-02），停新单改道必须同列——
                 # 否则 thinker 改道了、heavy 仍派停新单 stand，同一语义两种行为
                 ("default_heavy_worker_id", "heavy 车道锚"),
                 ("default_template_id", "全局兜底")]
        for attr, label in lanes:
            cur = getattr(self, attr, "")
            if cur in stopped:
                fb = LANE_FALLBACK_MAP.get(cur)
                if fb:
                    logger.warning("%s命中停新单 stand %s，改道备胎 %s", label, cur, fb)
                    setattr(self, attr, fb)
                else:
                    logger.warning("%s命中停新单 stand %s，备胎表无映射——保持原值，"
                                   "派发可能失败，请人工补备胎", label, cur)
        for tt, cur in list(self.task_map.items()):
            if cur in stopped:
                fb = LANE_FALLBACK_MAP.get(cur)
                if fb:
                    logger.warning("task_map[%s] 命中停新单 stand %s，改道备胎 %s",
                                   tt, cur, fb)
                    self.task_map[tt] = fb
                else:
                    logger.warning("task_map[%s] 命中停新单 stand %s，备胎表无映射"
                                   "——保持原值", tt, cur)

    def _apply_areco_defaults(self) -> None:
        """areco 设置页的角色默认覆盖层（优先级：areco 设置 > registry.json > 紧急兜底）。

        GET /api/standcode/defaults 返回 {caller, thinker, worker, fastWorker}（模板 id）。
        非空字段覆盖对应默认（thinker→think/plan，worker→execute/work + 全局兜底，
        fastWorker→fast）；areco 不可达或旧版无此端点 = 静默保持 registry 取值。
        覆盖层是增强不是依赖——任何异常都不允许影响派发主流程。
        """
        try:
            resp = self._http.get(f"{self.base_url}/api/standcode/defaults", timeout=2)
            if resp.status_code != 200:
                return
            sc = resp.json().get("data")
            if not isinstance(sc, dict):
                return
        except Exception:
            return  # areco 未起 / 旧版无端点：静默回落 registry
        applied = []
        thinker = str(sc.get("thinker") or "").strip()
        if thinker:
            self.default_thinker_id = thinker
            for tt in ("think", "plan"):
                if tt in self.task_map:
                    self.task_map[tt] = thinker
            applied.append(f"thinker={thinker}")
        worker = str(sc.get("worker") or "").strip()
        if worker:
            self.default_worker_id = worker
            self.default_template_id = worker
            for tt in ("execute", "work"):
                if tt in self.task_map:
                    self.task_map[tt] = worker
            applied.append(f"worker={worker}")
        fast = str(sc.get("fastWorker") or "").strip()
        if fast:
            if "fast" in self.task_map:
                self.task_map["fast"] = fast
            applied.append(f"fastWorker={fast}")
        caller = str(sc.get("caller") or "").strip()
        if caller:
            self.default_caller_id = caller
            applied.append(f"caller={caller}")
        if applied:
            logger.info("已应用 areco 角色默认覆盖：%s", "、".join(applied))

    # ── REST API 辅助 ───────────────────────────────────────────

    def _api_get(self, path: str, **kwargs) -> dict:
        """GET 请求，自动解析 areco 的 {ok, data} 应答"""
        resp = self._http.get(f"{self.base_url}/api{path}", **kwargs, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"API 返回非 ok: {data}")
        return data["data"]

    def _api_post(self, path: str, body: dict = None) -> dict:
        """POST 请求"""
        resp = self._http.post(
            f"{self.base_url}/api{path}", json=body or {}, timeout=15
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"API 返回非 ok: {data}")
        return data.get("data", {})

    def _api_delete(self, path: str) -> dict:
        """DELETE 请求"""
        resp = self._http.delete(f"{self.base_url}/api{path}", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"API 返回非 ok: {data}")
        return data.get("data", {})

    # ── 房间管理 ────────────────────────────────────────────────

    def list_rooms(self, include_archived: bool = False) -> list[dict]:
        """列出房间。默认只给未归档的——归档房间不可投递（room-relay 整体跳过），
        当成可用房间返给调用方是误导；要看全量传 include_archived=True。
        """
        rooms = self._api_get("/rooms").get("rooms", [])
        if include_archived:
            return rooms
        return [r for r in rooms if r.get("archivedAt") is None]

    def create_room(self, name: str = None) -> dict:
        """创建一个新的调度房间，返回房间信息"""
        if name is None:
            name = f"StandCode-{uuid.uuid4().hex[:8]}"
        room = self._api_post("/rooms", {"name": name})
        logger.info("创建房间: id=%s name=%s team=%s", room["id"], room["name"], room.get("team"))
        return room

    def delete_room(self, room_id: str) -> dict:
        """删除房间（级联删除专属会话）"""
        result = self._api_delete(f"/rooms/{room_id}")
        logger.info("删除房间: id=%s", room_id)
        return result

    def archive_room(self, room_id: str) -> dict:
        """归档房间（可逆：UI 点「恢复任务」或 unarchive_room 还原）

        areco 侧连带把房内成员会话一并归档，看板同步清干净；房间内消息、成员快照
        全部保留。运行中的 Stand 会话会先被 stop 再落 archived——所以只在结果已经
        收完之后才调用。
        """
        result = self._api_post(f"/rooms/{room_id}/archive")
        logger.info("归档房间: id=%s", room_id)
        return result

    def unarchive_room(self, room_id: str) -> dict:
        """取消归档（房间与房内会话一并回看板）"""
        result = self._api_post(f"/rooms/{room_id}/unarchive")
        logger.info("取消归档房间: id=%s", room_id)
        return result

    def list_sessions(self) -> list[dict]:
        """列出所有会话（清扫判定要看房内成员是否还在跑）"""
        data = self._api_get("/sessions")
        if isinstance(data, dict):
            return data.get("sessions", [])
        return data or []

    def finish_room(self, dispatch_result: dict, status: str, settle_forced: bool = False,
                    keep_reason: str | None = None) -> dict:
        """一次派发的收口：成功即归档自建房间，其余情况留在看板。

        只归档「StandCode 自己新建」的房间（dispatch_result["room_created"]）——
        用户传 room_id 复用的房间是人家的地盘，收口时一律不动。
        归档失败只告警：房间没清掉是脏数据，把整条任务链带崩才是事故。

        两道「别急着归档」守卫（2026-07-27 拆「看到中途结果误判完成而提前关闭」链——
        areco 归档房间会级联 SIGTERM 房内 Stand 会话，Stand 还在干活就被杀）：
          1. settle_forced：提前收口（working_wedged/hold_cap/deadline）≠ 干完；
          2. 存活探针：completed 但房内 Stand 仍是 running + working。

        返回 {"archived": bool, "room_id": str|None, "reason": str}
        """
        room_id = dispatch_result.get("room_id")
        if not room_id:
            return {"archived": False, "room_id": None, "reason": "no_room"}
        task_id = dispatch_result.get("task_id", "")
        if not dispatch_result.get("room_created", False):
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="reused_room")
            return {"archived": False, "room_id": room_id, "reason": "reused_room"}
        if keep_reason:
            # 调用方点名保留（如 verify_escalated：判据两过不了升级人工）——归档会级联
            # 杀 Stand 并被 sweeper 删房，取证现场就没了
            ledger_append("kept", room_id, task_id=task_id, status=status, reason=keep_reason)
            return {"archived": False, "room_id": room_id, "reason": keep_reason}
        if not AUTO_ARCHIVE:
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="auto_archive_off")
            return {"archived": False, "room_id": room_id, "reason": "auto_archive_off"}
        if status != "completed":
            # 失败/超时/失联：留在看板才看得见，别把现场归档掉
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="not_completed")
            return {"archived": False, "room_id": room_id, "reason": "not_completed"}
        if settle_forced:
            # 提前收口 ≠ 干完：working_wedged/hold_cap/deadline 都是「手里有货但 Stand 可能
            # 还在干」，此时归档 = 级联 SIGTERM 杀 Stand。房留看板，迟到结果留给 reconcile
            # 补收后归档（_rec_archive_room）。
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="settle_forced")
            return {"archived": False, "room_id": room_id, "reason": "settle_forced"}
        # 存活探针：completed 但房内 Stand 仍在干活（会话 running + 灯 working）→ 不归档。
        # best-effort：_session_info 查不到（None/异常）不拦归档——探针故障不该把收口卡死。
        sid = dispatch_result.get("stand_session_id")
        if sid:
            info = self._session_info(sid)
            if info and info.get("status") == "running" and info.get("trafficState") == "working":
                ledger_append("kept", room_id, task_id=task_id, status=status,
                              reason="stand_still_working")
                return {"archived": False, "room_id": room_id, "reason": "stand_still_working"}
        try:
            self.archive_room(room_id)
        except Exception as e:
            logger.warning("自动归档失败 room=%s: %s", room_id, e)
            ledger_append("kept", room_id, task_id=task_id, status=status,
                          reason="archive_failed", error=str(e))
            return {"archived": False, "room_id": room_id, "reason": f"archive_failed: {e}"}
        ledger_append("archived", room_id, task_id=task_id, status=status, by="auto")
        log_audit("room_archived", {"task_id": task_id, "room_id": room_id, "by": "auto"})
        return {"archived": True, "room_id": room_id, "reason": "completed"}

    def list_template_ids(self) -> set[str]:
        """areco 现有模板 id 集合（进程内缓存一次）。取不到返回空集 = 不做校验。"""
        cached = getattr(self, "_template_ids", None)
        if cached is not None:
            return cached
        ids: set[str] = set()
        try:
            data = self._api_get("/templates")
            # _api_get 可能已把 {ok, data:[...]} 解包成裸 list；两种形状都接
            if isinstance(data, dict):
                items = data.get("templates") or data.get("data") or []
            else:
                items = data
            for t in items or []:
                tid = t.get("id") if isinstance(t, dict) else t
                if tid:
                    ids.add(str(tid))
        except Exception as e:
            logger.warning("取 areco 模板列表失败，跳过模板校验: %s", e)
        self._template_ids = ids
        return ids

    def _assert_template_exists(self, tid: str) -> None:
        """派发前确认模板真的存在于 areco。

        刻意 fail-open：取不到模板列表（areco 没起/接口变了）时**不拦**——审计发现
        registry.json 里的 zcode 在 areco 根本不存在，但这类漂移不该让整个 CLI 罢工，
        只该在能确认「列表拿到了、里面没有它」时才拒绝。
        """
        known = self.list_template_ids()
        if known and tid not in known:
            raise RuntimeError(
                f"模板『{tid}』在 areco 中不存在（现有：{', '.join(sorted(known))}）。"
                f"检查 stand/registry.json 与 areco 模板列表是否漂移。"
            )

    def get_room(self, room_id: str) -> dict:
        """获取单个房间详情"""
        rooms = self._api_get("/rooms")
        for r in rooms.get("rooms", []):
            if r["id"] == room_id:
                return r
        raise KeyError(f"房间不存在: {room_id}")

    # ── Stand（成员）管理 ───────────────────────────────────────

    def add_stand(self, room_id: str, template_id: str, cwd: str | None = None) -> dict:
        """在房间中添加一个 Stand（worker agent session）

        cwd：本次会话的工作目录，覆盖模板固定 cwd（areco 2026-07-26 起支持）。
        用于 isolated=True 的 git worktree 隔离。areco 侧目录不存在会直接 400 ——
        刻意的，静默回落 $HOME 会让「隔离的」并行 agent 全落在同一个真仓库里。

        返回成员信息，包含 name（用于发消息时定位）和 sessionId。
        """
        payload: dict = {"templateId": template_id}
        if cwd:
            payload["cwd"] = cwd
        member = self._api_post(f"/rooms/{room_id}/members", payload)
        logger.info(
            "添加 Stand: room=%s template=%s cwd=%s → name=%s session=%s",
            room_id, template_id, cwd or "(模板默认)",
            member.get("name"), member.get("sessionId"),
        )
        return member

    def remove_stand(self, room_id: str, member_name: str) -> dict:
        """从房间移除 Stand（解绑 session）"""
        from urllib.parse import quote

        result = self._api_delete(f"/rooms/{room_id}/members/{quote(member_name)}")
        logger.info("移除 Stand: room=%s name=%s", room_id, member_name)
        return result

    # ── 暖池 standby pool（2026-07-26 提速批件）───────────────────
    # 认领/补胎全部 fail-open：暖池只能加速，任何异常都回落冷启动，不挡主链。

    def _standby_files(self, template_id: str | None = None) -> list[Path]:
        """池文件列表（旧的在前）。文件名 <模板>--<房id>.json。"""
        if not STANDBY_DIR.exists():
            return []
        pat = f"{template_id}--*.json" if template_id else "*--*.json"
        try:
            return sorted(STANDBY_DIR.glob(pat), key=lambda p: p.stat().st_mtime)
        except OSError:
            return []

    @staticmethod
    def _seat_pristine(info: dict, sess: dict | None) -> bool:
        """席位是否还没被用过（会话名未被改成任务名）。

        龄/活性/房归档三道检查都验不出「席位已被消费」：07-27 实测一个被测试用掉的
        待命会话（名字已变成任务名）在池里躺了 80 分钟仍显示可派，派进去等于让
        worker 接着别人的对话干新活。待命名形如「⚙…」或「<Stand 名> #N」，偏离即脏。
        """
        try:
            sess_name = str((sess or {}).get("name") or "")
            stand_name = str(info.get("stand_name") or "")
            return (
                not sess_name
                or sess_name.startswith("⚙")
                or bool(stand_name and sess_name.startswith(stand_name))
            )
        except Exception:
            return True  # 判不出就别误杀，交给龄/活性闸

    def standby_claim(self, template_id: str) -> dict | None:
        """认领一个同模板待命 Stand，返回 dispatch 可直用的 reuse_stand 字典或 None。

        认领 = os.rename 原子抢占（并发派发只有一个赢家）。过期 / 会话已死 / 房间
        被归档的待命位当场清理（归档房间+落台账）后继续找下一个。
        """
        if not STANDBY_ENABLED:
            return None
        if unhealthy_until(template_id):
            # 健康闸（2026-07-28 A3）：黑名单模板不碰（dispatch 的健康闸会先行硬报错，
            # 这里双保险防 refill/旧席位被认领）
            return None
        try:
            for f in self._standby_files(template_id):
                claimed = f.with_name(f.name + f".claiming-{os.getpid()}")
                try:
                    os.rename(f, claimed)
                except OSError:
                    continue  # 并发输家：别人已抢走
                try:
                    info = json.loads(claimed.read_text())
                except Exception:
                    claimed.unlink(missing_ok=True)
                    continue
                claimed.unlink(missing_ok=True)
                age = time.time() - float(info.get("created_ts") or 0)
                if age > STANDBY_MAX_AGE_SEC:
                    self._standby_discard(info, "expired")
                    continue
                # 会话活性：areco 重启会杀掉待命 TUI（exited），认领前必须验活
                try:
                    sess = next((s for s in self.list_sessions()
                                 if s.get("id") == info.get("stand_session_id")), None)
                except Exception:
                    sess = None
                if not sess or sess.get("status") != "running":
                    self._standby_discard(info, "session_dead")
                    continue
                if not self._seat_pristine(info, sess):
                    self._standby_discard(info, "seat_consumed")
                    continue
                try:
                    room = self.get_room(info["room_id"])
                    if room.get("archivedAt") is not None:
                        self._standby_discard(info, "room_archived", archive=False)
                        continue
                except Exception:
                    self._standby_discard(info, "room_missing", archive=False)
                    continue
                ledger_append("adopted", info["room_id"], by="standby_claim",
                              template_id=template_id, room_name=info.get("room_name", ""))
                log_audit("standby_claim", {
                    "template": template_id, "room_id": info["room_id"],
                    "age_sec": round(age, 1),
                })
                logger.info("暖池命中: room=%s tpl=%s 龄=%.0fs", info["room_id"], template_id, age)
                return {"kind": "standby", "room_created": True, **info}
        except Exception as e:
            logger.warning("standby 认领异常（回落冷启动）: %s", e)
        return None

    def _standby_discard(self, info: dict, reason: str, archive: bool = True) -> None:
        """废弃一个待命位：池文件已被认领方摘走，这里只负责收拾房间与留痕。"""
        log_audit("standby_discard", {
            "room_id": info.get("room_id"), "template": info.get("template_id"),
            "reason": reason,
        })
        if not archive:
            return
        try:
            self.archive_room(info["room_id"])
            ledger_append("archived", info["room_id"], by=f"standby_{reason}")
        except Exception as e:
            logger.warning("待命房清理失败 room=%s: %s", info.get("room_id"), e)

    def standby_refill(self, template_id: str) -> dict | None:
        """补一个待命 Stand。池满 / 建失败一律静默跳过——补胎不影响主链。

        待命 Stand 是 spawn 好但没收到任何消息的 TUI：空闲不调模型，token 成本为零，
        只占一个进程与看板一个「⚙待命·<模板>」房。
        """
        if not STANDBY_ENABLED:
            return None
        if unhealthy_until(template_id):
            # 健康闸（2026-07-28 A3）：黑名单模板直接跳过，不再连刷 404
            logger.info("暖池补胎跳过：模板『%s』在健康闸黑名单内", template_id)
            return None
        try:
            if len(self._standby_files(template_id)) >= STANDBY_POOL_SIZE:
                return None
            self._assert_template_exists(template_id)
            STANDBY_DIR.mkdir(parents=True, exist_ok=True)
            # 名字带 4 位随机尾缀：areco 房名全局唯一（含已归档，rooms.ts）——上一个
            # 待命房归档后名字仍占着，裸「⚙待命·claude-glm52」第二次建必 400（2026-07-26 实测）。
            room = self.create_room(f"{ROOM_MARK}待命·{template_id}·{uuid.uuid4().hex[:4]}")
            member = self.add_stand(room["id"], template_id)
            info = {
                "room_id": room["id"],
                "team": room["team"],
                "room_name": room.get("name", ""),
                "stand_name": member["name"],
                "stand_session_id": member.get("sessionId", ""),
                "template_id": template_id,
                "created_ts": time.time(),
                "created_at": _now_iso(),
            }
            (STANDBY_DIR / f"{template_id}--{room['id']}.json").write_text(
                json.dumps(info, ensure_ascii=False), encoding="utf-8")
            ledger_append("created", room["id"], room_name=room.get("name", ""),
                          team=room["team"], template_id=template_id, by="standby_refill")
            log_audit("standby_refill", {"template": template_id, "room_id": room["id"]})
            template_mark_success(template_id)  # 健康闸：补胎走通一次即清除黑名单记录
            logger.info("暖池补胎: room=%s tpl=%s", room["id"], template_id)
            return info
        except Exception as e:
            template_mark_failure(template_id, e)  # 健康闸：连挂计数（此前只 warning 无 backoff）
            logger.warning("standby 补胎失败（不影响主链）tpl=%s: %s", template_id, e)
            return None

    def standby_sweep(self) -> dict:
        """清扫暖池：过期 / 会话已死 / 已被消费的待命位归档回收；>5 分钟的孤儿 .claiming-* 删除。"""
        expired, orphans, consumed, dead = 0, 0, 0, 0
        try:
            sessions = {s.get("id"): s for s in self.list_sessions()}
        except Exception:
            sessions = {}
        for f in self._standby_files():
            try:
                info = json.loads(f.read_text())
            except Exception:
                f.unlink(missing_ok=True)
                continue
            # 会话已死的席位主动清：池满判定只数文件，一个指向死会话的席位会把该模板
            # 唯一的位子占到过期（120min），poolwarm 期间一直补不进来 = 静默退回冷启动
            # （07-27 实测 workbuddy-deepseek 席位指向已消失的会话，占位 90min）。
            # claim 侧本就有 session_dead 闸，但那要等到有人认领才触发。
            # sessions 为空 = list_sessions 失败，此时一律不判，避免 API 抖动清空整池。
            if sessions:
                sess = sessions.get(info.get("stand_session_id"))
                if not sess or sess.get("status") != "running":
                    try:
                        os.rename(f, f.with_name(f.name + f".claiming-{os.getpid()}"))
                    except OSError:
                        continue
                    f.with_name(f.name + f".claiming-{os.getpid()}").unlink(missing_ok=True)
                    self._standby_discard(info, "session_dead")
                    dead += 1
                    continue
            # 被用过的席位主动清，别等下次认领才发现（claim 那道闸是兜底）
            if sessions and not self._seat_pristine(
                info, sessions.get(info.get("stand_session_id"))
            ):
                try:
                    os.rename(f, f.with_name(f.name + f".claiming-{os.getpid()}"))
                except OSError:
                    continue
                f.with_name(f.name + f".claiming-{os.getpid()}").unlink(missing_ok=True)
                self._standby_discard(info, "seat_consumed")
                consumed += 1
                continue
            if time.time() - float(info.get("created_ts") or 0) > STANDBY_MAX_AGE_SEC:
                try:
                    os.rename(f, f.with_name(f.name + f".claiming-{os.getpid()}"))
                except OSError:
                    continue  # 正被认领
                f.with_name(f.name + f".claiming-{os.getpid()}").unlink(missing_ok=True)
                self._standby_discard(info, "expired")
                expired += 1
        if STANDBY_DIR.exists():
            for c in STANDBY_DIR.glob("*.claiming-*"):
                try:
                    if time.time() - c.stat().st_mtime > 300:
                        c.unlink(missing_ok=True)
                        orphans += 1
                except OSError:
                    pass
        return {"expired": expired, "orphan_claims": orphans,
                "consumed": consumed, "dead": dead}

    def standby_status(self) -> list[dict]:
        """暖池现状（池文件 × 会话活性），供 `caller.py pool` 展示。"""
        out = []
        try:
            sessions = {s.get("id"): s for s in self.list_sessions()}
        except Exception:
            sessions = {}
        for f in self._standby_files():
            try:
                info = json.loads(f.read_text())
            except Exception:
                continue
            sess = sessions.get(info.get("stand_session_id"))
            out.append({
                **info,
                "age_sec": round(time.time() - float(info.get("created_ts") or 0), 1),
                "session_status": (sess or {}).get("status", "unknown"),
            })
        return out

    # ── 消息收发（直写 SQLite，绕过 REST 的固定 from 限制）─────

    def _db_connect(self) -> sqlite3.Connection:
        """连接 projects.db（只读模式也会 WAL 写 journal，所以直接读写）"""
        conn = sqlite3.connect(str(self.projects_db))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=3000")
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_messages_table(self, conn: sqlite3.Connection) -> None:
        """确保 messages 表存在（兼容空库首次写入）"""
        conn.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                team TEXT NOT NULL,
                from_agent TEXT NOT NULL,
                to_agent TEXT NOT NULL,
                body TEXT NOT NULL,
                human_relay INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )"""
        )

    def send_message(
        self,
        team: str,
        to: str,
        body: str,
        from_: str = CALLER_NAME,
        human_relay: bool | None = None,
        room_id: str = "",
    ) -> int:
        """向房间发送消息（REST 快路优先，SQLite 直写兜底）

        team: 房间 team 名（如 "room-xxxx"）
        to:   收件人成员名
        body: 消息正文
        from_: 发件人身份（默认当前 CALLER_NAME；多向派发 2026-08-02 起按身份落库，禁冒名）
        human_relay: 是否按「转述人类原话」投递。None（默认）= 自动：from 在
            HUMAN_RELAY_CALLERS 白名单（对齐 areco config.json humanRelayAgents，
            生产 = ['Hermes']）才置 True——Hermes 代发任务=转述用户意图，areco 按人类
            发言处理（默认投全体 + 清零链深 + 附 context 预览）。名单外 caller 置 True
            毫无意义（areco 只 warn 并按 agent 处理），故自动落 False，投递靠
            to_agent 列（room-relay 2026-07-24 起正文无 @ 时按列投递，不静默吞）。
        room_id: 房间 id（可选）。给了且服务端具备 sendFrom 能力（defaults._caps，
            2026-07-30 P1-5）→ 走 REST /rooms/{id}/send：postMessage 同步落库+投递，
            省掉 SQLite 直写后等 relay tick 拾取的平均 0.5s，且拿到同步投递回执。
            旧服务端（未重启无 _caps）/REST 失败 → 回落 SQLite 直写，行为与旧版全同。
        返回消息 ID
        """
        if human_relay is None:
            human_relay = from_ in HUMAN_RELAY_CALLERS
        if room_id and _areco_send_from_supported():
            try:
                data = self._api_post(f"/rooms/{room_id}/send", {
                    "body": body, "from": from_, "humanRelay": human_relay, "to": to,
                })
                msg_id = int(data.get("id") or 0)
                if msg_id > 0:
                    logger.info(
                        "发送消息(REST): id=%s room=%s from=%s to=%s human_relay=%s",
                        msg_id, room_id, from_, to, human_relay,
                    )
                    return msg_id
                logger.warning("REST 发消息返回异常 payload（%s），回落 SQLite 直写", data)
            except Exception as e:
                logger.warning("REST 发消息失败（room=%s: %s），回落 SQLite 直写", room_id, e)
        conn = self._db_connect()
        try:
            self._ensure_messages_table(conn)
            cur = conn.execute(
                "INSERT INTO messages (team, from_agent, to_agent, body, human_relay) "
                "VALUES (?, ?, ?, ?, ?)",
                (team, from_, to, body, 1 if human_relay else 0),
            )
            conn.commit()
            msg_id = cur.lastrowid
            logger.info(
                "发送消息: id=%s team=%s from=%s to=%s human_relay=%s",
                msg_id, team, from_, to, human_relay,
            )
            return msg_id
        finally:
            conn.close()

    def get_messages(self, team: str, limit: int = 100, after_id: int = 0) -> list[dict]:
        """获取房间消息列表（旧→新），可按 after_id 增量拉取"""
        conn = self._db_connect()
        try:
            self._ensure_messages_table(conn)
            rows = conn.execute(
                "SELECT * FROM messages WHERE team=? AND id>? ORDER BY id ASC LIMIT ?",
                (team, after_id, limit),
            ).fetchall()
            self._msg_read_failures = 0
            return [dict(r) for r in rows]
        except sqlite3.OperationalError as e:
            # 不能静默返回 []：poll_result 会把它当成「Stand 还没回话」继续等，而
            # --wait 默认 timeout=0（无限等）→ 库被锁/schema 漂移时进程永远挂着，
            # 既不报错也不写 inbox。连续失败到阈值就抛，让上层看得见。
            self._msg_read_failures = getattr(self, "_msg_read_failures", 0) + 1
            logger.warning(
                "读消息失败（第 %d 次，team=%s）: %s",
                self._msg_read_failures, team, e,
            )
            if self._msg_read_failures >= MSG_READ_FAIL_LIMIT:
                raise RuntimeError(
                    f"连续 {self._msg_read_failures} 次读 projects.db 失败，"
                    f"停止等待（库被锁 / schema 漂移 / 路径不对）：{e}"
                ) from e
            return []
        finally:
            conn.close()

    def get_room_messages_rest(self, room_id: str, limit: int = 100) -> list[dict]:
        """通过 REST API 获取房间消息（只读场景用，from 为 HUMAN_NAME）"""
        return self._api_get(f"/rooms/{room_id}/messages", params={"limit": limit})

    # ── 核心调度 API ────────────────────────────────────────────

    def dispatch(
        self,
        request: str,
        task_type: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
        role: str | None = None,
        isolated: bool = False,
        workspace_repo: str | None = None,
        request_summary: str | None = None,
        mode: str = "",
        reuse_stand: dict | None = None,
        fresh: bool = False,
    ) -> dict:
        """向 Stand 派发任务

        参数:
            mode:       工作模式一等字段（operator/worker/think/plan/fanout，见 MODES）。
                        只进审计与结果回填，不影响选模板——模板由 template_id/role/
                        task_type 决定。为空表示调用方没声明（老代码路径）。
            request:    任务描述（自然语言）
            request_summary: 一句话摘要——用作新建房间名前缀（边栏识别度）；None 时取 request 前 16 字
            task_type:  任务类型（search/coding/writing/analysis/general）；None=不按类型分派
            room_id:    指定房间（None=新建）
            template_id: 指定模板（None=自动选择）
            role:       角色分派：'thinker' | 'worker' | None
                        - 'thinker' → registry.default_thinker（见 registry.json）
                        - 'worker'  → registry.default_worker （见 registry.json）
                        优先级：template_id > role 默认 > task_type 映射 > default_template
            isolated:   工作区隔离（建议 4b）。True 时为本任务准备独立工作目录
                        （/tmp/standcode-workspaces/{task_id}/）；workspace_repo 给定时
                        走真正的 git worktree，否则只 mkdir 空目录。
                        2026-07-26 起真正生效：areco addMember 已支持 per-session cwd，
                        dispatch 会把工作目录传给 Stand（worktree 建失败时不传，如实标
                        applied=False）。默认 False——隔离要花磁盘和 git 操作，按需开。
            workspace_repo: isolated=True 时基于哪个 git 仓库建 worktree；None=只建空目录。
            reuse_stand: 复用已 spawn 好的房内 Stand（2026-07-26 提速批件）——跳过建房/
                        add_stand/BOOT_WAIT，直接向既有成员发任务。三类来源：
                        plan 预热（kind='prewarm'，room_created=False，房归 Thinker 链收口）、
                        暖池认领（kind='standby'，room_created=True，收口照常归档）、
                        旧会话复用（kind='session_reuse'，room_created=False，旧房不碰）。
                        None 且非隔离、未指定房间时，dispatch 自动依次尝试暖池认领、
                        旧会话复用（2026-07-29 高律师令，判据见 SESSION_REUSE_ENABLED 注释）。
            fresh:      「干净上下文」标记（2026-07-29）：True 时跳过旧会话复用、强制
                        spawn 新会话——擂台/基准测试公平性（各模型同起点）与任何明确
                        要求干净上下文的任务用。CLI 对应 --fresh。

        返回:
            {
                "task_id": str,
                "session_id": str,   # 房间 team 名，用于 poll_result
                "room_id": str,      # 房间短 ID
                "room_name": str,
                "stand_name": str,
                "stand_session_id": str,
                "message_id": int,
                "task_type": str,    # 实际任务类型（None→'general'）
                "template_id": str,  # 实际模板 ID
                "role": str,         # 'thinker' | 'worker'
                "workspace": str | None,     # 隔离工作目录（isolated=True 才有）
                "workspace_cwd": bool,       # Stand cwd 已真正切到 workspace（2026-07-26 冒烟 ✓）
                "stand_reused": bool,        # 走了复用通道（暖池/预热/旧会话复用）
                "standby": bool,             # 复用来源是暖池
                "route_reason": str,         # 派发路径决策（'复用旧会话(命中缓存…)' /
                                             # '新会话(无空闲/需干净上下文…)'）
            }
        """
        # 0. Gatekeeper 硬闸：命中 BLOCKED 红线（不可逆灾难性操作）→ 拒绝执行 + 记审计。
        #    check_should_dispatch 本身 advisory（只判定不拦），硬拒绝发生在此处；
        #    BLOCKED 是最高分级（隐含 production 级危险），故 category=="blocked" 即触发。
        #    先于一切副作用（不建房间、不建会话、不耗额度）。
        verdict = check_should_dispatch(request or "")
        if verdict.get("category") == "blocked":
            blocked_task_id = f"task-{uuid.uuid4().hex[:12]}"
            log_audit("dispatch_blocked", {
                "task_id": blocked_task_id,
                "mode": mode,
                "role": role or "",
                "template": "",
                "blocked": True,
                "category": "blocked",
                "reason": verdict.get("reason", ""),
                "request_preview": (request or "")[:200],
            })
            raise GatekeeperBlockedError(
                f"Gatekeeper 拒绝派发（BLOCKED）：{verdict.get('reason', '')}"
            )

        # 1. 确定模板 ID（template_id > 显式 role > task_type 映射 > 全局默认）
        #    role 优先于 task_type：dispatch_thinker/worker 的角色意图必须胜过 task_type
        #    的通用映射——否则 task_type="execute"→claude(worker) 会把 Thinker 顶成 Worker。
        if template_id:
            tid = template_id
        elif role == "thinker":
            tid = self.default_thinker_id
        elif role == "worker":
            tid = self.default_worker_id
        elif task_type and self.task_map.get(task_type):
            tid = self.task_map[task_type]
        else:
            tid = self.default_template_id
        task_id = f"task-{uuid.uuid4().hex[:12]}"
        effective_task_type = task_type or "general"
        effective_role = role or self.roles.get(tid, "worker")

        # 1.1 模板健康闸（2026-07-28 A3）：黑名单模板且 until 未到 → 硬报错，显式
        #     --template 与默认解析命中同口径，**不静默换模板**（默认角色唯一口径，
        #     静默换了审计里的 template 就撒谎）。错误信息附健康模板清单
        #     （areco 模板列表 − 在黑名单的），拿不到列表就只报错不列表。
        _blocked_until = unhealthy_until(tid)
        if _blocked_until:
            _last_err = (_read_unhealthy().get(tid) or {}).get("last_error", "")
            _healthy = sorted(t for t in self.list_template_ids() if not unhealthy_until(t))
            raise RuntimeError(
                f"模板『{tid}』因连续失败被隔离中"
                f"（至 {datetime.fromtimestamp(_blocked_until).strftime('%H:%M')}，"
                f"last_error: {str(_last_err)[:120]}）。"
                + (f"当前健康模板：{', '.join(_healthy)}。" if _healthy else "")
                + f"确认已修复用 `caller.py pool --heal {tid}` 手动解除，或等到期自动恢复。"
            )

        # 1.5 工作区隔离（默认关）。仅准备目录 + 回填结果；cwd 落地待 areco 支持。
        #     复用通道下忽略——cwd 只能在 spawn 时定，复用的 Stand 早已 spawn 完。
        workspace_info = (
            self.prepare_workspace(task_id, source_repo=workspace_repo)
            if (isolated and reuse_stand is None) else None
        )

        # 1.6 复用通道（2026-07-26 提速批件）：显式 reuse_stand（plan 预热）优先；
        #     否则暖池自动认领（无指定房、非隔离）。命中即跳过建房/add_stand/BOOT_WAIT，
        #     spawn+注入下限的 12s 冷启动税移出关键路径。
        # 1.7 旧会话复用（2026-07-29 高律师令）：暖池没命中再查同模板空闲旧会话——
        #     判据/例外见 _session_reuse_decision；route_reason 无论命中与否都写明
        #     派发路径，进结果与审计（'复用旧会话(命中缓存)' / '新会话(…)'）。
        explicit_reuse = reuse_stand is not None
        standby_hit = False
        session_reuse_hit = False
        route_reason = ""
        if reuse_stand is None and STANDBY_ENABLED and not room_id and not isolated:
            claim = self.standby_claim(tid)
            if claim:
                reuse_stand = claim
                standby_hit = True
                route_reason = "复用旧会话(暖池认领)"
        if reuse_stand is None and not room_id and not isolated:
            reuse_stand, route_reason = self._session_reuse_decision(
                tid, request, fresh=fresh)
            session_reuse_hit = reuse_stand is not None
        elif not route_reason and not explicit_reuse:
            route_reason = ("新会话(指定房间派发,不参与复用)" if room_id
                            else "新会话(隔离派发,不参与复用)")
        elif explicit_reuse:
            route_reason = "复用旧会话(显式 reuse_stand)"

        if reuse_stand:
            rid = reuse_stand["room_id"]
            team = reuse_stand["team"]
            stand_name = reuse_stand["stand_name"]
            stand_session_id = reuse_stand.get("stand_session_id", "")
            tid = reuse_stand.get("template_id", tid)
            effective_role = role or self.roles.get(tid, effective_role)
            room_created = bool(reuse_stand.get("room_created", False))
            room = {"id": rid, "name": reuse_stand.get("room_name", ""), "team": team}
            try:
                msg_id = self.send_message(team, stand_name, request, room_id=rid)
            except Exception as e:
                logger.error("复用派发失败（room=%s tid=%s）：%s", rid, tid, e)
                template_mark_failure(tid, e)  # 健康闸：复用路发消息失败也计数
                log_audit("dispatch_failed", {
                    "task_id": task_id, "mode": mode, "role": effective_role,
                    "template": tid, "room_id": rid, "error": str(e),
                    "rolled_back": room_created, "stand_reused": True,
                })
                if room_created:
                    # 暖池房是自家的，发不出去就收掉别烧看板；预热房归 Thinker 链收口，不碰
                    try:
                        self.archive_room(rid)
                        ledger_append("archived", rid, task_id=task_id,
                                      status="dispatch_failed", by="rollback")
                    except Exception as ae:
                        logger.warning("回滚归档失败 room=%s: %s", rid, ae)
                raise
            return self._finish_dispatch(
                task_id=task_id, team=team, rid=rid, room=room,
                room_created=room_created, stand_name=stand_name,
                stand_session_id=stand_session_id, msg_id=msg_id,
                effective_task_type=effective_task_type, tid=tid,
                effective_role=effective_role, mode=mode,
                workspace_info=None, room_id_param=room_id,
                isolated=isolated, explicit_reuse=explicit_reuse,
                stand_reused=True, standby_hit=standby_hit,
                route_reason=route_reason,
            )

        # 1.8 模板存在性前置校验：放在 create_room 之前。
        # 改动前 tid 不存在时会先建好房间、再在 add_stand 炸 RuntimeError，留下一个
        # 没有 Stand 的孤儿房（且当时还没写台账，rooms --sweep 都扫不到）。
        # 典型触发：registry.json 列了 zcode，但 areco 侧根本没有这个模板。
        self._assert_template_exists(tid)

        # 2. 创建或使用已有房间
        # room_created 决定收口时能不能归档：只有自己新建的房间才归得，用户传进来的
        # 房间（复用/人手建的案件房）一律不碰，也不进台账——台账即「StandCode 的地盘」，
        # 混进别人的房间会让 rooms --sweep 误扫。
        room_created = not bool(room_id)
        if room_id:
            room = self.get_room(room_id)
            # 已归档房间：areco 的 deliverMentions 开头就 `if (room.archivedAt !== null) return`，
            # 消息写进去也永远不投递。而 --wait 默认 timeout=0（无限等），于是等待者进程
            # 静默挂死、不报错、不写 inbox。宁可当场炸。
            if room.get("archivedAt") is not None:
                raise RuntimeError(
                    f"房间 {room_id} 已归档，areco 不会投递消息（--wait 会无限等）。"
                    f"先在 UI「恢复任务」，或不传 --room-id 让它新建。"
                )

        else:
            room = self.create_room(
                _room_label(request, request_summary, effective_role)
            )

        team = room["team"]
        rid = room["id"]

        # 台账先落再干活：改动前 ledger_append 在 send_message 之后，中途炸掉的房间
        # 不进台账 = rooms --sweep 永远扫不到 = 孤儿房只能人工发现。
        if room_created:
            ledger_append(
                "created", rid,
                task_id=task_id, room_name=room.get("name", ""), team=team,
                role=effective_role, template_id=tid, task_type=effective_task_type,
                request_preview=(request or "")[:120], pid=os.getpid(),
            )

        # 3-5 步任一失败都要回滚：自建的房间归档掉，别留着烧额度。
        try:
            # 3. 添加 Stand（agent session）
            # 隔离工作区落地：areco 2026-07-26 起 addMember 收 cwd。
            # 只在 worktree 真建成时才传——kind 以 failed: 开头说明 git 没成，
            # 这时传过去 areco 会 400，不如让它用模板默认目录并在结果里如实标 applied=False。
            ws_cwd = None
            if workspace_info and not str(workspace_info.get("kind", "")).startswith("failed"):
                ws_cwd = workspace_info.get("path")
            member = self.add_stand(rid, tid, cwd=ws_cwd)
            if ws_cwd:
                workspace_info["applied"] = True
            stand_name = member["name"]
            stand_session_id = member.get("sessionId", "")

            # 4. 启动等待已删（2026-07-30 P1-5）：投递链自带 MIN_BOOT + onceQuiet 挡竞态，
            #    见 BOOT_WAIT_SEC 注释；默认 0 不睡，应急时 env/config 回填秒数
            if BOOT_WAIT_SEC > 0:
                time.sleep(BOOT_WAIT_SEC)

            # 5. 向房间发送任务消息（REST 快路优先，SQLite 直写兜底）
            msg_id = self.send_message(team, stand_name, request, room_id=rid)
        except Exception as e:
            logger.error("派发中途失败（room=%s tid=%s）：%s", rid, tid, e)
            template_mark_failure(tid, e)  # 健康闸：建房/add_stand/发消息失败回滚路径计数
            log_audit("dispatch_failed", {
                "task_id": task_id, "mode": mode, "role": effective_role,
                "template": tid, "room_id": rid, "error": str(e),
                "rolled_back": room_created,
            })
            if room_created:
                # 自己建的才收拾；用户传进来的房间不碰
                try:
                    self.archive_room(rid)
                    ledger_append("archived", rid, task_id=task_id,
                                  status="dispatch_failed", by="rollback")
                except Exception as ae:
                    logger.warning("回滚归档失败 room=%s: %s", rid, ae)
                    ledger_append("kept", rid, task_id=task_id,
                                  status="dispatch_failed", reason=f"rollback_failed: {ae}")
            raise

        return self._finish_dispatch(
            task_id=task_id, team=team, rid=rid, room=room,
            room_created=room_created, stand_name=stand_name,
            stand_session_id=stand_session_id, msg_id=msg_id,
            effective_task_type=effective_task_type, tid=tid,
            effective_role=effective_role, mode=mode,
            workspace_info=workspace_info, room_id_param=room_id,
            isolated=isolated, explicit_reuse=False,
            stand_reused=False, standby_hit=False,
            route_reason=route_reason,
        )

    def _finish_dispatch(
        self, *, task_id, team, rid, room, room_created, stand_name,
        stand_session_id, msg_id, effective_task_type, tid, effective_role,
        mode, workspace_info, room_id_param, isolated, explicit_reuse,
        stand_reused, standby_hit, route_reason,
    ) -> dict:
        """dispatch 收尾（冷启动/复用两条路共用）：result 组装、台账、审计、面包屑、补胎。"""
        template_mark_success(tid)  # 健康闸：派发走通一次即清除该模板黑名单记录
        result = {
            "task_id": task_id,
            "session_id": team,
            "room_id": rid,
            "room_name": room.get("name", ""),
            "room_created": room_created,
            "stand_name": stand_name,
            "stand_session_id": stand_session_id,
            "message_id": msg_id,
            "task_type": effective_task_type,
            "template_id": tid,
            "role": effective_role,
            "mode": mode,
            "stand_reused": stand_reused,
            "standby": standby_hit,
            "route_reason": route_reason,
            "workspace": (workspace_info or {}).get("path"),
            "workspace_cwd": bool((workspace_info or {}).get("applied", False)),
        }
        if room_created and not stand_reused:
            # 补一条带 Stand 信息的台账（created 已在建房后先落，这里只是补全）；
            # 复用路的 Stand 在补胎/预热时已各自落账，不重复。
            ledger_append(
                "stand_added", rid,
                task_id=task_id, stand_name=stand_name,
                stand_session_id=stand_session_id, template_id=tid,
            )
        log_audit("dispatch", {
            "task_id": task_id,
            "mode": mode,
            "role": effective_role,
            "template": tid,
            "blocked": False,
            "task_type": effective_task_type,
            "room_id": rid,
            "stand_name": stand_name,
            "room_reused": not room_created,
            "stand_reused": stand_reused,
            "standby": standby_hit,
            "route_reason": route_reason,
        })
        logger.info(
            "派发任务: session=%s room=%s stand=%s mode=%s role=%s task_type=%s tid=%s reuse=%s route=%s",
            team, rid, stand_name, mode or "-", effective_role, effective_task_type, tid,
            (("standby" if standby_hit
              else "session" if "命中缓存" in (route_reason or "")
              else "prewarm") if stand_reused else "-"),
            route_reason or "-",
        )
        hook = getattr(self, "_on_dispatch", None)
        if hook:
            try:
                hook(result)  # 面包屑：等待者把房间/水位线即时落 state，供 reconcile 死后定位
            except Exception as e:
                logger.warning("dispatch 面包屑回调失败（不影响派发）: %s", e)
        # 补胎：暖池开着、本单没走显式复用（预热房另有归属）、也不是定向老房/隔离派发时，
        # 用掉即补 / 冷启动播种——让下一单同模板免掉冷启动税。inline 只多 ~1s HTTP，
        # 且发生在任务消息已入库之后，不拖慢本单注入。
        if STANDBY_ENABLED and not isolated and room_id_param is None and not explicit_reuse:
            self.standby_refill(tid)
        return result

    # ── 角色分派便利方法（Caller → Thinker / Worker）─────────────

    def dispatch_thinker(
        self,
        request: str,
        task_type: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
        plan_only: bool = False,
        request_summary: str | None = None,
        mode: str = "think",
        reuse_stand: dict | None = None,
        fresh: bool = False,
    ) -> dict:
        """派给 Thinker（registry.default_thinker）：规划、分析、判断、路由

        plan_only=True 时强制「只规划不执行」：把 request 包进 PLAN_TEMPLATE，
        要求 Thinker 按「目标/上下文/步骤/约束/判据/落点」结构化产出可执行计划，
        供 Worker（registry.default_worker）直接执行。用于 plan_and_execute 的 Thinker 阶段，
        以及 `run --mode think --plan-only`（模式 4 只要计划、执行另议）。

        plan_only=False 则原文直派——这是模式 4 的默认形态：要的是判断（结论/取舍），
        自由格式回答正合适，不该被六段模板逼成待办清单（见 presets.thinker_only）。
        """
        if plan_only:
            request = PLAN_TEMPLATE.format(request=request)
        return self.dispatch(
            request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role="thinker",
            request_summary=request_summary,
            mode=mode,
            reuse_stand=reuse_stand,
            fresh=fresh,
        )

    def dispatch_worker(
        self,
        request: str,
        task_type: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
        request_summary: str | None = None,
        mode: str = "worker",
        reuse_stand: dict | None = None,
        isolated: bool = False,
        workspace_repo: str | None = None,
        fresh: bool = False,
    ) -> dict:
        """派给 Worker（registry.default_worker；⑤ 反转后默认车道=hy3 轻车）。

        搜索/下载/总结类默认活直接用本方法；法律/代码重活要落主力（claude/GLM-5.2）
        须显式传 template_id=caller.default_heavy_worker_id——route_mode 的 worker
        模式在 run 链路里已经这么做，这里不重复判词。"""
        return self.dispatch(
            request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role="worker",
            request_summary=request_summary,
            mode=mode,
            reuse_stand=reuse_stand,
            isolated=isolated,
            workspace_repo=workspace_repo,
            fresh=fresh,
        )

    def poll_result(
        self,
        room_id: str | None = None,
        session_id: str | None = None,
        timeout: int = 600,
        poll_interval: float = POLL_INTERVAL_SEC,
        stand_session_id: str | None = None,
        after_id: int = 0,
        *,
        stand_name: str = "",
        task_id: str = "",
        role: str = "",
        template: str = "",
    ) -> dict:
        """轮询 Stand 执行结果（Caller 主动拉，不依赖 Stand 自汇报 cc-send）

        ⚠️ after_id / stand_name 不是可选装饰，是正确性前提（2026-07-26 审计）：
        本方法「按排除法」认 Stand（非 Caller 非用户即 Stand），且 after_id 默认 0 =
        从房间第 1 条消息读起。两者叠加会在两种场景下立刻返回**别人的旧话**当本次结果：
            · 复用房间（run --room-id / _bg_worker 的 spec.room_id）→ 秒回三天前的老答案
            · 同房间多 Stand（两段式共享房）→ Worker 的 poll 秒回 Thinker 的计划
        所以调用方必须把 dispatch() 返回的 message_id / stand_name 传进来：
            after_id=d["message_id"]  → 只看「我这条任务消息之后」的
            stand_name=d["stand_name"] → 只认「我派的那个 Stand」说的

        参数:
            room_id:  房间短 ID（REST 兜底/日志用；可为 None）
            session_id: dispatch() 返回的 session_id（房间 team 名，如 "room-xxxx"）。必填。
            timeout:  最大等待秒数（默认 600）；<=0 表示无限等待，直到 Stand 完成/失联
            poll_interval: 轮询间隔
            stand_session_id: Stand 的 areco session ID（可选，检测 Stand 提前退出）
            after_id: 只看 id>此值的消息。**传 dispatch() 的 message_id**；0 = 从头读（危险，见上）
            stand_name: 只认这个发件人的回复。**传 dispatch() 的 stand_name**；
                        空 = 退回排除法（兼容老调用方，但同房多 Stand 会串台）
            task_id/role/template: 仅用于审计日志（log_audit），由上层 dispatch 结果透传；
                缺省空串——审计仍写，只是 task_id 一列留空。

        红绿灯（2026-07-26 接入 areco trafficState，微信「汇报不准/卡死没人管」两症同治）:
            · 有回复 ≠ 干完了：Stand 先应一句「收到」再干十分钟，旧逻辑合并窗一过就把
              这句当最终结果。现在定稿前看灯——working = 还在干，继续等并入后续回复；
              conclusion/idle/exited/无灯可看才定稿（SETTLE_MAX_SEC 兜底灯坏死）。
            · ⑥ 两道闸校准（2026-07-29）：定稿闸——回复须「像交付物」（结论段/产物
              路径/数字结果之一）才吃 MERGE_WAIT_SEC 短窗，纯进度句改吃
              PROGRESS_SETTLE_SEC 续等窗；空转闸——stall 判死须同时满足 idle 探针
              达标 + 首字等待超 FIRST_TOKEN_MAX_SEC + 看板新鲜复核零产出。
            · 三闸全关（2026-07-29 高律师令，覆盖同日⑥口径）：STALL_WATCHDOG_ENABLED /
              SETTLE_GATE_ENABLED / HARD_TIMEOUT_ENABLED 三常量默认 False——不判
              空转不重投、收网只认 Worker 自报（有回复即按合并窗收）、灯 working
              等待无上限。闸逻辑保留未删，重开改 True；stuck（needs-user）与
              lost（exited/心跳）不属三闸，照常生效。
            · stuck：trafficState=needs-user（终端内权限框/信任页/选择框）连续
              STUCK_CONFIRM_HITS 个探针周期 → 返回 status='stuck' 带尾屏 last_line。
              timeout=0 无限等 + 卡选项曾是致命组合：黄灯亮着、等待者永远傻等。

        返回:
            {
                "session_id": str,
                "room_id": str | None,
                "status": "completed" | "stuck" | "stall" | "lost" | "timeout" | "error",
                "result_text": str,         # Stand 回复合并文本（completed/stuck 才有，stuck 为部分结果）
                "stand_replies": [...],     # 仅 Stand 的回复（排除 Hermes/用户）
                "elapsed": float,           # 耗时（秒）
                "completed_at": str | None, # ISO 完成时间
                "messages_count": int,
                "error": str | None,
            }
        """
        if not session_id:
            raise ValueError("poll_result 需要 session_id（房间 team 名，如 room-xxxx）")

        deadline = time.time() + timeout
        start_time = time.time()
        last_id = after_id
        stand_replies: list[dict] = []
        last_status_check = 0.0
        needs_user_hits = 0
        sess_info: dict | None = None
        first_reply_at = 0.0
        last_reply_at = 0.0
        last_output_chars: int | None = None
        output_stall_probes = 0
        idle_hits = 0
        reinjected = False

        def _is_my_stand(sender: str) -> bool:
            """这条消息算不算「我派的那个 Stand 的回复」"""
            if not sender or sender in NON_STAND_SENDERS:
                return False
            # stand_name 给了就精确认人；没给退回排除法（老调用方兼容）
            return (sender == stand_name) if stand_name else True

        if not stand_name or not after_id:
            logger.warning(
                "poll_result 未收到 %s —— 复用房间/同房多 Stand 时可能把别人的旧消息当本次结果"
                "（session=%s）",
                " 和 ".join(x for x in (["stand_name"] if not stand_name else [])
                            + (["after_id"] if not after_id else [])),
                session_id,
            )

        logger.info(
            "开始轮询 session=%s room=%s timeout=%ds",
            session_id, room_id, timeout,
        )

        while timeout <= 0 or time.time() < deadline:  # timeout<=0：跳过超时，无限轮询直到完成/失联
            # 1) 拉增量消息
            try:
                messages = self.get_messages(session_id, after_id=last_id)
            except RuntimeError:
                # get_messages 连续失败 ≥MSG_READ_FAIL_LIMIT 的上抛是致命信号（库被锁/
                # schema 漂移），必须穿透给上层转 error 终态。吞掉的话 timeout=0 时进程
                # 每轮立即再抛、0.5s 空转永挂——既不报错也不写 inbox（2026-07-28 A1）。
                raise
            except Exception as e:
                logger.warning("查询消息失败: %s", e)
                time.sleep(poll_interval)
                continue

            for msg in messages:
                last_id = max(last_id, msg.get("id", 0))
                if _is_my_stand(msg.get("from_agent", "")):
                    stand_replies.append(msg)
                    last_reply_at = time.time()
                    if not first_reply_at:
                        first_reply_at = time.time()
                    # 额度/限流扫描（2026-07-29 机制）：Stand 回复命中信号词即
                    # 停新单+车道改道+微信告警；handle_quota_hit 幂等不刷屏。
                    hit = quota_signal_hit(msg.get("body") or "")
                    if hit:
                        handle_quota_hit(
                            template or msg.get("from_agent", "") or "unknown",
                            hit, source=f"poll:{session_id}",
                            sample=(msg.get("body") or "")[:120],
                        )

            # 2) 会话状态探针（节流 STATE_PROBE_SEC，一次 API 供 stuck/lost/settle 三判共用）
            traffic: str | None = None
            if stand_session_id:
                if time.time() - last_status_check > STATE_PROBE_SEC:
                    last_status_check = time.time()
                    sess_info = self._session_info(stand_session_id)
                    oc = (sess_info or {}).get("outputChars")
                    if oc is not None and oc == last_output_chars:
                        output_stall_probes += 1
                    else:
                        output_stall_probes = 0
                        last_output_chars = oc
                    if (sess_info or {}).get("trafficState") == "idle" and not stand_replies:
                        idle_hits += 1
                    else:
                        idle_hits = 0
                traffic = (sess_info or {}).get("trafficState")

                # 2a) stuck：needs-user（终端内权限框/选择框/信任页，红绿灯黄灯）连续
                #     STUCK_CONFIRM_HITS 个探针周期 → 判卡死返回，不再无限傻等。
                #     单次命中不算：注入回显/瞬时 UI 会闪一下黄灯。
                if traffic == "needs-user":
                    needs_user_hits += 1
                    if needs_user_hits >= STUCK_CONFIRM_HITS:
                        elapsed = round(time.time() - start_time, 2)
                        partial = "\n\n".join(
                            m.get("body", "") for m in stand_replies if m.get("body")
                        ).strip()
                        last_line = (sess_info or {}).get("lastLine") or ""
                        logger.warning(
                            "Stand 卡在交互选项: session=%s stand=%s last_line=%r",
                            session_id, stand_session_id, last_line[:120],
                        )
                        log_audit("poll_stuck", {
                            "task_id": task_id, "role": role, "template": template,
                            "blocked": False, "session_id": session_id,
                            "room_id": room_id, "stand_session_id": stand_session_id,
                            "elapsed": elapsed, "last_line": last_line[:200],
                        })
                        return {
                            "session_id": session_id,
                            "room_id": room_id,
                            "status": "stuck",
                            "result_text": partial,
                            "stand_replies": stand_replies,
                            "elapsed": elapsed,
                            "completed_at": None,
                            "messages_count": last_id,
                            "stuck_last_line": last_line,
                            "error": (
                                f"Stand 卡在交互选项等人工确认（needs-user，尾屏：{last_line[:120]}）——"
                                f"去 areco 看板点开会话 {stand_session_id[:8]} 处理"
                            ),
                        }
                else:
                    needs_user_hits = 0

                # 2b) lost：两路信号（建议 4a·会话可靠性）——
                #     (a) areco 会话 status==exited：主信号（但已有回复时不算失联，
                #         干完活正常退出属收尾，走 settle）；
                #     (b) 心跳文件过期：辅信号，仅 Stand 宿主写了心跳才有意义。
                if not stand_replies:
                    lost_reason: str | None = None
                    ses = (sess_info or {}).get("status")
                    hb = heartbeat_stale(stand_session_id)  # None=无文件，True=过期，False=新鲜
                    if ses == "exited":
                        lost_reason = f"session_exited（areco 报 {stand_session_id}=exited）"
                    elif hb is True:
                        lost_reason = (
                            f"heartbeat_stale（{stand_session_id}.hb 超过 "
                            f"{HEARTBEAT_STALE_SEC:.0f}s 未更新）"
                        )
                    if lost_reason:
                        elapsed = round(time.time() - start_time, 2)
                        logger.warning("Stand 失联: session=%s stand=%s reason=%s",
                                       session_id, stand_session_id, lost_reason)
                        log_audit("poll_lost", {
                            "task_id": task_id,
                            "role": role,
                            "template": template,
                            "blocked": False,
                            "session_id": session_id,
                            "room_id": room_id,
                            "stand_session_id": stand_session_id,
                            "elapsed": elapsed,
                            "lost_reason": lost_reason,
                        })
                        return {
                            "session_id": session_id,
                            "room_id": room_id,
                            "status": "lost",
                            "result_text": "",
                            "stand_replies": [],
                            "elapsed": elapsed,
                            "completed_at": None,
                            "messages_count": last_id,
                            "lost_reason": lost_reason,
                            "error_code": classify_error_code("lost", lost_reason=lost_reason),
                            "error": f"Stand 失联：{lost_reason}",
                        }

            # 2c) 空转自愈（2026-07-26 B4 e2e 实战捕获）：任务消息落库但会话 idle 零回复
            #     ——注入丢失或模型秒退。达 IDLE_STALL_PROBES 个探针重投一次任务原文
            #     （从房间按 after_id 取回，新消息触发投递链重新注入）；翻倍仍空转
            #     → status='stall' 交人工。after_id=0 的老调用方取不到原文，不重投只报 stall。
            #     ⑥ 校准（2026-07-29 高律师批）：idle×N 只是嫌疑不是死刑——当日
            #     flash/Fable5/GLM/kimi/agnes 全被 90s 口径误杀过（慢思考模型首字 90s+
            #     是常态，灯 idle ≠ 没在干）。重投/判死前先新鲜拉一次看板复核：
            #     outputChars 仍在涨（spinner/思考流都会推高）或灯已非 idle → 判据推翻、
            #     归零重数；判死另须首字等待超 FIRST_TOKEN_MAX_SEC（默认 300s）。
            #     2026-07-29 高律师令三闸全关：STALL_WATCHDOG_ENABLED=False 整段停用
            #     （不判空转、不杀会话、不重投），重开改常量 True。
            if (STALL_WATCHDOG_ENABLED and stand_session_id
                    and not stand_replies and idle_hits):
                want_reinject = (idle_hits >= IDLE_STALL_PROBES
                                 and not reinjected and after_id > 0)
                want_stall = (idle_hits >= IDLE_STALL_PROBES * 2
                              and time.time() - start_time >= FIRST_TOKEN_MAX_SEC)
                producing = False
                if want_reinject or want_stall:
                    # 杀/扰动前的看板复核：绕开 STATE_PROBE_SEC 节流缓存现场拉一次
                    fresh = self._session_info(stand_session_id) or {}
                    fresh_oc = fresh.get("outputChars")
                    producing = (
                        fresh.get("trafficState") not in (None, "idle")
                        or (fresh_oc is not None and fresh_oc > (last_output_chars or 0))
                    )
                    if producing:
                        logger.info(
                            "空转判据被看板复核推翻: session=%s idle×%d 但会话有产出"
                            "（outputChars %s→%s traffic=%s），归零重数",
                            session_id, idle_hits, last_output_chars, fresh_oc,
                            fresh.get("trafficState"),
                        )
                        idle_hits = 0
                        sess_info = fresh
                        if fresh_oc is not None:
                            last_output_chars = fresh_oc
                if want_reinject and not producing:
                    reinjected = True
                    try:
                        origin = next(
                            (m for m in self.get_messages(session_id, after_id=max(0, after_id - 1))
                             if m.get("id") == after_id), None)
                        if origin and origin.get("body"):
                            self.send_message(session_id, stand_name or "all", origin["body"],
                                              room_id=room_id or "")
                            logger.warning("Stand 空转（idle×%d，看板复核零产出），已重投任务消息: session=%s",
                                           idle_hits, session_id)
                            log_audit("poll_reinject", {
                                "task_id": task_id, "role": role, "template": template,
                                "blocked": False, "session_id": session_id, "room_id": room_id,
                                "stand_session_id": stand_session_id, "idle_hits": idle_hits,
                            })
                    except Exception as e:
                        logger.warning("重投失败: %s", e)
                elif want_stall and not producing:
                    elapsed = round(time.time() - start_time, 2)
                    last_line = (sess_info or {}).get("lastLine") or ""
                    log_audit("poll_stall", {
                        "task_id": task_id, "role": role, "template": template,
                        "blocked": False, "session_id": session_id, "room_id": room_id,
                        "stand_session_id": stand_session_id, "elapsed": elapsed,
                        "reinjected": reinjected,
                        "first_token_max": FIRST_TOKEN_MAX_SEC,
                    })
                    return {
                        "session_id": session_id,
                        "room_id": room_id,
                        "status": "stall",
                        "result_text": "",
                        "stand_replies": [],
                        "elapsed": elapsed,
                        "completed_at": None,
                        "messages_count": last_id,
                        "stuck_last_line": last_line,
                        "error": (
                            f"Stand 空转：任务已投递 {elapsed:.0f}s 会话零产出"
                            f"（首字上限 {FIRST_TOKEN_MAX_SEC:.0f}s 已过，看板复核确认）"
                            + ("（已重投一次仍无效）" if reinjected else "")
                            + "——疑注入丢失或模型秒退，去 areco 看板查看会话"
                        ),
                    }

            # 3) 定稿判定：有回复 ≠ 干完了（「先应一句收到再干十分钟」曾被截成最终结果）。
            #    读得到红绿灯时，working = 还在干 → 继续等并入后续回复；
            #    conclusion/idle/exited/读不到灯 → 静默 MERGE_WAIT_SEC 后定稿（原合并窗口径）；
            #    灯坏死兜底：首条回复起 SETTLE_MAX_SEC 仍 working，强制定稿（记 settle_forced）。
            #    ⑥ 定稿闸收紧（2026-07-29 高律师批）：短合并窗只对「像交付物」的回复开放
            #    （含结论段/产物路径/数字结果之一，见 _looks_like_deliverable）；纯进度句
            #    （「我先…」「让我来…」）改吃 PROGRESS_SETTLE_SEC 续等窗——窗内新回复刷新
            #    last_reply_at、终端输出增长由 output_stall_probes 兜着，都会让它继续等。
            #    当日实证：任务① 25min / ④ 124s / 黎官检索 1167s 全是第一条进度句刚到
            #    就被收网，真结果烂在房里。
            if stand_replies:
                settle = False
                settle_forced = False
                settle_reason = None
                # 2026-07-29 高律师令三闸全关：SETTLE_GATE_ENABLED=False 时一律视为
                # 交付物（收网只认 Worker 自报完成，回复即自报）——交付物门槛/进度句
                # 续等窗全停，wedge 与合并窗退回 ⑥ 前口径；重开改常量 True。
                deliverable = True if not SETTLE_GATE_ENABLED else _looks_like_deliverable(
                    "\n\n".join(m.get("body", "") for m in stand_replies if m.get("body"))
                )
                if stand_session_id and traffic == "working":
                    # tool 尾假 working（B4 e2e 实测多等 9 分钟）：agent 用 areco-msg 回执后
                    # turn 以工具调用收尾，transcript 灯不落绿——outputChars 连续
                    # OUTPUT_STALL_PROBES 个探针零增长 = 没在干活，收口。
                    # ⑥：手里只有进度句时 wedge 不收（④ 的 124s 收网正是「灯 working +
                    # 首字长思考零输出增长 + 一句开工白」），续等满进度窗才放行。
                    if output_stall_probes >= OUTPUT_STALL_PROBES and (
                            deliverable
                            or time.time() - last_reply_at >= PROGRESS_SETTLE_SEC):
                        settle = settle_forced = True
                        settle_reason = "working_wedged"
                        logger.info(
                            "定稿: session=%s 灯 working 但输出 %d 探针零增长（tool 尾假 working），收口",
                            session_id, output_stall_probes,
                        )
                    elif (HARD_TIMEOUT_ENABLED
                          and time.time() - first_reply_at >= SETTLE_MAX_SEC):
                        # 2026-07-29 高律师令三闸全关：HARD_TIMEOUT_ENABLED=False 时
                        # 灯 working 等待无上限，不再 hold_cap 强制定稿。
                        settle = settle_forced = True
                        settle_reason = "hold_cap"
                        logger.warning(
                            "定稿兜底: session=%s 首条回复已 %.0fs 灯仍 working，强制定稿",
                            session_id, time.time() - first_reply_at,
                        )
                elif stand_session_id and traffic == "needs-user":
                    pass  # 黄灯累计期：等 stuck 判定或灯变绿，不定稿
                else:
                    # conclusion/idle/exited/无灯可读（老调用方没传 stand_session_id）
                    quiet = time.time() - last_reply_at
                    if deliverable:
                        settle = quiet >= MERGE_WAIT_SEC
                    else:
                        # 纯进度句：静满续等窗才定稿；有探针时还须输出确已停增
                        # （≥2 个探针零增长 ≈ 10s），防灯短暂落绿但终端还在打字。
                        settle = (quiet >= PROGRESS_SETTLE_SEC
                                  and (not stand_session_id or output_stall_probes >= 2))
                        if settle:
                            settle_reason = "progress_timeout"
                if settle:
                    try:
                        tail = self.get_messages(session_id, after_id=last_id)
                        for msg in tail:
                            last_id = max(last_id, msg.get("id", 0))
                            if _is_my_stand(msg.get("from_agent", "")):
                                stand_replies.append(msg)
                    except Exception:
                        pass
                    result_text = "\n\n".join(
                        m.get("body", "") for m in stand_replies if m.get("body")
                    ).strip()
                    elapsed = round(time.time() - start_time, 2)
                    logger.info(
                        "轮询完成: session=%s %d 条 Stand 回复（耗时 %.1fs%s）",
                        session_id, len(stand_replies), elapsed,
                        "，settle_forced" if settle_forced else "",
                    )
                    log_audit("poll_completed", {
                        "task_id": task_id,
                        "role": role,
                        "template": template,
                        "blocked": False,
                        "session_id": session_id,
                        "room_id": room_id,
                        "elapsed": elapsed,
                        "messages_count": last_id,
                        "settle_forced": settle_forced,
                        "settle_reason": settle_reason,
                    })
                    return {
                        "session_id": session_id,
                        "room_id": room_id,
                        "status": "completed",
                        "result_text": result_text,
                        "stand_replies": stand_replies,
                        "elapsed": elapsed,
                        "completed_at": _now_iso(),
                        "messages_count": last_id,
                        "settle_forced": settle_forced or None,
                        "settle_reason": settle_reason,
                        "error": None,
                    }

            time.sleep(poll_interval)

        # 死线终检（2026-07-27 25民1000 实证：Worker 死线前 8s 已交活，灯未落绿被判
        # timeout，完整结果连 stand_replies 一起被扔）。到点先补拉一次增量；手里有货
        # 就按 settle_forced 定稿（reason=deadline），到手结果绝不扔——更迟的回复由
        # reconcile 的 completed+settle_forced 分支继续兜。
        try:
            for msg in self.get_messages(session_id, after_id=last_id):
                last_id = max(last_id, msg.get("id", 0))
                if _is_my_stand(msg.get("from_agent", "")):
                    stand_replies.append(msg)
        except Exception:
            pass
        elapsed = round(time.time() - start_time, 2)
        if stand_replies:
            result_text = "\n\n".join(
                m.get("body", "") for m in stand_replies if m.get("body")
            ).strip()
            logger.warning(
                "死线定稿: session=%s 超时 %ds 但已收 %d 条回复，按 settle_forced 收口",
                session_id, timeout, len(stand_replies),
            )
            log_audit("poll_completed", {
                "task_id": task_id,
                "role": role,
                "template": template,
                "blocked": False,
                "session_id": session_id,
                "room_id": room_id,
                "elapsed": elapsed,
                "messages_count": last_id,
                "settle_forced": True,
                "settle_reason": "deadline",
            })
            return {
                "session_id": session_id,
                "room_id": room_id,
                "status": "completed",
                "result_text": result_text,
                "stand_replies": stand_replies,
                "elapsed": elapsed,
                "completed_at": _now_iso(),
                "messages_count": last_id,
                "settle_forced": True,
                "settle_reason": "deadline",
                "error": None,
            }
        logger.warning("轮询超时: session=%s timeout=%ds", session_id, timeout)
        log_audit("poll_timeout", {
            "task_id": task_id,
            "role": role,
            "template": template,
            "blocked": False,
            "session_id": session_id,
            "room_id": room_id,
            "elapsed": elapsed,
            "messages_count": last_id,
        })
        return {
            "session_id": session_id,
            "room_id": room_id,
            "status": "timeout",
            "result_text": "",
            "stand_replies": [],
            "elapsed": elapsed,
            "completed_at": None,
            "messages_count": last_id,
            "error_code": "timeout",
            "error": f"轮询超时（{timeout}s）",
        }

    def _session_info(self, session_id: str) -> dict | None:
        """best-effort 查 areco 会话对象（status/trafficState/lastLine…）。失败返回 None。

        走 GET /api/sessions 列表线性匹配；只读，不改 areco 服务端。
        trafficState 是 areco 红绿灯（working/needs-user/conclusion/idle/exited），
        needs-user 由 transcript 尾消息 + 影子终端尾屏对话框检测双路判出——poll 的
        stuck/定稿判定都吃它，服务端已有的能力不重造。
        """
        try:
            data = self._api_get("/sessions")
            sessions = data if isinstance(data, list) else data.get("sessions", [])
            for s in sessions:
                if s.get("id") == session_id:
                    return s
        except Exception:
            return None
        return None

    def _session_status(self, session_id: str) -> str | None:
        """[兼容薄壳] 只要 status 字段时用；新代码用 _session_info。"""
        info = self._session_info(session_id)
        return info.get("status") if info else None

    def collect_stand_cost(self, stand_session_id: str) -> dict | None:
        """每单 token 成本（2026-07-26 借 agentacct「usage truth from client logs」）。

        只信客户端自己落盘的数字：读该 Stand 的 claude transcript JSONL 汇总
        message.usage，结果标 source=client_reported；任何一环拿不到就返回 None——
        **绝不估算编数**（agentacct 的纪律：cost 是 estimate 要明标，拿不到就没有）。
        非 claude harness（workbuddy/reasonix 等）无此 transcript → None，回执自然省略。
        """
        if not stand_session_id:
            return None
        try:
            info = self._session_info(stand_session_id) or {}
            csid = info.get("claudeSessionId") or ""
            tdir = info.get("transcriptDir") or ""
            if not csid or not tdir:
                return None
            tp = Path(tdir) / f"{csid}.jsonl"
            if not tp.exists():
                return None
            inp = outp = cread = 0
            with tp.open(encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        u = (json.loads(line).get("message") or {}).get("usage") or {}
                    except (json.JSONDecodeError, AttributeError):
                        continue
                    inp += int(u.get("input_tokens") or 0)
                    outp += int(u.get("output_tokens") or 0)
                    cread += int(u.get("cache_read_input_tokens") or 0)
            if not (inp or outp or cread):
                return None
            return {"input_tokens": inp, "output_tokens": outp,
                    "cache_read_tokens": cread, "source": "client_reported"}
        except Exception as e:
            logger.debug("collect_stand_cost 失败（best-effort，忽略）: %s", e)
            return None

    # ── ask 通道（点名 agent：空闲直投 / 忙则并行）────────────────

    def resolve_ask_channel(self, room_id: str | None = None,
                            member: str | None = None) -> dict:
        """定位常驻通道：房间 + 成员 + 背后的 areco 会话。

        解析顺序：显式参数 > 配置（env/local.json ask_channel）> 按成员名全房搜索。
        任何一步失败都不抛死——ask 的兜底永远是 fork（新房并行），通道只是
        「上下文连续 + 免冷启动」的优化，不可用不该挡交付。

        返回（ok=False 时只保证 member/template_id/reason 三键可用）：
            {"ok": bool, "reason": str,
             "room_id", "team", "room_name", "member",
             "session_id", "session": dict|None,   # areco 会话对象（trafficState 等）
             "template_id": str}                    # fork 用模板：会话 templateId 优先
        """
        want = (member or ASK_MEMBER).strip()
        rid = (room_id or ASK_ROOM_ID).strip()
        base = {"ok": False, "member": want, "template_id": ASK_TEMPLATE_FALLBACK}
        try:
            rooms = self.list_rooms()  # 已滤归档：归档房 room-relay 整体跳过，投了也不达
        except Exception as e:
            return {**base, "reason": f"读房间列表失败: {e}"}
        room = next((r for r in rooms if r.get("id") == rid), None) if rid else None
        if room is None:
            # 配置漂移兜底：按成员名搜，唯一命中才认——命中多个宁可报不可用（fork），
            # 也不猜着往某个房里投
            hits = [
                r for r in rooms
                if any(m.get("kind") == "session" and m.get("name") == want
                       for m in r.get("members", []))
            ]
            if len(hits) == 1:
                room = hits[0]
            elif hits:
                return {**base, "reason":
                        f"成员 {want} 出现在 {len(hits)} 个房间，无法唯一定位——"
                        f"在 config/local.json ask_channel.room_id 指定一个"}
        if room is None:
            return {**base, "reason":
                    f"找不到含会话成员 {want} 的未归档房间（配置 room_id={rid or '未设'}）"}
        mem = next((m for m in room.get("members", [])
                    if m.get("kind") == "session" and m.get("name") == want), None)
        if mem is None or not mem.get("sessionId"):
            return {**base, "room_id": room.get("id"), "reason":
                    f"房间 {room.get('id')} 里没有名为 {want} 的会话成员"}
        sess = self._session_info(mem["sessionId"])
        return {
            "ok": True, "reason": "",
            "room_id": room.get("id"), "team": room.get("team"),
            "room_name": room.get("name", ""), "member": want,
            "session_id": mem["sessionId"], "session": sess,
            "template_id": (sess or {}).get("templateId") or ASK_TEMPLATE_FALLBACK,
        }

    @staticmethod
    def ask_channel_probe(channel: dict) -> tuple[str, str]:
        """通道现况 → ('direct'|'fork', 缘由)。看 areco 红绿灯实测，不猜。"""
        if not channel.get("ok"):
            return "fork", channel.get("reason") or "通道不可用"
        sess = channel.get("session")
        if not sess:
            # 会话对象查无（被删/API 抖动）：直投可能落空，宁可 fork 保交付
            return "fork", "通道会话查无（可能已删除），另开并行任务保交付"
        status = sess.get("status") or ""
        traffic = sess.get("trafficState") or ""
        if status == "error":
            return "fork", "通道会话 status=error，另开并行任务保交付"
        if traffic in ASK_BUSY_STATES:
            return "fork", f"通道会话正忙（trafficState={traffic}），另开并行任务"
        return "direct", f"通道空闲（status={status or '?'} traffic={traffic or '?'}）"

    # ── 旧会话复用（2026-07-29 高律师令；判据总纲见 SESSION_REUSE_ENABLED 注释）──

    def _session_context_tokens(self, sess: dict) -> int | None:
        """会话当前上下文占用估算基数；拿不到返回 None。

        只信客户端自己落盘的数字（同 collect_stand_cost 纪律）：claude transcript
        尾条 message.usage 的 input+cache_read+cache_creation 之和 ≈ 当前上下文量。
        非 claude harness / transcript 读不到 → None，调用方靠 areco 侧空闲信号
        放行，**绝不硬编数字**。
        """
        try:
            csid = sess.get("claudeSessionId") or ""
            tdir = sess.get("transcriptDir") or ""
            if not csid or not tdir:
                return None
            tp = Path(tdir) / f"{csid}.jsonl"
            if not tp.exists():
                return None
            last = None
            with tp.open(encoding="utf-8", errors="ignore") as f:
                for line in f:
                    try:
                        u = (json.loads(line).get("message") or {}).get("usage") or {}
                    except (json.JSONDecodeError, AttributeError):
                        continue
                    if u:
                        last = u
            if not last:
                return None
            return (int(last.get("input_tokens") or 0)
                    + int(last.get("cache_read_input_tokens") or 0)
                    + int(last.get("cache_creation_input_tokens") or 0))
        except Exception:
            return None

    def find_reusable_session(self, template_id: str) -> tuple[dict | None, str]:
        """在同模板名下找一个可复用的空闲旧会话（判据 a 空闲 / b 上下文未近满；
        判据 c 干净上下文标记与强制新会话例外在 _session_reuse_decision 判）。

        返回 (reuse_stand 字典 | None, route_reason)。全程 fail-open：任何一步
        异常/查不到都返回 (None, 新会话原因)，复用只是省冷启动税，不挡派发。
        reuse_stand 的 room_created 恒 False——旧房不是本单建的，收口/回滚都不碰。
        """
        try:
            sessions = self.list_sessions()
        except Exception as e:
            return None, f"新会话(会话列表不可得: {e})"
        # 判据 a：空闲 = 进程活着 + 红绿灯为「定稿/空闲」；working（在干活）与
        # needs-user（屏上挂待选框，注入会压在未答提示上）都算忙。红绿灯查无值
        # 的按忙处理——「空闲」必须是确认事实，不是猜。
        cands = [
            s for s in sessions
            if s.get("templateId") == template_id
            and s.get("status") == "running"
            and not s.get("archived")
            and s.get("roomId")
            and (s.get("trafficState") or "") in ("conclusion", "idle")
        ]
        if not cands:
            return None, "新会话(无空闲旧会话)"
        # 最近活跃的排前面——上下文缓存最暖
        cands.sort(key=lambda s: s.get("trafficUpdatedAt") or 0, reverse=True)
        try:
            rooms = {r.get("id"): r for r in self.list_rooms()}  # 已滤归档房
        except Exception as e:
            return None, f"新会话(房间列表不可得: {e})"
        near_full = 0
        for s in cands:
            # 判据 b：上下文用量拿得到就判近满；拿不到（None）靠 areco 侧空闲信号放行
            ctx = self._session_context_tokens(s)
            if ctx is not None and ctx >= SESSION_REUSE_CONTEXT_LIMIT:
                near_full += 1
                continue
            room = rooms.get(s.get("roomId"))
            if not room:
                continue  # 房已归档/查无——relay 不投递，派进去=丢任务
            mem = next((m for m in room.get("members", [])
                        if m.get("kind") == "session"
                        and m.get("sessionId") == s.get("id")), None)
            if not mem or not mem.get("name"):
                continue
            ctx_note = (f"上下文≈{ctx}t" if ctx is not None
                        else "上下文用量不可得,凭 areco 空闲信号")
            return {
                "kind": "session_reuse",
                "room_id": room["id"],
                "team": room.get("team"),
                "room_name": room.get("name", ""),
                "stand_name": mem["name"],
                "stand_session_id": s.get("id"),
                "template_id": template_id,
                "room_created": False,
            }, f"复用旧会话(命中缓存: {mem['name']}, {ctx_note})"
        if near_full:
            return None, (f"新会话({near_full} 个空闲旧会话上下文近满"
                          f" ≥{SESSION_REUSE_CONTEXT_LIMIT}t)")
        return None, "新会话(空闲旧会话所在房间不可用)"

    def _session_reuse_decision(self, template_id: str, request: str,
                                fresh: bool = False) -> tuple[dict | None, str]:
        """会话复用总判（判据 c + 强制新会话例外 + 开关在本层，a/b 下沉 find）。

        返回 (reuse_stand | None, route_reason)——无论复用与否 route_reason 都写明
        决策路径（'复用旧会话(命中缓存…)' / '新会话(无空闲/需干净上下文…)'）。
        """
        if not SESSION_REUSE_ENABLED:
            return None, "新会话(复用开关 SESSION_REUSE_ENABLED=False)"
        text = request or ""
        text_lower = text.lower()
        if fresh or any((m in text) or (m.isascii() and m.lower() in text_lower)
                        for m in FRESH_CONTEXT_MARKERS):
            return None, "新会话(任务带干净上下文标记 --fresh)"
        if any((k in text) or (k.isascii() and k.lower() in text_lower)
               for k in ARENA_KEYWORDS):
            return None, "新会话(擂台/基准测试强制干净上下文——各模型同起点保公平)"
        if any(k in text for k in LEGAL_CASE_KEYWORDS):
            return None, "新会话(法律案件类默认隔离——防跨案件上下文串味)"
        return self.find_reusable_session(template_id)

    def dispatch_to_channel(self, request: str, channel: dict,
                            request_summary: str | None = None) -> dict:
        """向常驻通道成员直投任务（不建房、不 spawn），返回与 dispatch() 同形结果。

        与 dispatch() 的关系：这是「第 0 种复用」——连房带 Stand 全是现成的，只发
        消息 + 审计 + 面包屑。room_created 恒 False，且**不写 rooms 台账**：台账即
        「StandCode 地盘」声明，常驻问答房是高律师的房间，进了台账会被 rooms --sweep
        / sweep-task-rooms 当自家任务房清扫。
        """
        verdict = check_should_dispatch(request or "")
        if verdict.get("category") == "blocked":
            blocked_task_id = f"task-{uuid.uuid4().hex[:12]}"
            log_audit("dispatch_blocked", {
                "task_id": blocked_task_id, "mode": "worker", "role": "worker",
                "template": channel.get("template_id", ""), "blocked": True,
                "category": "blocked", "reason": verdict.get("reason", ""),
                "via": "ask", "request_preview": (request or "")[:200],
            })
            raise GatekeeperBlockedError(
                f"Gatekeeper 拒绝派发（BLOCKED）：{verdict.get('reason', '')}"
            )
        task_id = f"task-{uuid.uuid4().hex[:12]}"
        msg_id = self.send_message(channel["team"], channel["member"], request,
                                   room_id=channel.get("room_id") or "")
        result = {
            "task_id": task_id,
            "session_id": channel["team"],
            "room_id": channel["room_id"],
            "room_name": channel.get("room_name", ""),
            "room_created": False,
            "stand_name": channel["member"],
            "stand_session_id": channel.get("session_id", ""),
            "message_id": msg_id,
            "task_type": "general",
            "template_id": channel.get("template_id", ""),
            "role": "worker",
            "mode": "worker",
            "ask_direct": True,
            "workspace": None,
            "workspace_cwd": False,
        }
        log_audit("ask_direct", {
            "task_id": task_id, "mode": "worker", "role": "worker",
            "template": result["template_id"], "blocked": False,
            "room_id": channel["room_id"], "stand_name": channel["member"],
            "request_preview": (request or "")[:200],
        })
        logger.info(
            "ask 直投: room=%s member=%s session=%s msg=%s",
            channel["room_id"], channel["member"],
            (channel.get("session_id") or "")[:8], msg_id,
        )
        hook = getattr(self, "_on_dispatch", None)
        if hook:
            try:
                hook(result)  # 面包屑：等待者死亡后 reconcile 凭它去常驻房补收
            except Exception as e:
                logger.warning("ask 面包屑回调失败（不影响投递）: %s", e)
        return result

    def wait_channel_resumed(self, session_id: str,
                             max_wait: float = ASK_RESUME_WAIT_SEC) -> bool:
        """exited 通道直投后，等 room-relay 自动 restart resume 把会话拉回 running。

        poll_result 的 lost 判定读 status==exited——不等 resume 完成就开轮询，会在
        restart 窗口（relay 2s tick + spawn 若干秒）内把任务误判成失联。
        返回是否等到 running；等不到也不拦（poll 会如实报 lost，reconcile 兜底）。
        """
        deadline = time.time() + max_wait
        while time.time() < deadline:
            info = self._session_info(session_id) or {}
            if info.get("status") in ("running", "spawning"):
                return True
            time.sleep(2)
        return False

    # ── 工作区隔离（建议 4b）────────────────────────────────────

    def prepare_workspace(
        self, task_id: str, source_repo: str | None = None
    ) -> dict:
        """为本任务准备隔离工作目录（dispatch isolated=True 时调用）。

        - source_repo 给定：在 /tmp/standcode-workspaces/{task_id}/ 建真正的 git worktree
          （`git -C <repo> worktree add ...`），这是设计文档说的「worktree 隔离」正解。
        - source_repo 省略：只 mkdir 空目录（不是 git worktree，无隔离实效，仅占位）。

        返回 {path, kind, applied}。

        applied 语义（2026-07-26 起真的会是 True）：areco 的 addMember 此前只收
        templateId，cwd 只能来自模板固定值，Caller 无权覆盖——所以隔离一直是空壳，
        applied 硬编码 False。现在 areco 支持 per-session cwd（rooms.ts addMember 收 cwd，
        buildSpawnSpec 对不存在的显式 cwd 直接抛而非静默回落 $HOME），dispatch 会把
        本目录传过去，applied 随之置 True。

        ⚠️ 仍然只有 source_repo 给定时才是**真隔离**；不给就只是个空目录，
        多个 Stand 各写各的空目录，对「并发改同一个仓库」没有任何保护。
        """
        ws = WORKSPACE_DIR / task_id
        kind = "empty"
        try:
            if source_repo:
                # 真 worktree：基于 source_repo 建独立工作树，新分支名 stand-<task_id>
                ws.parent.mkdir(parents=True, exist_ok=True)
                branch = f"stand-{task_id}"
                proc = subprocess.run(
                    ["git", "-C", source_repo, "worktree", "add", "-b", branch,
                     str(ws)],
                    capture_output=True, text=True, timeout=30,
                )
                # 必须看 returncode：改动前无条件写 kind="git_worktree"，于是分支已存在 /
                # source_repo 不是仓库 / 磁盘满 时，函数照样报告「已建好隔离工作树」。
                # 隔离是并行 fan-out 的安全前提——谎报隔离比不隔离更危险，因为没人会再去查。
                if proc.returncode != 0:
                    err = (proc.stderr or proc.stdout or "").strip()[-200:]
                    logger.warning("git worktree add 失败（task=%s）：%s", task_id, err)
                    kind = f"failed:git_worktree: {err}"
                else:
                    kind = "git_worktree"
            else:
                ws.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.warning("准备工作区失败 %s: %s", ws, e)
            kind = f"failed:{e}"
        logger.info("工作区准备: task=%s path=%s kind=%s applied=False(cwd待areco)",
                    task_id, ws, kind)
        return {"path": str(ws), "kind": kind, "applied": False}

    def redispatch(
        self,
        dispatch_result: dict,
        request: str,
        **dispatch_kwargs,
    ) -> dict:
        """对 lost/exited 的任务重新派发到【新房间 + 新 Stand】（建议 4a·W2）。

        与原任务隔离：开新房间，不复用旧 room_id（旧 Stand 已失联）。把旧 task_id 记入
        result['replaces']，便于审计。本方法不递归 poll——是否再轮询、要不要继续重试，
        由上层（dispatch_and_relay 等按 max_retries 控制）决定，避免无限自旋 spawn。
        """
        replaces = dispatch_result.get("task_id")
        logger.info("重新派发: replaces=%s request=%s", replaces, request[:60])
        new = self.dispatch(request=request, **dispatch_kwargs)
        new["replaces"] = replaces
        new["redispatch"] = True
        return new

    # ── 综合便捷方法 ────────────────────────────────────────────

    def dispatch_and_wait(
        self,
        request: str,
        task_type: str = "general",
        room_id: str | None = None,
        template_id: str | None = None,
        timeout: int = 0,
        max_retries: int = DEFAULT_MAX_REDISPATCH,
    ) -> dict:
        """派发并等待结果（dispatch + poll_result 一站式）。

        timeout 默认 0=无限等（2026-07-26 对齐高律师口径：Stand 不设超时——
        Opus 级任务动辄几十分钟，300s 默认造成的「催+误报超时」已被用户点名）。
        要限时的调用方显式传 timeout>0。

        max_retries: Stand 失联（status='lost'）时自动重新派发到新 Stand 的次数上限。
            默认 0（关）——与改动前完全一致；重派发会外部 spawn 新房间+会话，属不可逆
            动作，须用户显式开 >0 才生效。仅对 'lost' 重试，'timeout'/'error' 不重试
            （避免对真超时/真异常的任务无限烧额度）。
        """
        retries = 0
        dispatch_result = self.dispatch(
            request=request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
        )
        while True:
            poll = self.poll_result(
                session_id=dispatch_result["session_id"],
                stand_session_id=dispatch_result.get("stand_session_id"),
                after_id=dispatch_result.get("message_id", 0) or 0,
                stand_name=dispatch_result.get("stand_name", ""),
                timeout=timeout,
                task_id=dispatch_result.get("task_id", ""),
                role=dispatch_result.get("role", ""),
                template=dispatch_result.get("template_id", ""),
            )
            # 重试判据升级为码驱动（2026-07-26）：lost 之外，限流类（rate_limited）
            # 换个新 Stand 大概率能好也纳入；timeout/error 仍不重试（见 RETRYABLE 注释）。
            code = poll.get("error_code") or classify_error_code(
                poll.get("status", ""), poll.get("error", ""), poll.get("lost_reason", "")
            )
            if code in RETRYABLE_ERROR_CODES and retries < max_retries:
                retries += 1
                logger.warning("%s → 重派发 %d/%d", code, retries, max_retries)
                dispatch_result = self.redispatch(
                    dispatch_result, request,
                    task_type=task_type, template_id=template_id,
                )
                continue
            poll["redispatch_count"] = retries
            poll.setdefault("error_code", code)
            return {**dispatch_result, **poll}

    # ── 微信代发（Caller 主动把 Stand 结果发回 Client）─────────

    def _format_wechat(
        self,
        message: str,
        summary: str | None = None,
        file_path: str | None = None,
        max_points: int = 5,
    ) -> str:
        """把结果文本格式化为微信消息：一句话结论 + 文件路径 + 核心要点 3-5 条"""
        text = (message or "").strip()

        # 一句话结论：显式传入优先；否则取正文首行/首句
        if summary and summary.strip():
            conclusion = summary.strip()
        else:
            first_line = ""
            for line in text.splitlines():
                s = line.strip(" -•·*\t")
                if s:
                    first_line = s
                    break
            conclusion = (
                first_line
                or (text[:60] + ("…" if len(text) > 60 else ""))
                or "（无结论）"
            )

        # 核心要点：正文里非空、非结论的行（去项目符号），最多 max_points 条
        points: list[str] = []
        for raw in text.splitlines():
            s = raw.strip()
            if not s:
                continue
            cleaned = s.lstrip(" -•·*0123456789.、）)）\t").strip()
            if cleaned and cleaned != conclusion and cleaned not in points:
                points.append(cleaned)
            if len(points) >= max_points:
                break

        parts = [f"✅ {conclusion}"]
        parts.append(f"📄 文件：{file_path}" if file_path else "📄 文件：（无）")
        if points:
            parts.append("核心要点：")
            parts.extend(f"{i}. {p}" for i, p in enumerate(points, 1))
        return "\n".join(parts)

    def relay_to_wechat(
        self,
        message: str,
        summary: str | None = None,
        file_path: str | None = None,
        dry_run: bool = False,
        raw: bool = False,
    ) -> dict:
        """把 Stand 结果代发到微信（Caller 主动回执，不依赖 Stand 自汇报）

        调用 cc-send.sh -s <target> -m "<内容>"，纯文字消息不经 .ok gate。
        微信消息格式：一句话结论 + 文件路径 + 核心要点 3-5 条。

        参数:
            message:   Stand 结果正文（poll_result['result_text']）
            summary:   一句话结论；None 时从正文自动提炼首行
            file_path: 产物文件路径（可选）
            dry_run:   True=只拼装不发送（测试用）
            raw:       True=message 已是成品消息，原文直发、不再套 _format_wechat。
                       给 process_inbox_callback 用——它的 summarize_inbox 已经产出
                       「✅…📄…要点」模板，再包一层就是双重格式化（✅ 套 ✅）。

        返回:
            {"ok": bool, "dry_run": bool, "content": str,
             "stdout": str, "returncode": int, "error"?: str}
        """
        content = message if raw else self._format_wechat(
            message, summary=summary, file_path=file_path
        )

        if dry_run:
            logger.info("[dry-run] 微信代发内容（未发送）:\n%s", content)
            return {
                "ok": True,
                "dry_run": True,
                "content": content,
                "stdout": "",
                "returncode": 0,
            }

        # 未配置微信目标（env WECHAT_TARGET / config/local.json 均缺）：明确报错不盲发
        if not WECHAT_TARGET:
            logger.warning("WECHAT_TARGET 未配置，跳过微信代发（设 env 或 config/local.json）")
            return {
                "ok": False,
                "dry_run": False,
                "content": content,
                "stdout": "",
                "returncode": -1,
                "error": "WECHAT_TARGET 未配置（env WECHAT_TARGET 或 config/local.json 的 wechat_target）",
            }

        # cc-send.sh 依赖 ${HOME}/.npm-global/bin（worker 独立进程可能 PATH 不全）
        env = {
            **os.environ,
            "HOME": HOME_DIR,
            "PATH": f"{HOME_DIR}/.npm-global/bin:{os.environ.get('PATH', '')}",
        }
        cmd = [CC_SEND_BIN, "-s", WECHAT_TARGET, "-m", content]
        logger.info("代发微信: target=%s 长度=%d", WECHAT_TARGET, len(content))
        try:
            proc = subprocess.run(
                cmd, env=env, capture_output=True, text=True, timeout=30
            )
        except Exception as e:
            logger.error("代发微信异常: %s", e)
            return {
                "ok": False,
                "dry_run": False,
                "content": content,
                "stdout": "",
                "returncode": -1,
                "error": str(e),
            }

        ok = proc.returncode == 0
        if not ok:
            logger.error(
                "代发微信失败 rc=%s out=%s",
                proc.returncode,
                (proc.stdout or "")[-300:],
            )
        return {
            "ok": ok,
            "dry_run": False,
            "content": content,
            "stdout": (proc.stdout or "").strip(),
            "returncode": proc.returncode,
        }

    def gate_result(
        self,
        dispatch_result: dict,
        poll: dict,
        acceptance: dict,
        *,
        files: list | None = None,
        poll_timeout: int = 0,
        max_bounce: int = 1,
    ) -> dict:
        """结果把关闸（2026-07-29 批件①）：机检 → 不过打回一次 → 复检 → 仍不过升级人工。

        必须在 finish_room 归档之前调（归档级联杀 Stand，打回就没人接了）。
        打回走同房间同 Stand（上下文还在，补齐差价最小）；话术强制三段式
        （差距/锚点/范围，build_rejection_message）。复检对「首轮+补齐轮」合并文本跑——
        自报产物路径可能只出现在补齐轮。

        返回 {"poll", "verification", "bounced", "escalated"}；poll 为（可能已并入
        补齐轮的）最新结果，verification 带 attempts/bounced/escalated 三个把关字段。
        """
        verification = verify_acceptance(
            acceptance, result_text=poll.get("result_text", ""), files=files,
        )
        bounced = False
        escalated = False
        attempts = 1
        if verification.get("level") == "check_failed" and max_bounce > 0:
            failed = [c["check"] for c in verification.get("checks", []) if not c.get("passed")]
            rejection = build_rejection_message(verification, attempt=1)
            log_audit("verify_bounce", {
                "task_id": dispatch_result.get("task_id", ""),
                "role": dispatch_result.get("role", ""),
                "template": dispatch_result.get("template_id", ""),
                "room_id": dispatch_result.get("room_id"),
                "failed_checks": failed[:5],
            })
            try:
                mid = self.send_message(
                    dispatch_result["session_id"],
                    dispatch_result.get("stand_name", "") or "all",
                    rejection,
                    room_id=dispatch_result.get("room_id") or "",
                )
            except Exception as e:
                # 打回发不出去（房间没了/库锁死）≠ 判据过了——如实标注并升级
                escalated = True
                verification["note"] = f"打回发送失败，升级人工：{e}"
            else:
                bounced = True
                attempts = 2
                poll2 = self.poll_result(
                    room_id=dispatch_result.get("room_id"),
                    session_id=dispatch_result["session_id"],
                    stand_session_id=dispatch_result.get("stand_session_id"),
                    after_id=mid,
                    stand_name=dispatch_result.get("stand_name", ""),
                    timeout=poll_timeout,
                    task_id=dispatch_result.get("task_id", ""),
                    role=dispatch_result.get("role", ""),
                    template=dispatch_result.get("template_id", ""),
                )
                if poll2.get("status") == "completed" and poll2.get("result_text"):
                    merged = (
                        poll.get("result_text", "")
                        + "\n\n──【验收打回后补齐（第 2 轮）】──\n"
                        + poll2.get("result_text", "")
                    )
                    poll = {**poll, **poll2, "result_text": merged}
                    verification = verify_acceptance(
                        acceptance, result_text=merged, files=files,
                    )
                    if verification.get("level") == "check_failed":
                        escalated = True
                else:
                    escalated = True
                    verification["note"] = (
                        f"打回后未收到有效补齐（{poll2.get('status')}），升级人工"
                    )
        verification["attempts"] = attempts
        verification["bounced"] = bounced
        verification["escalated"] = escalated
        if escalated:
            verification.setdefault("note", "打回一次仍未过判据，升级 Caller 人工复核")
            log_audit("verify_escalated", {
                "task_id": dispatch_result.get("task_id", ""),
                "role": dispatch_result.get("role", ""),
                "template": dispatch_result.get("template_id", ""),
                "room_id": dispatch_result.get("room_id"),
                "note": verification.get("note", ""),
            })
        return {"poll": poll, "verification": verification,
                "bounced": bounced, "escalated": escalated}

    def dispatch_and_relay(
        self,
        request: str,
        task_type: str | None = None,
        request_summary: str | None = None,
        *,
        role: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
        file_path: str | None = None,
        poll_timeout: int = 600,
        dry_run: bool = False,
        plan_only: bool = False,
        mode: str = "",
        isolated: bool = False,
        workspace_repo: str | None = None,
        acceptance: dict | None = None,
        fresh: bool = False,
    ) -> dict:
        """一键派发 → 主动轮询 → 代发微信

        参数:
            request:         任务描述
            task_type:        任务类型
            request_summary: 一句话结论（代发微信用）；None 时从结果正文自动提炼
            role:             'thinker' | 'worker' | None（按角色选默认模板）
            plan_only:        role='thinker' 时把 request 包进 PLAN_TEMPLATE（只出结构化计划）；
                              其他角色下无意义（PLAN_TEMPLATE 是给 Thinker 的），会被忽略
            mode:             工作模式一等字段，落审计（见 MODES / log_audit）
            fresh:            干净上下文标记——跳过旧会话复用强制新会话（见 dispatch）
            room_id/template_id/file_path/poll_timeout/dry_run: 见 dispatch/poll_result/relay_to_wechat

        返回: dispatch() + poll_result() + {relay_summary, wechat, relayed}
        """
        if role == "thinker":
            # plan_only → 六段结构化计划；否则 → 模式 4 的「给判断不给待办」约束。
            # 两者都必须走 request 正文：presets.system 那条路是死的（见 THINK_TEMPLATE 注释）。
            request = (PLAN_TEMPLATE if plan_only else THINK_TEMPLATE).format(request=request)
        dispatch_result = self.dispatch(
            request=request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role=role,
            request_summary=request_summary,
            mode=mode,
            isolated=isolated,
            workspace_repo=workspace_repo,
            fresh=fresh,
        )
        poll = self.poll_result(
            room_id=dispatch_result["room_id"],
            session_id=dispatch_result["session_id"],
            stand_session_id=dispatch_result.get("stand_session_id"),
            after_id=dispatch_result.get("message_id", 0) or 0,
            stand_name=dispatch_result.get("stand_name", ""),
            timeout=poll_timeout,
            task_id=dispatch_result.get("task_id", ""),
            role=dispatch_result.get("role", ""),
            template=dispatch_result.get("template_id", ""),
        )

        # ── 结果把关闸（2026-07-29 批件①）：completed 且带验收栏 → 先机检再收口。
        # 位置必须在 finish_room 之前：归档级联杀 Stand，打回要趁房间还活着。
        # 2026-07-29 高律师令验收闸整体关停（判据提取误伤三次）：ACCEPTANCE_GATE_ENABLED
        # =False 时整段跳过——不机检不打回不升级，结果直报；闸逻辑保留，重开改 True。
        gate = None
        if ACCEPTANCE_GATE_ENABLED and acceptance and poll.get("status") == "completed":
            gate = self.gate_result(
                dispatch_result, poll, acceptance,
                files=[file_path] if file_path else [],
                poll_timeout=poll_timeout,
            )
            poll = gate["poll"]
            poll["verification"] = gate["verification"]

        status = poll.get("status")
        result_text = poll.get("result_text", "")
        relayed = False
        wechat = None

        if status == "completed" and result_text:
            wechat = self.relay_to_wechat(
                message=result_text,
                summary=request_summary,
                file_path=file_path,
                dry_run=dry_run,
            )
            relayed = wechat.get("ok", False)
        else:
            # 超时/异常也代发一条告知（dry_run 时只拼不发）
            notice = (
                f"⚠️ 任务未完成（{status}）：{poll.get('error', '')}\n"
                f"请求：{request[:80]}"
            )
            wechat = self.relay_to_wechat(
                message=notice,
                summary=f"任务未完成（{status}）",
                file_path=file_path,
                dry_run=dry_run,
            )
            relayed = wechat.get("ok", False)

        # 收口：结果已收完（且已代发/已落 inbox），成功就把自建房间归档，别在看板堆着。
        # 把关闸升级人工的例外：房间留看板取证（归档会杀 Stand + 被 sweeper 删房）。
        archive = self.finish_room(
            dispatch_result, status,
            settle_forced=bool(poll.get("settle_forced")),
            keep_reason="verify_escalated" if (gate and gate["escalated"]) else None,
        )

        return {
            **dispatch_result,
            **poll,
            "relay_summary": request_summary,
            "wechat": wechat,
            "relayed": relayed,
            "archive": archive,
        }

    # ── Caller 两段式：Thinker 出计划 → Worker 执行 ─────────────

    def plan_and_execute(
        self,
        request: str,
        task_type: str | None = None,
        request_summary: str | None = None,
        *,
        file_path: str | None = None,
        poll_timeout: int = 600,
        dry_run: bool = False,
        reuse_plan: bool = False,
        fresh: bool = False,
    ) -> dict:
        """任务含规划需求时：Caller 先派 Thinker 做计划，再把计划交给 Worker 执行

        流程:
            1. Thinker（registry.default_thinker）拆解任务、产出可执行计划（不直接动手）
            2. Worker（registry.default_worker）**在同一个房间里**按计划执行（P0-3）
            3. 结果代发微信（dry_run 时只拼不发）

        计划不合格时三级降级（P0-2，改动前是「全损」——缺个标题就零产出）:
            1. 同房间同 Stand 重申格式模板，再要一次（限 1 次，PLAN_RETRY_TEMPLATE）
            2. 仍不合格但有正文 → 当「未结构化分析」交 Worker 自行判断（degraded=True）
            3. 连正文都没有 → 才是真 plan_failed

        返回:
            {
                "stage": "execute" | "plan_failed",
                "degraded": bool,     # True=计划没通过校验，走了降级路径
                "degrade_reason": str,
                "plan": {...},        # Thinker 的 dispatch+poll
                "execute": {...},     # Worker 的 dispatch+poll
                "plan_text": str,
                "result_text": str,   # Worker 最终结果
                "wechat": {...}, "relayed": bool,
            }
        """
        # 0. 计划复用（P1-3，opt-in）：命中就整段跳过 Thinker——省一个 Stand + 一次
        #    thinking:high 轮询。命中信息一律回报（reused_plan），让用户能当场否掉误配。
        if reuse_plan:
            hit = find_similar_plan(request)
            if hit:
                logger.info("复用历史计划 %s（相似度 %.3f），跳过 Thinker 段",
                            hit["task_id"], hit["score"])
                log_audit("plan_reused", {
                    "mode": "plan", "reused_from": hit["task_id"],
                    "score": hit["score"], "request_preview": (request or "")[:200],
                })
                return self._execute_with_plan(
                    request, hit["plan_text"], self._parse_plan(hit["plan_text"]),
                    task_type=task_type, request_summary=request_summary,
                    file_path=file_path, poll_timeout=poll_timeout, dry_run=dry_run,
                    plan_dispatch=None, degraded=False, degrade_reason="",
                    reused_plan={k: hit[k] for k in ("task_id", "score", "path", "request")},
                    fresh=fresh,
                )
            logger.info("无足够相似的历史计划（阈值 %.2f），正常派 Thinker", PLAN_REUSE_MIN_SCORE)

        # 1. Thinker 出结构化计划（plan_only 强制「只规划不执行」+ 结构化模板）
        plan_dispatch = self.dispatch_thinker(
            request,
            task_type=task_type,
            plan_only=True,
            fresh=fresh,
        )

        # 1.5 预热 Worker（2026-07-26 提速批件）：趁 Thinker 跑计划（通常 1.5-3 分钟），
        # 同房先把 Worker spawn 好但不发任务——投递按 to_agent 定向，Worker 不会误收
        # Thinker 的消息；等计划出来直接向预热成员注入，第二段 12s 冷启动税在 Thinker
        # 段里静默付清。预热失败回落原路（第二段现场 add_stand），不影响主链。
        prewarmed = None
        if PREWARM_WORKER:
            try:
                _pw_member = self.add_stand(plan_dispatch["room_id"], self.default_worker_id)
                prewarmed = {
                    "kind": "prewarm",
                    "room_id": plan_dispatch["room_id"],
                    "team": plan_dispatch["session_id"],
                    "room_name": plan_dispatch.get("room_name", ""),
                    "stand_name": _pw_member["name"],
                    "stand_session_id": _pw_member.get("sessionId", ""),
                    "template_id": self.default_worker_id,
                    "room_created": False,  # 房归 Thinker 链收口，复用路不归档
                }
                ledger_append(
                    "stand_added", plan_dispatch["room_id"],
                    task_id=plan_dispatch.get("task_id", ""),
                    stand_name=_pw_member["name"],
                    stand_session_id=_pw_member.get("sessionId", ""),
                    template_id=self.default_worker_id, by="prewarm",
                )
                log_audit("prewarm_worker", {
                    "room_id": plan_dispatch["room_id"],
                    "template": self.default_worker_id,
                    "task_id": plan_dispatch.get("task_id", ""),
                })
            except Exception as e:
                logger.warning("Worker 预热失败（第二段回落现场 spawn）: %s", e)

        plan_poll = self.poll_result(
            room_id=plan_dispatch["room_id"],
            session_id=plan_dispatch["session_id"],
            stand_session_id=plan_dispatch.get("stand_session_id"),
            after_id=plan_dispatch.get("message_id", 0) or 0,
            stand_name=plan_dispatch.get("stand_name", ""),
            timeout=poll_timeout,
            task_id=plan_dispatch.get("task_id", ""),
            role=plan_dispatch.get("role", ""),
            template=plan_dispatch.get("template_id", ""),
        )
        plan_text = plan_poll.get("result_text", "")
        if not plan_text:
            # 真 · plan_failed：Thinker 一个字都没回（超时/失联），没有可降级的素材。
            logger.warning("Thinker 未产出计划，跳过执行阶段")
            # 计划阶段就挂了：房间留在看板（现场比整洁重要），只在台账记一笔
            self.finish_room(plan_dispatch, "plan_failed")
            return {
                "stage": "plan_failed",
                "plan": {**plan_dispatch, **plan_poll},
                "execute": {},
                "plan_text": "",
                "plan_parsed": {"valid": False},
                "result_text": "",
                "wechat": None,
                "relayed": False,
                "degraded": False,
                # 预热的 Worker 随房留在看板（plan_failed 不归档），排查时可见
                "prewarmed_wasted": bool(prewarmed),
                "error": plan_poll.get("error", "Thinker 未产出计划"),
            }

        # 结构化校验 + 三级降级（P0-2）。改动前这里是「全损」：计划缺个「步骤」标题就
        # 直接 return，Worker 从不启动、用户零产出——哪怕 Thinker 那段分析完全可用。
        # 不合格的原因九成是 markdown 标题没按模板写，不是内容没用，为此丢掉一整个
        # Stand 的产出不划算。故改为：重申一次 → 仍不合格则降级 → 真没正文才算失败。
        plan = self._parse_plan(plan_text)
        degraded = False
        degrade_reason = ""
        if not plan["valid"]:
            logger.warning("Thinker 计划未通过结构化校验（缺步骤段），重申模板再要一次")
            retry_text = ""
            try:
                # 降级 1：同房间、同 Stand 重申格式（不新建房、不新起 Stand，只多一轮对话）。
                # 重申带上具体校验缺陷（_parse_plan.issues）——只念格式模板不指出错处，
                # Thinker 大概率原样再错一遍。
                issues = plan.get("issues") or []
                retry_body = PLAN_RETRY_TEMPLATE + (
                    ("\n【本次校验具体缺陷】\n" + "\n".join(f"- {i}" for i in issues))
                    if issues else ""
                )
                retry_msg_id = self.send_message(
                    plan_dispatch["session_id"],
                    plan_dispatch["stand_name"],
                    retry_body,
                    room_id=plan_dispatch.get("room_id") or "",
                )
                retry_poll = self.poll_result(
                    room_id=plan_dispatch["room_id"],
                    session_id=plan_dispatch["session_id"],
                    stand_session_id=plan_dispatch.get("stand_session_id"),
                    after_id=retry_msg_id,
                    stand_name=plan_dispatch.get("stand_name", ""),
                    timeout=poll_timeout,
                    task_id=plan_dispatch.get("task_id", ""),
                    role=plan_dispatch.get("role", ""),
                    template=plan_dispatch.get("template_id", ""),
                )
                retry_text = retry_poll.get("result_text", "")
            except Exception as e:
                logger.warning("计划重申失败（降级继续，不中断整条链）: %s", e)
            if retry_text:
                retry_plan = self._parse_plan(retry_text)
                if retry_plan["valid"]:
                    logger.info("重申后计划合格，按正常两段式继续")
                    plan_text, plan = retry_text, retry_plan
                else:
                    # 重申后的正文通常比首轮更贴模板，即便仍不合格也用它
                    plan_text = retry_text
            if not plan["valid"]:
                # 降级 2：不合格但有正文 → 当「未结构化的分析」喂 Worker，别丢掉
                degraded = True
                degrade_reason = "计划未通过结构化校验（缺步骤段），已降级为「未结构化分析」交 Worker 自行判断"
                logger.warning("%s", degrade_reason)
                log_audit("plan_degraded", {
                    "mode": "plan",
                    "task_id": plan_dispatch.get("task_id", ""),
                    "role": plan_dispatch.get("role", ""),
                    "template": plan_dispatch.get("template_id", ""),
                    "room_id": plan_dispatch.get("room_id"),
                    "reason": degrade_reason,
                })

        # 计划落盘（P1-3）：Thinker 的产出此前只在变量里活一次，同类任务要重新想。
        # 只存合格的——降级路径的散文当计划复用会把误差放大。
        if not degraded:
            save_plan(plan_dispatch.get("task_id", ""), request, plan_text, plan)

        # 2. Worker 按计划执行（预热成员优先，缺位回落现场 spawn）
        return self._execute_with_plan(
            request, plan_text, plan,
            task_type=task_type, request_summary=request_summary,
            file_path=file_path, poll_timeout=poll_timeout, dry_run=dry_run,
            plan_dispatch=plan_dispatch, plan_poll=plan_poll,
            degraded=degraded, degrade_reason=degrade_reason,
            prewarmed=prewarmed, fresh=fresh,
        )

    def _execute_with_plan(
        self,
        request: str,
        plan_text: str,
        plan: dict,
        *,
        task_type: str | None,
        request_summary: str | None,
        file_path: str | None,
        poll_timeout: int,
        dry_run: bool,
        plan_dispatch: dict | None,
        plan_poll: dict | None = None,
        degraded: bool,
        degrade_reason: str,
        reused_plan: dict | None = None,
        prewarmed: dict | None = None,
        fresh: bool = False,
    ) -> dict:
        """两段式的执行半段：拿着计划派 Worker → 轮询 → 代发 → 收口。

        抽出来是因为有两个入口共用它：正常的 Thinker→Worker，以及计划复用
        （plan_dispatch=None，直接从历史计划开工，跳过整个 Thinker 段）。
        prewarmed：Thinker 段并行预热好的同房 Worker（见 plan_and_execute 1.5），
        给定且共享房可用时直接向它注入，跳过第二段冷启动。
        """
        if degraded:
            exec_request = (
                "下面是 Thinker 对本任务的分析，**未经结构化**（没有可直接照做的步骤段）。"
                "请自行判断其中哪些可执行，据此完成任务并交付结果；"
                "分析里没覆盖到的部分按你的判断补齐，并在结果里说明你补了什么。\n\n"
                "【Thinker 分析】\n" + plan_text + "\n\n【原始任务】\n" + request
            )
        else:
            exec_request = (
                "请严格按以下计划执行并交付结果。你是 Worker，只执行不决策——"
                "不要重新规划，照步骤做；遇阻在结果里说明，不要擅自改方案。\n\n"
                "【计划】\n" + plan_text + "\n\n【原始任务】\n" + request
            )
            if plan.get("done_when"):
                exec_request += "\n\n【完成判据】\n" + plan["done_when"]
            if reused_plan:
                # 复用的计划可能是为「相似但不同」的任务写的——明说，让 Worker 自己把关
                exec_request += (
                    f"\n\n【注意】本计划复用自历史任务（相似度 {reused_plan.get('score')}），"
                    f"原任务是：{(reused_plan.get('request') or '')[:120]}\n"
                    "若与当前任务有实质出入，按当前任务为准，并在结果里说明你偏离了哪一步。"
                )
        # P0-3：Worker 复用 Thinker 的房间——一条链一个房间。看板上不再是两个孤立 ⚙ 房，
        # 计划与执行在同一处可查，也为「Worker 向仍活着的 Thinker 追问」留出通道。
        # 前提是 poll_result 已按 stand_name + after_id 认人认位（见其 docstring），
        # 否则 Worker 的 poll 会秒回 Thinker 的计划当成执行结果。
        # 复用计划时 plan_dispatch 为 None，没有可复用的房间 → 新建。
        exec_dispatch = self.dispatch_worker(
            exec_request,
            task_type=task_type,
            room_id=plan_dispatch["room_id"] if plan_dispatch else None,
            mode="plan",
            reuse_stand=prewarmed if plan_dispatch else None,
            fresh=fresh,
        )
        exec_poll = self.poll_result(
            room_id=exec_dispatch["room_id"],
            session_id=exec_dispatch["session_id"],
            stand_session_id=exec_dispatch.get("stand_session_id"),
            after_id=exec_dispatch.get("message_id", 0) or 0,
            stand_name=exec_dispatch.get("stand_name", ""),
            timeout=poll_timeout,
            task_id=exec_dispatch.get("task_id", ""),
            role=exec_dispatch.get("role", ""),
            template=exec_dispatch.get("template_id", ""),
        )
        result_text = exec_poll.get("result_text", "")

        wechat = None
        relayed = False
        if exec_poll.get("status") == "completed" and result_text:
            wechat = self.relay_to_wechat(
                message=result_text,
                summary=request_summary,
                file_path=file_path,
                dry_run=dry_run,
            )
            relayed = wechat.get("ok", False)

        # 收口：成败按「整条链」算——执行段没成时连计划房一起留着，
        # 排查要看的是完整链路，不是半截。（共享房时 finish_room 天然幂等，见其实现）
        exec_status = exec_poll.get("status")
        exec_forced = bool(exec_poll.get("settle_forced"))
        archive = {"execute": self.finish_room(exec_dispatch, exec_status,
                                               settle_forced=exec_forced)}
        if plan_dispatch:
            archive["plan"] = self.finish_room(plan_dispatch, exec_status,
                                               settle_forced=exec_forced)

        return {
            "stage": "execute",
            "degraded": degraded,
            "degrade_reason": degrade_reason,
            "reused_plan": reused_plan,
            "plan": {**(plan_dispatch or {}), **(plan_poll or {})},
            "execute": {**exec_dispatch, **exec_poll},
            "plan_text": plan_text,
            "plan_parsed": plan,
            "result_text": result_text,
            "wechat": wechat,
            "relayed": relayed,
            "archive": archive,
        }

    # ── 严格分工辅助：门控 / plan 解析 / 自动选路 ─────────────────

    @staticmethod
    def route_mode(request: str) -> dict:
        """四格路由（docs/work-modes.md P1-1）：按「交付物 × 结构」两维选模式。

        取代二元的 should_plan——后者只有 plan/worker 两个出口，导致「要判断不要东西」
        的任务（选型/评估/复盘）必然被错配：命中 PLAN_KEYWORDS 就白烧一个 Worker 段去
        「执行」一个只需结论的判断，没命中就用 thinking=minimal 的执行档模型干规划档的活。

        两个维度：
            交付物  要「判断」（结论/取舍，不落盘）  vs  要「东西」（落盘/改文件/改外部系统）
            结构    多步有依赖（第一步错则后面全废）  vs  单步无依赖

        四格：
                            要东西              要判断
            单步无依赖      worker              think
            多步有依赖      plan                think + plan_only

        判定顺序（先到先得；2026-07-30 高律师令·路由逻辑重构）：
            1. 命中 PLAN_ONLY_KEYWORDS（「只要计划」「别动手」）→ think + plan_only
            2. 交付物 = 判断（命中 JUDGMENT 且未命中 ARTIFACT）→ think
               （多步则 plan_only=True——多步判断的自然产物就是结构化计划）
            3. 交付物 = 东西 且 多步有依赖 → plan（两段式）
            4. 法律重活词（HEAVY_LAW_KEYWORDS：案件/法院/合同/判决/法条…）→ worker
               （主力 Worker，route_reason 写明命中词）。
               2026-07-30 重构：代码词与「重量词」（批量/全量/重构/迁移…）整组移出
               触发器——写代码/跑脚本/git/python 不再升重车，特殊情况=法律。
            5. 其余一律 → fast（快速 Worker，锚随 areco 设置页 standcode.fastWorker）
               FAST_KEYWORDS 只留作 signals 观测，不再参与判定。

        刻意不返回 fanout / operator：
            fanout 要求「N 个互不依赖的子任务」，关键词启发式判不出子任务边界——
                   必须调用方显式 --mode fanout --sub … 声明拆法。
            operator 判的是「命令」不是「任务」，归 check_should_dispatch。

        返回:
            {
                "mode": "worker" | "think" | "plan" | "fast",
                "plan_only": bool,
                "deliverable": "judgment" | "artifact",
                "structure": "multi_step" | "single_step",
                "reason": str,
                "signals": {"judgment": [...], "artifact": [...],
                            "plan": [...], "direct": [...], "plan_only": [...]},
            }
        """
        text = request or ""
        text_lower = text.lower()

        def _hits(kws) -> list[str]:
            # ASCII 词按小写比对（python/bug/git/commit 不吃大小写亏），中文原样子串
            return [k for k in kws
                    if (k in text) or (k.isascii() and k.lower() in text_lower)]

        judgment = _hits(JUDGMENT_KEYWORDS)
        artifact = _hits(ARTIFACT_KEYWORDS)
        plan_strong = _hits(PLAN_STRONG_KEYWORDS)
        plan_weak = _hits(PLAN_WEAK_KEYWORDS)
        plan_kw = plan_strong + plan_weak
        direct_kw = _hits(DIRECT_KEYWORDS)
        plan_only_kw = _hits(PLAN_ONLY_KEYWORDS)
        fast_kw = _hits(FAST_KEYWORDS)
        heavy_law = _hits(HEAVY_LAW_KEYWORDS)
        signals = {
            "judgment": judgment, "artifact": artifact,
            "plan": plan_kw, "plan_strong": plan_strong, "plan_weak": plan_weak,
            "direct": direct_kw, "plan_only": plan_only_kw,
            "fast": fast_kw, "heavy_law": heavy_law,
        }

        # 结构维度（2026-07-26 强弱分档，提速批件）：plan 两段式是最贵的模式，误入
        # 的代价是一个 Thinker 段（中位 95s+）白烧。强信号（分几步/计划/拆解…明说
        # 多步）单独成立；弱信号（设计/调研/方案…常出现在单步小任务里）要凑够两个，
        # 且被 DIRECT 强命中（总结/翻译这类明确单步动词）压制。
        multi_step = bool(plan_strong) or (len(plan_weak) >= 2 and not direct_kw)
        structure = "multi_step" if multi_step else "single_step"

        # 1) 显式「只要计划」
        if plan_only_kw:
            return {
                "mode": "think", "plan_only": True,
                "deliverable": "judgment", "structure": structure,
                "reason": f"显式要求只出计划不执行（命中 {plan_only_kw}）→ Thinker 出结构化计划，执行另议",
                "signals": signals,
            }

        # 2) 交付物 = 判断（要结论，不要东西）
        if judgment and not artifact:
            return {
                "mode": "think", "plan_only": multi_step,
                "deliverable": "judgment", "structure": structure,
                "reason": (
                    f"交付物是判断（命中 {judgment}，无落盘信号）"
                    + ("；多步有依赖，产物取结构化计划" if multi_step else "；单步，自由格式结论即可")
                ),
                "signals": signals,
            }

        # 3) 交付物 = 东西 且 多步有依赖 → 两段式
        if multi_step:
            hit_desc = f"强 {plan_strong}" if plan_strong else f"弱×{len(plan_weak)} {plan_weak}"
            return {
                "mode": "plan", "plan_only": False,
                "deliverable": "artifact", "structure": "multi_step",
                "reason": f"交付物是东西且多步有依赖（命中 {hit_desc}）→ Thinker 出计划、Worker 执行",
                "signals": signals,
            }

        # 4) 法律重活 → 主力 Worker（重活锚）。2026-07-30 高律师令·路由逻辑重构：
        #    重活锚只留给法律词（HEAVY_LAW_KEYWORDS），代码词/重量词不再触发；
        #    route_reason 必须写明命中词（冒烟/审计取证用）。锚 SoT 在 areco 设置页，
        #    reason 里显示的是运行时解析的真锚（含来源）。
        if heavy_law:
            heavy_stand, heavy_src = resolve_lane_anchors()["heavy"]
            return {
                "mode": "worker", "plan_only": False,
                "deliverable": "artifact", "structure": "single_step",
                "reason": (f"命中法律重活词（{'/'.join(heavy_law)}）→ 主力 Worker（{heavy_stand}@{heavy_src}）"),
                "signals": signals,
            }

        # 5) 其余一律轻车（2026-07-30 路由重构：默认车道 = 快速 Worker，写代码/跑脚本
        #    也走这条；锚随 areco 设置页 standcode.fastWorker，运行时解析）。
        fast_stand, fast_src = resolve_lane_anchors()["fast"]
        return {
            "mode": "fast", "plan_only": False,
            "deliverable": "artifact", "structure": "single_step",
            "reason": f"默认轻车（未命中法律重活词）→ 快速 Worker（{fast_stand}@{fast_src}）",
            "signals": signals,
        }

    @staticmethod
    def should_plan(request: str) -> bool:
        """[保留兼容] 二元门控：任务是否走两段式（Thinker→plan→Worker）。

        ⚠️ 已被 route_mode() 取代（四格路由，docs/work-modes.md P1-1）——新代码请用
        route_mode。本方法行为**刻意保持原样不变**（docs/api.md 与既有调用方按此描述），
        只作向后兼容：命中 PLAN_KEYWORDS 且未强命中 DIRECT_KEYWORDS → True。
        """
        text = request or ""
        direct_hit = any(k in text for k in DIRECT_KEYWORDS)
        plan_hit = any(k in text for k in PLAN_KEYWORDS)
        if direct_hit and not plan_hit:
            return False
        return plan_hit

    @staticmethod
    def check_should_dispatch(task_description: str) -> dict:
        """Gatekeeper 薄包装：委托模块级 check_should_dispatch，便于 OO 调用。

        Caller 动手前先核查：should_dispatch=True → 必须 dispatch_worker，
        不得直干。详见模块级 check_should_dispatch 文档。
        """
        return check_should_dispatch(task_description)

    def _parse_plan(self, plan_text: str) -> dict:
        """宽松解析 Thinker 产出的结构化 plan，提取关键字段并校验。

        不强制 JSON（LLM 输出 markdown 更自然），按段落标题抓取。
        返回 {goal, context, steps, constraints, done_when, output_path, valid}。
        valid=False 表示缺少「步骤」段，plan 不合格——Caller 应回报 plan_failed，
        不擅自把不合格 plan 喂给 Worker。
        """
        text = plan_text or ""

        def _grab(header: str, stops: list[str]) -> str:
            """抓 header 之后、到任一 stop 标题之前的内容"""
            start = -1
            for variant in (header, header.replace("：", ":")):
                idx = text.find(variant)
                if idx != -1:
                    start = idx + len(variant)
                    break
            if start == -1:
                return ""
            rest = text[start:]
            # 跳过标题后紧跟的冒号（中英文）与空白
            while rest[:1] in ("：", ":", " ", "\n", "\t"):
                rest = rest[1:]
            for stop in stops:
                for variant in (stop, stop.replace("：", ":")):
                    j = rest.find(variant)
                    if j != -1:
                        rest = rest[:j]
                        break
            return rest.strip()

        stops_all = ["步骤", "约束", "完成判据", "最终产物落点"]
        goal = _grab("目标", ["上下文", *stops_all])
        context = _grab("上下文", stops_all)
        steps_raw = _grab("步骤", ["约束", "完成判据", "最终产物落点"])
        constraints = _grab("约束", ["完成判据", "最终产物落点"])
        done_when = _grab("完成判据", ["最终产物落点"])
        output_path = _grab("最终产物落点", [])

        steps = [
            ln.strip() for ln in steps_raw.splitlines()
            if ln.strip() and ln.strip()[0].isdigit()
        ]
        valid = len(steps) > 0 and bool(goal or steps_raw)
        # 校验缺陷明细（2026-07-26 借 open-kritt post_processing 的 validation-error
        # 回喂思路）：重申时告诉 Thinker 具体缺什么，而不是把整个格式模板再念一遍——
        # 带具体错误的重试一次命中率远高于泛重申。
        issues: list[str] = []
        if not steps_raw:
            issues.append("整个「步骤」段缺失")
        elif not steps:
            issues.append("「步骤」段有内容但没有一行以「数字. 」开头（无法拆成可执行步骤）")
        if not goal:
            issues.append("「目标」段缺失")
        if not done_when:
            issues.append("「完成判据」段缺失（收口无法机检）")
        if not output_path:
            issues.append("「最终产物落点」段缺失（写绝对路径或『无』）")
        return {
            "goal": goal,
            "context": context,
            "steps": steps,
            "constraints": constraints,
            "done_when": done_when,
            "output_path": output_path,
            "valid": valid,
            "issues": issues,
        }

    def auto_dispatch(
        self,
        request: str,
        task_type: str | None = None,
        request_summary: str | None = None,
        *,
        file_path: str | None = None,
        poll_timeout: int = 600,
        dry_run: bool = False,
    ) -> dict:
        """按门控自动选路：should_plan=True 走 plan_and_execute，否则直派 Worker。

        Caller 一站式入口，省去人工判断「该不该两段式」。返回结构沿袭被调方法，
        直派模式额外带 mode='direct'。
        """
        if self.should_plan(request):
            result = self.plan_and_execute(
                request,
                task_type=task_type,
                request_summary=request_summary,
                file_path=file_path,
                poll_timeout=poll_timeout,
                dry_run=dry_run,
            )
            result.setdefault("mode", "plan")
            return result
        exec_dispatch = self.dispatch_worker(request, task_type=task_type)
        exec_poll = self.poll_result(
            room_id=exec_dispatch["room_id"],
            session_id=exec_dispatch["session_id"],
            stand_session_id=exec_dispatch.get("stand_session_id"),
            after_id=exec_dispatch.get("message_id", 0) or 0,
            stand_name=exec_dispatch.get("stand_name", ""),
            timeout=poll_timeout,
            task_id=exec_dispatch.get("task_id", ""),
            role=exec_dispatch.get("role", ""),
            template=exec_dispatch.get("template_id", ""),
        )
        result_text = exec_poll.get("result_text", "")
        wechat = None
        relayed = False
        if exec_poll.get("status") == "completed" and result_text:
            wechat = self.relay_to_wechat(
                message=result_text,
                summary=request_summary,
                file_path=file_path,
                dry_run=dry_run,
            )
            relayed = wechat.get("ok", False)
        # 收口：auto_dispatch 的直派分支此前**从不 finish_room**，每次调用泄一个房间到
        # 看板（dispatch_and_relay / plan_and_execute / dispatch_parallel 都收口了，
        # 只有这条路漏了）。归档只发生在 completed，失败照旧留看板看现场。
        archive = self.finish_room(exec_dispatch, exec_poll.get("status"),
                                   settle_forced=bool(exec_poll.get("settle_forced")))
        return {
            "mode": "direct",
            **exec_dispatch,
            **exec_poll,
            "result_text": result_text,
            "wechat": wechat,
            "relayed": relayed,
            "archive": archive,
        }

    # ── 多 Stand 结果汇总（并行召回 / 追问聚合）─────────────────

    def aggregate_results(self, results: list[dict]) -> str:
        """把多个 Stand 的并行结果/追问汇总成一条微信消息

        适用：多 Stand 并行返回结果、或部分 Stand 提出追问需用户裁决时，
        Caller 把它们汇总成单条消息（可直接喂 relay_to_wechat / cc-send）。

        输入 results 每项形如：
            {"room_id": "...", "stand": "Claude Code GLM-5.2", "role": "thinker",
             "status": "done" | "blocked" | "error" | ...,
             "summary": "一句话结论", "files": ["/path/a"], "questions": ["请确认..."]}

        输出（纯文本，5 段）：
            1. 总体状态：N 完成 / M 阻塞 / K 个追问
            2. 各 Stand 一句话结论（带角色与状态）
            3. 文件路径列表
            4. 需用户裁决的追问（每个问题标注由哪个 Stand 提出）
            5. 下一步建议
        """
        done = blocked = asked = 0
        files: list[str] = []
        questions: list[tuple[str, str]] = []
        for r in results or []:
            st = (r.get("status") or "").lower()
            if st == "done":
                done += 1
            elif st == "blocked":
                blocked += 1
            qs = r.get("questions") or []
            asked += len(qs)
            for q in qs:
                questions.append((r.get("stand", "?"), q))
            for f in (r.get("files") or []):
                if f not in files:
                    files.append(f)

        total = len(results or [])
        lines = [
            f"📊 总体状态：{total} 个 Stand —— {done} 完成 / {blocked} 阻塞 / {asked} 个追问",
            "",
            "各 Stand 结论：",
        ]
        for r in results or []:
            stand = r.get("stand", "?")
            role = r.get("role", "")
            st = r.get("status", "")
            summ = (r.get("summary") or "").strip().replace("\n", " ")
            summ = summ[:80] + ("…" if len(summ) > 80 else "")
            tag = f"{stand}{'·' + role if role else ''} / {st}"
            lines.append(f"  · [{tag}] {summ or '（无结论）'}")

        if files:
            lines += ["", "文件："]
            lines += [f"  · {f}" for f in files]

        if questions:
            lines += ["", "⚠️ 需你裁决的追问："]
            lines += [f"  · [{stand}] {q}" for stand, q in questions]

        lines.append("")
        if blocked or questions:
            lines.append("下一步建议：先回复上述追问 / 解除阻塞，我再让 Worker 续跑。")
        elif done:
            lines.append("下一步建议：全部完成，结果已汇总，可直接归档或发当事人。")
        else:
            lines.append("下一步建议：暂无结果，请检查 Stand 是否正常启动。")
        return "\n".join(lines)

    # ── 并行调度（多 request 各自独立 room + dispatch，并行 poll 合并返回）────

    def dispatch_parallel(
        self,
        requests: list[dict],
        poll_timeout: int = 600,
        poll_interval: float = 1.0,
        max_workers: int | None = None,
    ) -> dict:
        """并行派发多个任务：每个 request 独立创建 room + dispatch，并行 poll，合并返回。

        每个 request 是一个 dict，字段透传给 dispatch()：
            request (必填)   任务描述
            task_type         任务类型（可选）
            template_id       指定模板（可选）
            role              'thinker' | 'worker'（可选）
            room_id           复用已有房间（可选；并行场景一般不传）
            summary           该项一句话结论（merged_summary 用，可选）

        参数:
            poll_timeout   每项轮询超时秒数（默认 600）
            poll_interval  轮询间隔
            max_workers    线程并发上限；None=请求数（每项一个线程）

        返回:
            {
                "tasks": [
                    {"task_id", "status", "result",
                     "room_id", "session_id", "stand_name", "role",
                     "summary", "error", "elapsed"},
                    ...
                ],
                "merged_summary": str,   # aggregate_results 汇总的多任务文本
            }

        说明:
            - 复用 self.dispatch() / self.poll_result()，不改动二者逻辑。
            - requests.Session 线程安全；SQLite 每次调用新建连接，并行安全。
            - 单项 dispatch/poll 抛异常不会拖垮整批：该 task 降级为 status=error。
        """
        from concurrent.futures import ThreadPoolExecutor

        if not requests:
            return {"tasks": [], "merged_summary": "（无并行任务）"}

        def _run_one(idx: int, req: dict) -> tuple[int, dict | None, str | None, dict]:
            spec = dict(req)
            text = spec.get("request", "")
            summary = spec.get("summary")
            try:
                d = self.dispatch(
                    request=text,
                    task_type=spec.get("task_type"),
                    room_id=spec.get("room_id"),
                    template_id=spec.get("template_id"),
                    role=spec.get("role"),
                    request_summary=summary,
                    mode=spec.get("mode", "fanout"),
                )
                poll = self.poll_result(
                    room_id=d.get("room_id"),
                    session_id=d["session_id"],
                    stand_session_id=d.get("stand_session_id"),
                    after_id=d.get("message_id", 0) or 0,
                    stand_name=d.get("stand_name", ""),
                    timeout=poll_timeout,
                    poll_interval=poll_interval,
                    task_id=d.get("task_id", ""),
                    role=d.get("role", ""),
                    template=d.get("template_id", ""),
                )
                # 各项自己收口：谁先完成谁先归档，不必等整批（失败项照旧留看板）
                d["archive"] = self.finish_room(d, poll.get("status"),
                                                settle_forced=bool(poll.get("settle_forced")))
                return idx, d, summary, poll
            except Exception as e:
                logger.warning("dispatch_parallel 第 %d 项失败: %s", idx, e)
                return idx, None, summary, {
                    "status": "error",
                    "result_text": "",
                    "error": str(e),
                }

        workers = max_workers or len(requests)
        by_idx: dict[int, tuple[dict | None, str | None, dict]] = {}
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_run_one, i, r) for i, r in enumerate(requests)]
            for fut in futures:
                idx, d, summary, poll = fut.result()
                by_idx[idx] = (d, summary, poll)

        tasks: list[dict] = []
        for i in range(len(requests)):
            d, summary, poll = by_idx[i]
            d = d or {}
            tasks.append({
                "task_id": d.get("task_id"),
                "status": poll.get("status"),
                "result": poll.get("result_text") or poll.get("error") or "",
                "room_id": d.get("room_id"),
                "session_id": d.get("session_id"),
                "stand_name": d.get("stand_name"),
                "role": d.get("role"),
                "summary": summary,
                "error": poll.get("error"),
                "elapsed": poll.get("elapsed"),
                "archived": bool((d.get("archive") or {}).get("archived")),
            })

        merged_summary = self._merge_parallel_summary(tasks)
        logger.info(
            "dispatch_parallel 完成: %d 项 —— %s",
            len(tasks),
            ", ".join(str(t.get("status")) for t in tasks),
        )
        return {"tasks": tasks, "merged_summary": merged_summary}

    def _merge_parallel_summary(self, tasks: list[dict]) -> str:
        """把 dispatch_parallel 各任务结果汇总成一条 merged_summary 文本。

        复用 aggregate_results：把每个 task 转成 aggregate 兼容条目
        （status: completed→done，其余→blocked）。
        """
        entries: list[dict] = []
        for t in tasks or []:
            st = t.get("status")
            agg_st = "done" if st == "completed" else "blocked"
            result = t.get("result") or ""
            first_line = next(
                (ln.strip() for ln in result.splitlines() if ln.strip()),
                "",
            )[:80]
            entries.append({
                "room_id": t.get("room_id"),
                "stand": t.get("stand_name") or "?",
                "role": t.get("role") or "",
                "status": agg_st,
                "summary": t.get("summary") or first_line,
                "files": [],
                "questions": [],
            })
        return self.aggregate_results(entries)


# ── 便捷函数（无状态调用）──────────────────────────────────────────

def dispatch(
    request: str,
    task_type: str | None = None,
    room_id: str | None = None,
    template_id: str | None = None,
    role: str | None = None,
) -> dict:
    """单次派发（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.dispatch(
        request, task_type=task_type, room_id=room_id, template_id=template_id, role=role
    )


def dispatch_thinker(request: str, task_type: str | None = None, **kwargs) -> dict:
    """派给 Thinker（registry.default_thinker）：规划/分析/判断/路由"""
    caller = Caller()
    return caller.dispatch_thinker(request, task_type=task_type, **kwargs)


def dispatch_worker(request: str, task_type: str | None = None, **kwargs) -> dict:
    """派给 Worker（registry.default_worker）：执行型任务"""
    caller = Caller()
    return caller.dispatch_worker(request, task_type=task_type, **kwargs)


def plan_and_execute(request: str, task_type: str | None = None, **kwargs) -> dict:
    """Caller 两段式：Thinker 出计划 → Worker 执行（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.plan_and_execute(request, task_type=task_type, **kwargs)


def poll_result(session_id: str, timeout: int = 600) -> dict:
    """轮询结果（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.poll_result(session_id=session_id, timeout=timeout)


def relay_to_wechat(
    message: str,
    summary: str | None = None,
    file_path: str | None = None,
    dry_run: bool = False,
    raw: bool = False,
) -> dict:
    """代发微信（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.relay_to_wechat(
        message, summary=summary, file_path=file_path, dry_run=dry_run, raw=raw
    )


def dispatch_and_relay(
    request: str,
    task_type: str = "general",
    request_summary: str | None = None,
    **kwargs,
) -> dict:
    """一键派发 + 轮询 + 代发（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.dispatch_and_relay(
        request, task_type=task_type, request_summary=request_summary, **kwargs
    )


def aggregate_results(results: list[dict]) -> str:
    """把多个 Stand 的并行结果/追问汇总成一条微信消息（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.aggregate_results(results)


def dispatch_parallel(requests: list[dict], **kwargs) -> dict:
    """并行派发多个任务（创建临时 Caller 实例）。详见 Caller.dispatch_parallel"""
    caller = Caller()
    return caller.dispatch_parallel(requests, **kwargs)


# ═══════════════════════════════════════════════════════════════════════
# CLI 入口 —— Hermes 一行命令起任务 / 查状态 / 汇总（自带后台 + 微信代发）
# ═══════════════════════════════════════════════════════════════════════
import sys as _sys

TASKS_DIR = Path(
    os.environ.get("STANDCODE_TASKS_DIR") or str(Path(HOME_DIR) / ".standcode" / "tasks")
)

# ── 计划复用（P1-3）──────────────────────────────────────────────────
# Thinker 的产出此前是耗材：只在 plan_text 里活一次，不落盘、不进任何台账，同类任务
# 再来一遍要重新想（一个 Thinker 段 = 一个 Stand + 一次 thinking:high 轮询）。
# 现在落 data/plans/{task_id}.md + 一行 index.jsonl（append-only，同 rooms 台账的写法）。
#
# ⚠️ 复用是 opt-in（--reuse-plan），默认关。理由：静默套用一个过期计划会产出「看起来
# 做完了但做错了」的结果，而这种错不报警。所以必须显式要，且每次都回报套用了哪一条，
# 让用户能当场否掉。
PLANS_DIR = Path(__file__).resolve().parent.parent / "data" / "plans"
PLANS_INDEX = PLANS_DIR / "index.jsonl"
# 复用相似度阈值（字符 bigram Jaccard）。0.6 偏保守——宁可白想一遍，不可套错计划。
PLAN_REUSE_MIN_SCORE = _conf_float("STANDCODE_PLAN_REUSE_MIN", "plan_reuse_min", 0.6)


def _bigrams(text: str) -> set[str]:
    """字符二元组。中文没有空格分词，字符 bigram 比 token 切分稳，且零依赖。"""
    s = "".join((text or "").split())
    return {s[i:i + 2] for i in range(len(s) - 1)} or ({s} if s else set())


def _similarity(a: str, b: str) -> float:
    """Jaccard 相似度（0~1）。刻意用最笨的可解释算法——没有嵌入、没有模型调用，
    出了误配能直接看出是哪些字重叠导致的。"""
    ba, bb = _bigrams(a), _bigrams(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / len(ba | bb)


def save_plan(task_id: str, request: str, plan_text: str, parsed: dict | None = None) -> Path:
    """把 Thinker 的计划落盘 + 追加索引。写失败只告警，不拖垮主链。"""
    path = PLANS_DIR / f"{task_id}.md"
    try:
        PLANS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"<!-- task_id: {task_id} | saved: {_now_iso()} -->\n"
            f"# 原始任务\n\n{request}\n\n# 计划\n\n{plan_text}\n",
            encoding="utf-8",
        )
        with PLANS_INDEX.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": _now_iso(),
                "task_id": task_id,
                "request": (request or "")[:300],
                "path": str(path),
                "steps": len((parsed or {}).get("steps") or []),
                "goal": ((parsed or {}).get("goal") or "")[:120],
            }, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning("计划落盘失败 %s: %s", path, e)
    return path


def load_plans() -> list[dict]:
    """读计划索引（新→旧）。坏行跳过。"""
    if not PLANS_INDEX.exists():
        return []
    out = []
    try:
        for line in PLANS_INDEX.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except Exception as e:
        logger.warning("读计划索引失败: %s", e)
    return list(reversed(out))


def find_similar_plan(request: str, min_score: float | None = None) -> dict | None:
    """找一条足够像的历史计划。返回 {**索引项, "score", "plan_text"} 或 None。"""
    threshold = PLAN_REUSE_MIN_SCORE if min_score is None else min_score
    best, best_score = None, 0.0
    for item in load_plans():
        score = _similarity(request, item.get("request", ""))
        if score > best_score:
            best, best_score = item, score
    if not best or best_score < threshold:
        return None
    try:
        text = Path(best["path"]).read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("历史计划文件读不到（索引在但文件没了）%s: %s", best.get("path"), e)
        return None
    # 只取「# 计划」之后的部分喂给 Worker
    marker = "\n# 计划\n"
    plan_text = text.split(marker, 1)[1].strip() if marker in text else text
    return {**best, "score": round(best_score, 3), "plan_text": plan_text}


# ── 异步回调 inbox ────────────────────────────────────────────────────
INBOX_DIR = Path(
    __file__).resolve().parent.parent / "data" / "inbox"
PROCESSING_SUFFIX = ".processing"
DONE_SUFFIX = ".done"
# .processing 锁多久算死锁（被抢占）。默认 30 分钟：比任何一次「读 inbox → 汇总 → 代发」
# 都长得多，又不至于让一个被 SIGKILL 的进程把 task 锁到天荒地老。
LOCK_STALE_SEC = _conf_float("STANDCODE_LOCK_STALE_SEC", "lock_stale_sec", 1800)


def _state_path(task_id: str) -> Path:
    return TASKS_DIR / f"{task_id}.json"


def _write_state(task_id: str, state: dict) -> None:
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = _now_iso()
    tmp = _state_path(task_id).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.replace(_state_path(task_id))


def _read_state(task_id: str) -> dict | None:
    p = _state_path(task_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _new_bg_task_id() -> str:
    return f"bg-{int(time.time())}-{uuid.uuid4().hex[:6]}"


def _result_to_aggregate_entry(state: dict) -> dict:
    """把一个后台任务状态转成 aggregate_results 兼容的条目（与 aggregate_results 复用）"""
    spec = state.get("spec", {})
    st = state.get("status")
    agg_st = (
        "done" if st == "completed"
        else "blocked" if st in ("timeout", "error", "running", "starting")
        else st
    )
    return {
        "room_id": state.get("room_id"),
        "stand": state.get("stand_name") or spec.get("role") or "?",
        "role": state.get("role") or spec.get("role") or "",
        "status": agg_st,
        "summary": (state.get("result_text") or state.get("error") or "")
        [:120].replace("\n", " "),
        "files": [spec["file"]] if spec.get("file") else [],
        "questions": [],
    }


# ── 异步回调 inbox 工具 ─────────────────────────────────────────────

def _current_channel() -> str:
    """本进程属于哪条收信通道（2026-07-26 双通道上线；2026-08-02 扩多 caller）。

    多 caller（2026-08-02）：非 Hermes 身份的收信箱按 caller 名隔离——QClaw 派的
    任务只被 QClaw 的 `inbox --digest` 消化，Hermes 的 digest 不抢报（反之亦然）。
    Hermes 身份沿用原判据 HERMES_HOME：gateway 的 terminal 工具子进程继承它——
    主通道 ~/.qclaw-hermes → "main"；profiles/<name> → "<name>"。
    手动 CLI（无 HERMES_HOME）按 main 算。收信箱按通道隔离消化，
    防止 A 通道派的任务被 B 通道的 digest 抢先汇报到错误的聊天窗口。
    """
    if CALLER_NAME != "Hermes":
        return CALLER_NAME
    hh = (os.environ.get("HERMES_HOME") or "").rstrip("/")
    if not hh:
        return "main"
    base = os.path.basename(hh)
    parent = os.path.basename(os.path.dirname(hh))
    return base if parent == "profiles" else "main"


def _inbox_path(task_id: str) -> Path:
    return INBOX_DIR / f"{task_id}.json"


def _processing_path(task_id: str) -> Path:
    return INBOX_DIR / f"{task_id}{PROCESSING_SUFFIX}"


def write_inbox(task_id: str, payload: dict) -> None:
    """把任务结果写入 inbox（供各 caller 的 digest 按 channel 隔离读取）"""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    payload["task_id"] = payload.get("task_id", task_id)
    payload.setdefault("caller", CALLER_NAME)  # 多向派发：结果记谁派的
    payload["inbox_created_at"] = _now_iso()
    tmp = _inbox_path(task_id).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    tmp.replace(_inbox_path(task_id))
    logger.info("inbox 写入: %s (task=%s)", _inbox_path(task_id), task_id)


# ── 统一记忆沉淀钩子（2026-08-02 memory skill 接入派发链）──────────────
# 任务收网即沉淀：completed 结果写统一记忆库（~/skills/memory data/memory.db）的
# candidate 档——经晋升门（promote.py）人审才升 active，不污染正式记忆；recall 默认
# 不召回 candidate，量大可批量 reject（claim 带 [standcode:*] 前缀好筛）。
# 全程 fail-open：脚本缺失/超时/报错只记 debug，绝不影响收网主链。
# 开关：STANDCODE_MEMORY_SINK=off / local.json memory_sink=false。
MEMORY_SINK_ENABLED = _conf_bool("STANDCODE_MEMORY_SINK", "memory_sink", True)
_MEMORY_ADD_SCRIPT = (
    os.environ.get("STANDCODE_MEMORY_ADD")
    or _LOCAL_CONF.get("memory_add_script")
    or f"{_MEMORY_SCRIPTS_DIR}/add_memory.py"
)


def _memory_sink(task_id: str, spec: dict, request_summary: str | None,
                 result_text: str) -> None:
    if not (MEMORY_SINK_ENABLED and (result_text or "").strip()):
        return
    script = Path(_MEMORY_ADD_SCRIPT)
    if not script.exists():
        return
    req = " ".join((spec.get("request") or "").split())
    summary = (request_summary or req[:60]).strip() or "(无摘要)"
    first_line = next(
        (ln.strip() for ln in result_text.splitlines() if ln.strip()), "")
    claim = f"[standcode:{CALLER_NAME}] {summary} → {first_line}"[:200]
    evidence = " ".join(result_text.split())[:280]
    try:
        subprocess.run(
            ["python3", str(script),
             "--kind", "fact", "--status", "candidate",
             "--claim", claim, "--evidence", evidence,
             "--source", f"standcode:{CALLER_NAME}",
             "--source-path", f"task:{task_id}",
             "--tags", "standcode,auto",
             "--confidence", "0.5"],
            capture_output=True, timeout=8, check=False,
        )
    except Exception as e:  # noqa: BLE001 —— 辅助设施，任何异常都不许炸收网
        logger.debug("memory 沉淀跳过（fail-open）: %s", e)


def read_inbox(task_id: str) -> dict | None:
    """读取 inbox 文件，返回 payload 或 None"""
    p = _inbox_path(task_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as e:
        logger.warning("inbox 读取失败 %s: %s", p, e)
        return None


def delete_inbox(task_id: str) -> bool:
    """删除 inbox 文件（Hermes 汇总完成后清理）"""
    p = _inbox_path(task_id)
    pp = _processing_path(task_id)
    deleted = False
    if p.exists():
        p.unlink(missing_ok=True)
        deleted = True
    if pp.exists():
        pp.unlink(missing_ok=True)
    return deleted


def acquire_processing_lock(task_id: str) -> bool:
    """尝试获取 .processing 锁，成功返回 True，失败（已有他人处理中）返回 False。

    两处加固（2026-07-26 审计）：
    · **原子**：改动前是 `if exists(): return False` 再 write_text ——典型 TOCTOU，
      两个 Hermes 回合可以同时「获取成功」。改用 O_CREAT|O_EXCL，创建即占有，由内核保证。
    · **会过期**：改动前锁没有任何过期机制，进程被 SIGKILL（或 areco 重启连带杀掉）
      就留下永久锁，那个 task 从此永远返回 action="locked"，且没有任何 CLI 能清它。
      现在超过 LOCK_STALE_SEC 的锁视为死锁，抢占并记 warning。
    """
    pp = _processing_path(task_id)
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(pp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        # 已有锁：只有确认它已经死透才抢
        try:
            age = time.time() - pp.stat().st_mtime
        except OSError:
            return False
        if age <= LOCK_STALE_SEC:
            return False
        logger.warning(
            "抢占过期 .processing 锁（task=%s，已 %.0fs 未更新 > %.0fs）——"
            "多半是上个处理进程被杀了",
            task_id, age, LOCK_STALE_SEC,
        )
        try:
            pp.unlink(missing_ok=True)
            fd = os.open(str(pp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except Exception as e:
            logger.warning("抢占过期锁失败 %s: %s", pp, e)
            return False
    except Exception as e:
        logger.warning("获取 .processing 锁失败 %s: %s", pp, e)
        return False
    try:
        os.write(fd, f"{_now_iso()} pid={os.getpid()}\n".encode())
    finally:
        os.close(fd)
    return True


def release_processing_lock(task_id: str) -> None:
    """释放 .processing 锁"""
    pp = _processing_path(task_id)
    pp.unlink(missing_ok=True)


def send_callback_trigger(
    task_id: str, summary_hint: str = "", dry_run: bool = False,
    message: str | None = None,
) -> dict:
    """发送极简触发消息到微信，告知 Hermes 去 inbox 取结果

    dry_run=True 时只拼装不发送（测试用）；默认 False 真发 cc-send 触发消息。
    返回里带 dry_run / stdout / returncode，便于上层落 state、status 可见是否真发——
    避免「dry-run 未真发」误判掩盖真实的 cc-send 失败。
    """
    msg = message or f"任务 {summary_hint}（{task_id}）完成，Hermes 正在汇总…"

    # 目标会话为空时**绝不能发**：cc-send 裸 -s "" 会回落到「当前活跃会话指针」，
    # 于是一条任务完成通知被投进碰巧活跃的那个对话——发错人。relay_to_wechat 早有这道
    # 闸（未配置就直接返回错误），本函数一直漏了。config/local.json 不进仓，换台机器
    # 跑就是空值，不是边缘情况。
    if not WECHAT_TARGET:
        logger.warning("WECHAT_TARGET 未配置，跳过回调触发消息（task=%s）", task_id)
        return {
            "ok": False,
            "dry_run": False,
            "task_id": task_id,
            "message": msg,
            "stdout": "",
            "returncode": None,
            "error": "WECHAT_TARGET 未配置——不发，避免 cc-send 回落到活跃会话指针发错人",
        }

    if dry_run:
        logger.info("[dry-run] 回调触发消息未发送: task=%s", task_id)
        return {
            "ok": True,
            "dry_run": True,
            "task_id": task_id,
            "message": msg,
            "stdout": "",
            "returncode": 0,
        }

    try:
        proc = subprocess.run(
            [CC_SEND_BIN, "-s", WECHAT_TARGET, "-m", msg],
            capture_output=True, text=True, timeout=15,
            env={
                **os.environ,
                "HOME": HOME_DIR,
                "PATH": f"{HOME_DIR}/.npm-global/bin:{os.environ.get('PATH', '')}",
            },
        )
        ok = proc.returncode == 0
        if ok:
            logger.info("回调触发消息已发: task=%s", task_id)
        else:
            logger.warning(
                "回调触发消息发送失败: task=%s rc=%s out=%s",
                task_id, proc.returncode, (proc.stdout or "")[-200:],
            )
        return {
            "ok": ok,
            "dry_run": False,
            "task_id": task_id,
            "message": msg,
            "stdout": (proc.stdout or "").strip(),
            "returncode": proc.returncode,
        }
    except Exception as e:
        logger.warning("回调触发消息发送失败: %s", e)
        return {
            "ok": False,
            "dry_run": False,
            "task_id": task_id,
            "message": msg,
            "error": str(e),
        }


def summarize_inbox(payload: dict) -> str:
    """把 inbox payload 按模板汇总成微信消息（一句话结论 + 文件路径 + 核心要点 3-5 条）"""
    result_text = payload.get("result_text", "")
    status = payload.get("status", "?")
    request_summary = payload.get("request_summary") or ""
    files = payload.get("files") or payload.get("file", [])
    if isinstance(files, str):
        files = [files]

    # 一句话结论
    if status == "completed" and result_text:
        first_line = result_text.strip().split("\n")[0][:120]
        conclusion = request_summary or first_line or "任务完成"
    elif status == "error":
        conclusion = payload.get("error", "任务异常")
    else:
        conclusion = f"任务状态: {status}"

    # 核心要点（从 result_text 取前 3-5 个有效行）
    lines = [l.strip() for l in result_text.split("\n") if l.strip()]
    bullets = []
    for line in lines:
        if line.startswith(("```", "#", "---", "===", "--")):
            continue
        if len(line) > 120:
            line = line[:117] + "…"
        if line not in bullets:
            bullets.append(line)
        if len(bullets) >= 5:
            break

    # 证据分级标注（2026-07-26 agentacct 借鉴）：机检过的才配 ✅；只有 Worker 自述
    # 用 ⚠️ 诚实标注；机检没过必须 ❌ 醒目——「说完成但产物对不上」恰是最需要人看的。
    ver = payload.get("verification") or {}
    level = ver.get("level")
    if status == "completed":
        if level == "verified":
            head = (f"✅ {conclusion}（已验证：产物机检通过"
                    f"{'，经打回补齐' if ver.get('bounced') else ''}）")
        elif level == "check_failed":
            failed = [c["check"] for c in ver.get("checks", []) if not c.get("passed")]
            if ver.get("escalated"):
                head = (f"❌ {conclusion}（判据未过·已打回 1 次仍未过，升级人工复核："
                        f"{'、'.join(failed[:3]) or '机检失败'}）")
            else:
                head = f"❌ {conclusion}（判据未过：{'、'.join(failed[:3]) or '机检失败'}——Worker 自称完成但产物对不上）"
        else:
            head = f"⚠️ {conclusion}（{ver.get('note') or 'Worker 自述，无可机检判据'}）"
    else:
        head = f"✅ {conclusion}" if status == "completed" else f"⚠️ {conclusion}"
    msg_parts = [head]
    if files:
        msg_parts.append(f"📄 文件：{files[0] if len(files) == 1 else ', '.join(files[:3])}")
    if bullets:
        msg_parts.append("核心要点：")
        for i, b in enumerate(bullets, 1):
            msg_parts.append(f"{i}. {b}")
    # 每单成本（client_reported，拿不到就不显示——绝不编数）
    cost = payload.get("cost") or {}
    if cost.get("source") == "client_reported":
        total = int(cost.get("input_tokens", 0)) + int(cost.get("output_tokens", 0))
        msg_parts.append(
            f"💰 本单 ~{total/1000:.1f}k tok（输出 {int(cost.get('output_tokens',0))/1000:.1f}k，client_reported）"
        )
    # 附注
    if payload.get("room_id"):
        msg_parts.append(f"   房间: {payload['room_id']}")

    return "\n".join(msg_parts)


def process_inbox_callback(task_id: str) -> dict:
    """Hermes 技能入口：读取 inbox → 汇总 → 发微信 → 清理

    供 Hermes 的 StandCode skill 在识别到触发消息后调用。
    返回: {"ok": bool, "task_id": str, "message": str, "action": "relayed" | "locked" | "not_found"}
    """
    # 1. 尝试获取锁（防止并发处理）
    if not acquire_processing_lock(task_id):
        return {"ok": False, "task_id": task_id, "message": "已有其他进程在处理", "action": "locked"}

    try:
        # 2. 读取 inbox
        payload = read_inbox(task_id)
        if not payload:
            release_processing_lock(task_id)
            return {"ok": False, "task_id": task_id, "message": "inbox 中未找到该任务", "action": "not_found"}

        # 3. 汇总
        summary = summarize_inbox(payload)

        # 4. 发回微信。summarize_inbox 的产出已是「✅…📄…要点」成品，raw=True 原文直发——
        #    此前又经 _format_wechat 包一层，微信收到 ✅ 套 ✅ 的嵌套模板（2026-07-26 修）。
        r = relay_to_wechat(summary, raw=True)
        ok = r.get("ok", False)
        msg = summary

        # 5. 清理 inbox —— 只在真发出去之后。
        # 改动前无条件删：cc-send 失败（微信通道断、Clash 没起、目标会话失效）时，
        # 结果的唯一副本就此消失——Stand 白跑，用户什么都收不到，也无从补发。
        # 现在失败就留着，下次 Hermes 被唤醒还能从 inbox 里读到（拉模式本来就靠这个）。
        if ok:
            delete_inbox(task_id)
            action = "relayed"
        else:
            logger.warning(
                "微信代发失败，保留 inbox 待下次拉取（task=%s）：%s",
                task_id, r.get("error") or r,
            )
            action = "relay_failed"

        return {"ok": ok, "task_id": task_id, "message": msg, "action": action}
    except Exception as e:
        logger.error("process_inbox_callback 异常: %s", e)
        release_processing_lock(task_id)
        return {"ok": False, "task_id": task_id, "message": str(e), "action": "error"}
    finally:
        release_processing_lock(task_id)



def _finalize_waiter(
    caller: "Caller",
    task_id: str,
    state: dict,
    res: dict,
    *,
    spec: dict,
    files: list | None = None,
    request_summary: str | None = None,
    with_checks: bool = True,
    mark_done: bool = True,
) -> dict:
    """等待者公共收尾（run --wait / ask / _bg_worker 三处共用，2026-07-28 B4 抽并）。

    三处收尾块此前近乎复制已漂移（ask 路 verify_completion 漏传 plan output_path，
    plan 模式产物落点机检在 ask 路永远缺项——抽并时顺带修，与 run 路同口径）。

    流程：state 终态回填 → 落盘 → completed 时机检（产物文件 + plan output_path）
    + 每单成本 → 写 inbox → completed 标 .done（防下轮 digest 双报）。
    with_checks=False（_bg_worker 旧口径）：跳过机检与成本；
    mark_done=False（_bg_worker 旧口径）：inbox 不标 .done（由代发链清）。
    返回 {"status", "result_text", "verification", "cost", "inbox_path"}。
    """
    status = res.get("status", "completed")
    result_text = res.get("result_text", "")
    state.update({
        "status": status,
        "result_text": result_text,
        "result_preview": result_text[:500],
        "elapsed": res.get("elapsed"),
        "completed_at": res.get("completed_at") or _now_iso(),
        "room_id": res.get("room_id"),
        "session_id": res.get("session_id"),
        "stand_name": res.get("stand_name"),
        "template_id": res.get("template_id"),
        "role": res.get("role"),
        # 消息水位线：stuck/失联后若人工解开选项、Stand 继续跑完，迟到结果
        # 落在房间里 id>此值处——reconcile 补收凭它增量取，不会翻旧账
        "messages_count": res.get("messages_count"),
        "stuck_last_line": res.get("stuck_last_line"),
        # settle_forced 持久化：灯坏死强制定稿的任务，真正干完的迟到结果还会落
        # 房间——reconcile 凭此标志 + 水位线做增补扫描
        "settle_forced": res.get("settle_forced"),
        "settle_reason": res.get("settle_reason"),
        "error": res.get("error"),
    })
    _write_state(task_id, state)
    # ── 机检收口 + 每单成本（2026-07-26 全量学习优化，agentacct 借鉴件）──
    # verification：completed 时把可机检判据（产物文件存在且非空）真跑一遍，
    # 回执按 verified/check_failed/agent_reported 分级标注——Worker 说完成
    # ≠ 完成，机器过一遍才算数。cost：从 Stand 自己的 transcript 读 usage，
    # 标 client_reported，拿不到就 None（绝不估算编数）。
    verification = None
    cost = None
    if with_checks:
        if status == "completed":
            plan_parsed = res.get("plan_parsed") if isinstance(res.get("plan_parsed"), dict) else {}
            acceptance = spec.get("acceptance") if isinstance(spec.get("acceptance"), dict) else None
            gate_ver = res.get("verification") if isinstance(res.get("verification"), dict) else None
            if gate_ver:
                # 把关闸已在派发链跑过（含打回/升级）——直接采信，不重跑
                verification = gate_ver
            elif acceptance:
                if ACCEPTANCE_GATE_ENABLED:
                    # 带验收栏但没走闸的路（plan 模式等）：判据机检照跑，只是不打回
                    verification = verify_acceptance(
                        acceptance,
                        result_text=result_text,
                        files=files or [],
                        output_path=(plan_parsed or {}).get("output_path"),
                    )
                else:
                    # 2026-07-29 高律师令验收闸整体关停：判据不机检，结果直报并如实标注
                    verification = {
                        "level": "agent_reported",
                        "checks": [],
                        "criteria_source": acceptance.get("source", "unknown"),
                        "note": "验收闸已关停（2026-07-29 高律师令），判据未机检，结果直报",
                    }
            else:
                # 旧式派单（spec 无验收栏，改动前落盘的 bg 回放等）：照常跑旧口径机检，
                # 报告里如实标注「无判据未验」（批件①向后兼容项）
                verification = verify_completion(
                    files=files or [],
                    output_path=(plan_parsed or {}).get("output_path"),
                )
                verification["criteria_source"] = "none"
                if verification.get("level") == "agent_reported" and \
                        spec.get("mode") in ("worker", "fast", "plan"):
                    verification["note"] = "旧式派单（无验收栏），无判据未验"
        cost = caller.collect_stand_cost(
            res.get("stand_session_id")
            or (res.get("execute") or {}).get("stand_session_id")
            or ""
        )
        state["verification"] = verification
        state["cost"] = cost
        _write_state(task_id, state)
    # inbox 与各等待者同构：Hermes 醒来后凭 task_id 读全文（process_inbox_callback 兼容）
    write_inbox(task_id, {
        "task_id": task_id,
        "room_id": res.get("room_id"),
        "stand": res.get("stand_name") or spec.get("role") or "?",
        "role": res.get("role") or spec.get("role") or "",
        "status": status,
        "result_text": result_text,
        "files": files or [],
        "request_summary": request_summary,
        "request": (spec.get("request") or "")[:200],
        "verification": verification,
        "cost": cost,
        "channel": _current_channel(),
        "caller": CALLER_NAME,
        "depth": spec.get("depth", 0),
        "error": res.get("error"),
    })
    # 统一记忆沉淀（2026-08-02）：completed 结果落 memory.db candidate，fail-open
    if status == "completed":
        _memory_sink(task_id, spec, request_summary, result_text)
    inbox_final = _inbox_path(task_id)
    if mark_done and status == "completed":
        # 双报去重（2026-07-26 高律师批全量修复 B4）：completed 的结果已随本进程退出
        # 经 gateway notify 全文转述，inbox 再留 pending 会在下轮 digest 二次汇报。
        # 完成即标 .done；stuck/lost/error/timeout 仍留 pending 由 digest 兜底。
        try:
            done = inbox_final.with_name(inbox_final.name + DONE_SUFFIX)
            inbox_final.rename(done)
            inbox_final = done
        except OSError as e:
            logger.warning("inbox 标 .done 失败（会出现一次重复汇报）: %s", e)
    return {
        "status": status,
        "result_text": result_text,
        "verification": verification,
        "cost": cost,
        "inbox_path": inbox_final,
    }


def _bg_worker(task_id: str) -> int:
    """后台 worker：dispatch → 主动轮询(1s) → 写 inbox + 发触发消息 → 落状态；出错也写 inbox。"""
    state = _read_state(task_id)
    if not state:
        print(f"未找到任务状态 {task_id}", file=_sys.stderr)
        return 2
    spec = state.get("spec", {})
    # 拉模式（2026-07-25 用户定）：spec.dry_run 不再影响任何发送——触发消息链已废除
    # （下方两处 send_callback_trigger 恒 dry_run=True 只拼不发），结果只落 inbox 等 Hermes 拉取。
    caller = Caller()
    state["status"] = "running"
    _write_state(task_id, state)
    try:
        # 模式回放：新 spec 带 mode，老 spec（本次改动前落盘的）只有 plan/role —— 都交给
        # resolve_mode 推导，保证重启续跑的老任务行为不变。
        decision = resolve_mode(
            spec.get("mode"),
            role=spec.get("role"),
            plan=bool(spec.get("plan")),
            plan_only=bool(spec.get("plan_only")),
            subs=spec.get("subs"),
        )
        bg_args = SimpleNamespace(
            request=spec.get("request", ""),
            task_type=spec.get("task_type") or "general",
            summary=spec.get("summary"),
            file=spec.get("file"),
            room_id=spec.get("room_id"),
            template=spec.get("template"),
            reuse_plan=bool(spec.get("reuse_plan")),
            fresh=bool(spec.get("fresh")),
        )
        # dry_run=True：后台不直接发完整结果（inbox 设计：Hermes 读 inbox 后代发）
        # poll_timeout=0：无限等待，直到 Stand 完成
        res = _run_by_mode(
            caller, decision, bg_args, 0, dry_run=True,
            acceptance=spec.get("acceptance") if isinstance(spec.get("acceptance"), dict) else None,
        )
        result_text = res.get("result_text", "")
        poll_status = res.get("status", "completed")
        room_id = res.get("room_id")
        session_id = res.get("session_id")
        state["work_mode"] = res.get("mode")

        # 与 run --wait 同一份公共收尾（2026-07-28 B4 抽并）。bg 旧口径保留：
        # 不跑机检/成本（with_checks=False）、inbox 不标 .done（结果由
        # process_inbox_callback 代发后才清）。
        # 注：完整结果不直接发（inbox 设计：Hermes 读 inbox 后由 process_inbox_callback
        # 代发）。wechat_relayed/wechat_dry_run 改由下方触发消息结果决定，
        # 避免「dry-run 未真发」误判掩盖真实 cc-send 失败。
        _finalize_waiter(
            caller, task_id, state, res,
            spec=spec,
            files=[spec["file"]] if spec.get("file") else [],
            request_summary=spec.get("summary"),
            with_checks=False,
            mark_done=False,
        )
        # 拉模式（2026-07-25 用户定）：触发消息链废除，恒 dry_run=True 只拼不发——
        # 结果只落 inbox，由 Hermes 下次被微信唤醒时拉取（SKILL.md「收信箱拉模式」）。
        trigger = send_callback_trigger(
            task_id, summary_hint=spec.get("summary", ""), dry_run=True
        )
        state["callback_triggered"] = True
        state["trigger"] = trigger
        # wechat_relayed 只在触发消息真发成功时置 True；dry_run 或 cc-send 失败均置 False
        state["wechat_relayed"] = bool(trigger.get("ok")) and not trigger.get(
            "dry_run", False
        )
        state["wechat_dry_run"] = trigger.get("dry_run", False)
    except Exception as e:
        state.update({"status": "error", "error": str(e), "completed_at": _now_iso()})
        try:
            # 异常也写 inbox + 发触发消息（不再直接发完整异常消息）
            inbox_payload = {
                "task_id": task_id,
                "room_id": None,
                "stand": "?",
                "role": spec.get("role") or "",
                "status": "error",
                "result_text": f"后台任务异常: {e}",
                "files": [spec["file"]] if spec.get("file") else [],
                "request_summary": spec.get("summary"),
                "request": spec.get("request", "")[:200],
                "channel": _current_channel(),
                "error": str(e),
            }
            write_inbox(task_id, inbox_payload)
            # 拉模式：异常结果同样只落 inbox，触发消息恒不发（同上）
            trigger = send_callback_trigger(
                task_id, summary_hint=spec.get("summary", "") or "异常", dry_run=True
            )
            state["callback_triggered"] = True
            state["trigger"] = trigger
            state["wechat_relayed"] = bool(trigger.get("ok")) and not trigger.get(
                "dry_run", False
            )
            state["wechat_dry_run"] = trigger.get("dry_run", False)
            state["wechat_relayed_error"] = True
        except Exception:
            pass
    _write_state(task_id, state)
    return 0 if state.get("status") == "completed" else 1


def _run_by_mode(
    caller: "Caller",
    decision: dict,
    args,
    timeout: int,
    dry_run: bool,
    acceptance: dict | None = None,
) -> dict:
    """按模式跑一次「派发 + 轮询」，把四种模式的返回归一成同一形状。

    存在的理由：_cmd_run 有三个调用点（--wait / 裸前台 / _bg_worker 的 spec 回放），
    四种模式 × 三个调用点 = 十二份分支。归一到这里，调用点各自只管 dry_run 与输出格式。

    归一后的键：mode / status / result_text / room_id / session_id / stand_name /
    template_id / role / task_id / elapsed / completed_at / error，
    外加各模式自己的原始结果（plan/execute/tasks/degraded…）原样透传。

    status 口径：
        completed  全部成功（fanout 要求每个子任务都 completed）
        partial    fanout 部分成功——刻意不算 completed，退出码非 0，避免「半成功」被
                   当全成功记账（漏报比误报更贵）
        其余       沿用 poll_result 的 timeout / lost / error / plan_failed
    """
    mode = decision["mode"]
    common = dict(
        task_type=args.task_type,
        request_summary=args.summary,
        file_path=args.file,
        poll_timeout=timeout,
        dry_run=dry_run,
        fresh=bool(getattr(args, "fresh", False)),
    )

    if mode == "plan":
        res = caller.plan_and_execute(
            args.request, reuse_plan=getattr(args, "reuse_plan", False), **common
        )
        exe = res.get("execute", {}) or {}
        return {
            **res,
            "mode": mode,
            "status": exe.get("status", res.get("stage") if res.get("stage") == "plan_failed" else "error"),
            "result_text": res.get("result_text") or exe.get("result_text", ""),
            "room_id": exe.get("room_id") or (res.get("plan", {}) or {}).get("room_id"),
            "session_id": exe.get("session_id") or (res.get("plan", {}) or {}).get("session_id"),
            "stand_name": exe.get("stand_name"),
            "template_id": exe.get("template_id"),
            "role": exe.get("role"),
            "task_id": exe.get("task_id"),
            "elapsed": exe.get("elapsed"),
            "completed_at": exe.get("completed_at"),
            "error": res.get("error") or exe.get("error"),
        }

    if mode == "fanout":
        preamble = (args.request or "").strip()
        requests = [
            {
                "request": (f"{preamble}\n\n【本子任务】\n{s}" if preamble else s),
                "task_type": args.task_type,
                "role": "worker",
                "template_id": args.template,
                "summary": s[:40],
                "mode": mode,
            }
            for s in decision["subs"]
        ]
        res = caller.dispatch_parallel(requests, poll_timeout=timeout)
        tasks = res.get("tasks", [])
        done = [t for t in tasks if t.get("status") == "completed"]
        status = "completed" if tasks and len(done) == len(tasks) else (
            "partial" if done else "error"
        )
        return {
            **res,
            "mode": mode,
            "status": status,
            "result_text": res.get("merged_summary", ""),
            "room_id": None,
            "session_id": None,
            "stand_name": f"{len(done)}/{len(tasks)} Worker",
            "template_id": args.template,
            "role": "worker",
            "task_id": None,
            "elapsed": max((t.get("elapsed") or 0) for t in tasks) if tasks else None,
            "completed_at": _now_iso(),
            "error": None if status == "completed" else
                     "; ".join(f"{t.get('summary') or '?'}: {t.get('error')}"
                               for t in tasks if t.get("error")) or f"{len(tasks) - len(done)} 个子任务未完成",
        }

    # fast：快速 Worker（hy3）单段派发（2026-07-27）。
    # role 必须 None——dispatch 模板优先级是 template_id > role > task_type，传 role="worker"
    # 会被 default_worker（claude-glm52）顶掉，task_map["fast"] 永远轮不到。
    # args.task_type 的 argparse 缺省是 "general"（= 用户没指定），此时回落 "fast" 让
    # task_map["fast"]（areco 设置页 fastWorker=workbuddy）接住；显式给了别的 task_type 则尊重。
    if mode == "fast":
        res = caller.dispatch_and_relay(
            args.request,
            role=None,
            task_type=(args.task_type if args.task_type not in (None, "general") else "fast"),
            room_id=args.room_id,
            template_id=args.template,
            plan_only=False,
            mode="fast",
            poll_timeout=timeout,
            dry_run=dry_run,
            request_summary=args.summary,
            file_path=args.file,
            acceptance=acceptance,
            fresh=bool(getattr(args, "fresh", False)),
        )
        return {**res, "mode": mode}

    # think / worker：单段派发（--isolated 只对 worker 有意义：per-session cwd 隔离工作区）
    # ⑤ 路由反转（2026-07-29）：worker 模式 = 重活车道（法律/代码词才会路由到这），模板
    # 锚定 default_heavy_worker 而非 role 默认——default_worker 已反转为 hy3，走 role
    # 解析重活会滑进轻车。显式 --template 仍最高优先。
    # （2026-07-30 定案：重活锚 SoT = areco 设置页，加载层 resolve_lane_anchors 应用）
    res = caller.dispatch_and_relay(
        args.request,
        role=decision["role"],
        room_id=args.room_id,
        template_id=(args.template or
                     (caller.default_heavy_worker_id if mode == "worker" else None)),
        plan_only=decision["plan_only"],
        mode=mode,
        isolated=bool(getattr(args, "isolated", False)),
        workspace_repo=getattr(args, "workspace_repo", None),
        acceptance=(acceptance if mode == "worker" else None),
        **common,
    )
    return {**res, "mode": mode}


def _ps_lines_for(pids: list) -> dict[int, str] | None:
    """一次 ps 拿一组 pid 的 `pid lstart command` 行（P2-9 批量化：原先每候选各 fork
    一次 ps）。返回 {pid: 行}；不存在的 pid 无行（= 判死）。ps 本身跑不动返回 None，
    调用方回落逐 pid 查（保守口径不变）。"""
    valid: list[str] = []
    for p in pids:
        try:
            n = int(p)
        except (TypeError, ValueError):
            continue
        # macOS pid_max=99998；超范围 pid 会让 ps 整批报 "process id too large"
        # 一个坏值毒化全部查询（实测）。超范围本就不可能是活进程，直接不带 = 判死。
        if 0 < n <= 99999:
            valid.append(str(n))
    if not valid:
        return {}
    try:
        out = subprocess.run(
            ["ps", "-o", "pid=,lstart=,command=", "-p", ",".join(valid)],
            capture_output=True, text=True, timeout=5,
            env={**os.environ, "LC_ALL": "C"},  # 与 _waiter_alive 同款：锁 C locale
        )
    except Exception:
        return None
    lines: dict[int, str] = {}
    for raw in (out.stdout or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            lines[int(raw.split(None, 1)[0])] = raw
        except (ValueError, IndexError):
            continue
    return lines


def _find_inflight_dup(request: str, window_sec: float = DUP_WINDOW_SEC) -> dict | None:
    """扫 TASKS_DIR 找「同一 request 的在途 running 任务」（2026-07-28 A2 重复派发闸）。

    全部满足才算在途重复：① status=running；② spec.request 规范化（压缩空白+lower）
    与本次相同；③ 等待者存活（B5 加固口径，pid 复用不算活）；④ 创建于 window 内
    （窗口外的 running 是陈旧 state，等待者早死 reconcile 还没扫到，不该拦新派发）。
    任一环节读不动都跳过该任务——宁放行不误拦，误拦 = 用户任务凭空消失。
    P2-9：判活的 ps 批量化——先收齐候选再一次 ps -p pid1,pid2 查全表。
    """
    norm = _norm_request(request)
    if not norm:
        return None
    try:
        files = sorted(TASKS_DIR.glob("*.json"))
    except OSError:
        return None
    now = time.time()
    candidates: list[tuple[Path, dict]] = []
    for p in files:
        try:
            st = json.loads(p.read_text())
        except Exception:
            continue
        if st.get("status") != "running":
            continue
        if _norm_request((st.get("spec") or {}).get("request", "")) != norm:
            continue
        try:
            created = _parse_iso_ts(st.get("created_at")) or p.stat().st_mtime
        except OSError:
            continue
        if now - created > window_sec:
            continue
        candidates.append((p, st))
    if not candidates:
        return None
    ps_lines = _ps_lines_for([st.get("pid") for _, st in candidates])
    for p, st in candidates:
        if ps_lines is not None:
            try:
                line = ps_lines.get(int(st.get("pid") or 0), "")
            except (TypeError, ValueError):
                line = ""
        else:
            line = None  # ps 批量跑不动：回落 _waiter_alive 内部逐 pid 查
        if not _waiter_alive(st.get("pid"), task_id=st.get("task_id") or p.stem,
                             start_ts=st.get("start_ts"),
                             request=(st.get("spec") or {}).get("request", ""),
                             ps_line=line):
            continue
        return {
            "task_id": st.get("task_id") or p.stem,
            "room_id": st.get("room_id")
                       or ((st.get("dispatches") or [{}])[-1].get("room_id")),
            "pid": st.get("pid"),
            "created_at": st.get("created_at"),
        }
    return None


def _cmd_run(args) -> int:
    # --timeout 未显式给时：--wait/--bg 默认 0（无限等到 Stand 完成），普通前台默认 600
    timeout = args.timeout if args.timeout is not None else (
        0 if (getattr(args, "wait", False) or getattr(args, "bg", False)) else 600
    )
    if (getattr(args, "wait", False) or getattr(args, "bg", False)) \
            and MIN_TIMEOUT_SEC > 0 and 0 < timeout < MIN_TIMEOUT_SEC:
        logger.warning(
            "显式 --timeout %ds 低于下限，钳到 %ds（Stand 永不设短超时；真要短限时先 STANDCODE_MIN_TIMEOUT=0）",
            timeout, int(MIN_TIMEOUT_SEC),
        )
        timeout = int(MIN_TIMEOUT_SEC)

    # ── 模式决策（P0-1：模式是一等字段，两代参数在 resolve_mode 唯一收敛）──
    try:
        decision = resolve_mode(
            getattr(args, "mode", None),
            role=args.role,
            plan=args.plan,
            plan_only=getattr(args, "plan_only", False),
            subs=getattr(args, "subs", None),
        )
    except ModeConflictError as e:
        print(json.dumps(
            {"status": "mode_conflict", "error": str(e)},
            ensure_ascii=False, indent=2,
        ), file=_sys.stderr)
        return 2

    # operator 车道不派发：run 的语义就是「派」，受理它等于让审计里的 mode 撒谎。
    if decision["mode"] == "operator":
        log_audit("mode_rejected", {
            "mode": "operator", "reason": "run 不受理 operator 车道",
            "request_preview": (args.request or "")[:200],
        })
        print(json.dumps({
            "status": "not_dispatchable",
            "mode": "operator",
            "error": "operator 是 Caller 自持车道，run 不受理——这类动作核对白名单后自己跑。",
            "suggested": f"python3 {Path(__file__).name} check '<命令或任务>'  # 核查并记账",
        }, ensure_ascii=False, indent=2), file=_sys.stderr)
        return 2

    args.plan = decision["mode"] == "plan"  # 供下方 bg spec 回放沿用旧字段

    # ── 派发深度闸（2026-08-02 多向派发防套娃）──
    # go 委托 _cmd_run，此处一闸全覆盖。深度来源：--depth 旗标 > env
    # STANDCODE_DISPATCH_DEPTH > 0。达上限拒派（退出码 2）；--force 可越（回执须说明）。
    depth = DISPATCH_DEPTH if getattr(args, "depth", None) is None \
        else max(0, int(args.depth))
    if depth >= MAX_DISPATCH_DEPTH and not getattr(args, "force", False):
        log_audit("dispatch_blocked", {
            "mode": decision["mode"], "blocked": True, "reason": "depth_limit",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "request_preview": (args.request or "")[:200],
        })
        print(json.dumps({
            "status": "depth_blocked",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "error": (f"派发深度 {depth} 已达上限 {MAX_DISPATCH_DEPTH}——转派链过长"
                      f"（分身层退役教训：中转税没有正确率增量）。亲自完成本单，"
                      f"或向委派人回报拆分建议；确有必要可 --force 强派并在回执说明。"),
        }, ensure_ascii=False, indent=2), file=_sys.stderr)
        return 2

    # ── 作业单验收栏（2026-07-29 批件①）：路由定夺后、派发前补齐三栏 ──
    # worker/fast 自动追加（幂等，已带验收栏不重复）；plan 只解析不追加——PLAN_TEMPLATE
    # 本就强制 Thinker 写「完成判据/最终产物落点」，再贴一份就是同一契约两处漂移；
    # think 不加（Thinker 交判断不交产物）；fanout 子任务结构另置，本批不动。
    # 位置在 resolve_mode 之后是刻意的：fast 车道按原始正文长度/关键词路由，追加块不参与路由。
    # 2026-07-29 高律师令验收闸整体关停：ACCEPTANCE_GATE_ENABLED=False 时本段仍照跑
    # （验收栏三栏信息价值还在），但后续机检/打回/升级全链路不再触发。
    acceptance = None
    if decision["mode"] in ("worker", "fast"):
        args.request, acceptance = ensure_acceptance_block(args.request)
    elif decision["mode"] == "plan":
        acceptance = extract_acceptance(args.request)

    # ── 委派基础设施说明（2026-08-02）：验收栏之后、派发之前追加在任务书最尾 ──
    # 所有模式都注（Thinker 也该会用记忆/对话史）；幂等；开关见 INFRA_NOTE_ENABLED。
    args.request = ensure_infra_note(args.request, depth=depth)

    # ── 后台（已弃用 2026-07-25）──
    if getattr(args, "bg", False):
        print(
            "⚠️ DEPRECATED: --bg 是 start_new_session 脱管进程，Hermes gateway 追踪不到，"
            "唤醒链绕外网 cc-send。\n"
            "   新姿势：Hermes 用 terminal 工具 background=true + notify_on_complete=true 跑 "
            "`caller.py run --wait …`，进程退出由 gateway 自动回注微信（见 SKILL.md「唤醒与执行位置」）。",
            file=_sys.stderr,
        )
        task_id = _new_bg_task_id()
        spec = {
            "request": args.request,
            "task_type": args.task_type,
            "role": args.role,
            "template": args.template,
            "room_id": args.room_id,
            "summary": args.summary,
            "file": args.file,
            "timeout": timeout,
            "plan": args.plan,
            "mode": decision["mode"],
            "plan_only": decision["plan_only"],
            "subs": decision["subs"],
            "reuse_plan": getattr(args, "reuse_plan", False),
            "fresh": bool(getattr(args, "fresh", False)),
            "no_relay": args.no_relay,
            "dry_run": args.dry_run,
            "acceptance": acceptance,
            "caller": CALLER_NAME,
            "depth": depth,
        }
        log_path = TASKS_DIR / f"{task_id}.log"
        TASKS_DIR.mkdir(parents=True, exist_ok=True)
        state = {
            "task_id": task_id,
            "spec": spec,
            "status": "starting",
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "pid": None,
            "log_path": str(log_path),
            "channel": _current_channel(),
        }
        _write_state(task_id, state)
        logf = open(log_path, "a")
        proc = subprocess.Popen(
            [_sys.executable, str(Path(__file__).resolve()), "_worker", task_id],
            cwd=str(Path(__file__).resolve().parent),
            env={**os.environ},
            stdin=subprocess.DEVNULL,
            stdout=logf,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        state["pid"] = proc.pid
        state["start_ts"] = time.time()  # worker 进程启动时刻（B5 pid 复用判别用）
        _write_state(task_id, state)
        print(task_id)
        print(f"查状态: python3 {Path(__file__).name} status {task_id}")
        print(f"看日志: tail -f {log_path}")
        return 0

    # ── 等待者模式（唤醒主链，2026-07-25 定案）──
    # 前台阻塞 dispatch→poll；结果写 inbox + stdout 全文；不发微信、不发触发消息。
    # 配合 Hermes gateway terminal 工具 background=true+notify_on_complete=true 使用：
    # 本进程退出即触发 gateway watcher 回注原微信会话（零 cc-send、零 API key、零 chat_id 落盘）；
    # 执行者（Stand）全程是 areco 会话，看板可见可接管——等待者只是轻量 poll，不是执行者。
    if getattr(args, "wait", False):
        # 重复派发闸（2026-07-28 A2，07-28 实证同一任务 47 秒内 go 两次）：同 request
        # 有在途 running 任务且等待者存活 → 拒派，退出码 2；--force 显式跳过。
        # 检查放在 _cmd_run --wait 入口一处：go（委托 _cmd_run）与 fanout/plan
        # （同走 --wait 链）全覆盖。
        if not getattr(args, "force", False):
            dup = _find_inflight_dup(args.request)
            if dup:
                print(json.dumps({
                    "status": "duplicate",
                    "inflight": dup,
                    "error": (f"同一 request 已有在途任务 {dup['task_id']}"
                              f"（房间 {dup.get('room_id') or '-'}，等待者 pid {dup.get('pid')}）"
                              f"——等它跑完；确认它已死可加 --force 强派"),
                }, ensure_ascii=False, indent=2), file=_sys.stderr)
                return 2
        task_id = f"wait-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        spec = {
            "request": args.request,
            "task_type": args.task_type,
            "role": args.role,
            "template": args.template,
            "room_id": args.room_id,
            "summary": args.summary,
            "file": args.file,
            "timeout": timeout,
            "plan": args.plan,
            "mode": decision["mode"],
            "plan_only": decision["plan_only"],
            "subs": decision["subs"],
            "acceptance": acceptance,
            "caller": CALLER_NAME,
            "depth": depth,
        }
        state = {
            "task_id": task_id,
            "mode": "wait",
            "work_mode": decision["mode"],
            "spec": spec,
            "status": "running",
            "created_at": _now_iso(),
            "pid": os.getpid(),
            # 等待者进程启动时刻（B5）：_waiter_alive 拿它对 ps lstart 判 pid 复用
            "start_ts": _PROC_START_TS,
            "channel": _current_channel(),  # 双通道:reconcile 补收时凭它回对通道
        }
        _write_state(task_id, state)
        # P2-9：go 链已实例化过 Caller（读 areco 三级 + registry 双载），透传复用省一次
        caller = getattr(args, "_caller", None) or Caller()

        # 派发面包屑（2026-07-26 reconcile 前置）：dispatch 一返回就把房间/Stand/消息
        # 水位线写进 state——等待者此后任何时刻死掉，reconcile 都能凭它去房间补收。
        # 没有面包屑的死等待者连房间都定位不到（room_id 旧逻辑只在收尾时才回填）。
        _bc_lock = threading.Lock()

        def _breadcrumb(d: dict) -> None:
            with _bc_lock:  # fanout/plan 多次 dispatch 并发回调，追加要互斥
                # 直接改闭包里的 state 对象——收尾 state.update 后的整体落盘才不会把面包屑冲掉
                state.setdefault("dispatches", []).append({
                    "task_id": d.get("task_id"),
                    "room_id": d.get("room_id"),
                    "session_id": d.get("session_id"),
                    "stand_name": d.get("stand_name"),
                    "stand_session_id": d.get("stand_session_id"),
                    "message_id": d.get("message_id"),
                    "at": _now_iso(),
                })
                _write_state(task_id, state)

        caller._on_dispatch = _breadcrumb
        try:
            # dry_run=True：relay_to_wechat 只拼不发——微信回复由 gateway notify 唤醒 Hermes 后自行组织
            res = _run_by_mode(caller, decision, args, timeout, dry_run=True,
                               acceptance=acceptance)
            result_text = res.get("result_text", "")
            status = res.get("status", "completed")
            room_id = res.get("room_id")
            session_id = res.get("session_id")
        except ModeConflictError as e:
            state.update({"status": "mode_conflict", "error": str(e), "completed_at": _now_iso()})
            _write_state(task_id, state)
            print(json.dumps(
                {"mode": "wait", "task_id": task_id, "status": "mode_conflict", "error": str(e)},
                ensure_ascii=False, indent=2,
            ))
            return 2
        except GatekeeperBlockedError as e:
            state.update({"status": "blocked", "error": str(e), "completed_at": _now_iso()})
            _write_state(task_id, state)
            print(json.dumps(
                {"mode": "wait", "task_id": task_id, "status": "blocked", "blocked": True,
                 "error": str(e), "request_preview": (args.request or "")[:200]},
                ensure_ascii=False, indent=2,
            ))
            return 2
        except Exception as e:
            # error 终态也要落 inbox（2026-07-28 A1）：poll 读库致命错误穿透上来的
            # RuntimeError 等异常，此前只落 state 不写 inbox——结果的唯一副本随进程
            # 退出消失，digest 也无从兜底。
            state.update({"status": "error", "error": str(e), "completed_at": _now_iso()})
            _write_state(task_id, state)
            try:
                write_inbox(task_id, {
                    "task_id": task_id,
                    "room_id": None,
                    "stand": "?",
                    "role": args.role or "",
                    "status": "error",
                    "result_text": "",
                    "files": [args.file] if args.file else [],
                    "request_summary": args.summary,
                    "request": (args.request or "")[:200],
                    "channel": _current_channel(),
                    "error": str(e),
                })
            except Exception:
                pass
            print(json.dumps(
                {"mode": "wait", "task_id": task_id, "status": "error", "error": str(e)},
                ensure_ascii=False, indent=2,
            ))
            return 1
        # 公共收尾（2026-07-28 B4 抽并）：state 终态 → 机检+成本 → inbox → 标 .done
        fin = _finalize_waiter(
            caller, task_id, state, res,
            spec=spec,
            files=[args.file] if args.file else [],
            request_summary=args.summary,
        )
        verification = fin["verification"]
        cost = fin["cost"]
        inbox_final = fin["inbox_path"]
        # --brief：stdout 截断到简报级（全文已落 inbox，凭 inbox_path 可取）。
        # 这段 stdout 会整个进 Hermes 会话历史、随后续每次 API 调用回放——长结果
        # 全文回放是今天工具输出占历史 85% 的主因之一。缺省行为不变（决议口径：
        # stdout 全文），由 SKILL.md 指引 Hermes 默认带 --brief。
        out_text = result_text
        truncated = False
        if getattr(args, "brief", False) and len(result_text) > 700:
            out_text = result_text[:700] + f"\n…[截断，全文 {len(result_text)} 字见 inbox]"
            truncated = True
        print(json.dumps(
            {
                "mode": "wait",           # 执行方式（等待者模式），非工作模式
                "work_mode": res.get("mode"),  # 工作模式（worker/think/plan/fanout）
                "task_id": task_id,
                "room_id": room_id,
                "session_id": session_id,
                "stand_name": res.get("stand_name"),
                "template_id": res.get("template_id"),
                "role": res.get("role"),
                "status": status,
                "degraded": res.get("degraded"),
                "elapsed": res.get("elapsed"),
                "completed_at": res.get("completed_at"),
                "inbox_path": str(inbox_final),
                "result_text": out_text,
                "result_truncated": truncated,
                "verification": verification,
                "cost": cost,
                "error_code": res.get("error_code") or classify_error_code(
                    status, str(res.get("error") or "")),
                "error": res.get("error"),
            },
            ensure_ascii=False, indent=2,
        ))
        return 0 if status == "completed" else 1

    # ── 前台同步 ──
    caller = getattr(args, "_caller", None) or Caller()  # P2-9：go 链透传复用
    fg_dry_run = bool(args.no_relay) or bool(args.dry_run)
    try:
        res = _run_by_mode(caller, decision, args, timeout, dry_run=fg_dry_run,
                           acceptance=acceptance)
    except ModeConflictError as e:
        print(json.dumps(
            {"status": "mode_conflict", "error": str(e)},
            ensure_ascii=False, indent=2,
        ), file=_sys.stderr)
        return 2
    except GatekeeperBlockedError as e:
        # BLOCKED 拒绝：审计已在 dispatch 内写过，此处只优雅回执，不抛 traceback。
        print(json.dumps(
            {"status": "blocked", "blocked": True, "error": str(e),
             "request_preview": (args.request or "")[:200]},
            ensure_ascii=False, indent=2,
        ))
        return 2
    print(json.dumps(
        {
            "mode": res.get("mode"),
            "task_id": res.get("task_id"),
            "room_id": res.get("room_id"),
            "session_id": res.get("session_id"),
            "stand_name": res.get("stand_name"),
            "template_id": res.get("template_id"),
            "role": res.get("role"),
            "status": res.get("status"),
            "degraded": res.get("degraded"),
            "elapsed": res.get("elapsed"),
            "completed_at": res.get("completed_at"),
            "relayed": res.get("relayed"),
            "error": res.get("error"),
            "result_preview": (res.get("result_text") or "")[:500],
        },
        ensure_ascii=False, indent=2,
    ))
    return 0 if res.get("status") == "completed" else 1


def _cmd_go(args) -> int:
    """go 单命令收口（2026-07-26 P0，弱模型强 harness）：一条命令替代 route→run 组合。

    存在的理由：Hermes（deepseek-v4-flash）每轮 terminal 调用都是一次全量上下文回放，
    且 background/--brief/--mode 全是模型手填的纪律位——命令越多、flag 越多，弱模型
    走形概率越高（2026-07-26「300s 超时+催」即 background 漏填）。go 把分诊、组包、
    派发、等待折进一个进程：模型的 SOP 缩成「跑 go，回一句收到；唤醒后照 stdout 转述」。

    跑法与 run --wait 完全一致：terminal background=true + notify_on_complete=true。
    进程退出由 gateway 事件唤醒，stdout（头行 JSON + wait 结果简报）随通知回放。
    内部全复用 _cmd_run 等待者链：state 文件、inbox 落盘、--brief 截断口径一律不变。

    刻意不做的两件事（防越权/防语义漂移）：
      - 不 cc-send 代发秒回——Hermes 醒着，当轮回复即秒回，代发必出双消息；
      - 不消化 inbox 积压——digest 是唤醒仪式的独立安全网，折进 go 会在通知丢失时
        连带丢积压简报。
    """
    request = (args.request or "").strip()

    # 0) Gatekeeper 前置快拒：blocked 秒退（不建房、不耗额度），gateway 通知立刻回注。
    gk = check_should_dispatch(request)
    if gk.get("category") == "blocked":
        log_audit("go", {
            "mode": None, "blocked": True, "category": "blocked",
            "reason": gk.get("reason", ""), "request_preview": request[:200],
        })
        print(json.dumps({
            "cmd": "go", "status": "blocked", "blocked": True,
            "error": gk.get("reason", ""), "request_preview": request[:200],
        }, ensure_ascii=False))
        return 2

    # 0b) operator 白名单快退（2026-07-26 全量修复 A1）：Hermes 把自持车道命令误喂 go
    #     （如整段 caller.py status），派出去 = 白烧一个 Stand。显式 --mode 时不拦（改判权保留）。
    if not args.mode and gk.get("category") == "operator":
        log_audit("go", {
            "mode": "operator", "blocked": False, "category": "operator",
            "request_preview": request[:200],
        })
        print(json.dumps({
            "cmd": "go", "status": "not_dispatchable", "mode": "operator",
            "reason": gk.get("reason", ""),
            "suggested_action": gk.get("suggested_action", ""),
            "error": "operator 白名单动作——Caller 自己跑，不派发。",
        }, ensure_ascii=False))
        return 2

    # 0c) 派发深度闸（2026-08-02 多向派发）：go 入口先拦——dry-run 预览也要如实反映
    #     会被拒；真派发链在 _cmd_run 还有同款闸兜底（run 直用者也覆盖）。
    depth = DISPATCH_DEPTH if getattr(args, "depth", None) is None \
        else max(0, int(args.depth))
    if depth >= MAX_DISPATCH_DEPTH and not getattr(args, "force", False):
        log_audit("go", {
            "mode": None, "blocked": True, "reason": "depth_limit",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "request_preview": request[:200],
        })
        print(json.dumps({
            "cmd": "go", "status": "depth_blocked",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "error": (f"派发深度 {depth} 已达上限 {MAX_DISPATCH_DEPTH}——亲自完成本单，"
                      f"或向委派人回报拆分建议；确有必要可 --force 强派并在回执说明。"),
        }, ensure_ascii=False), file=_sys.stderr)
        return 2

    # 1) 定模式：显式 --mode 改判优先，缺省 route 四格自动判（route 不产 fanout/operator）。
    if args.mode:
        mode, plan_only, route_reason = args.mode, bool(args.plan_only), "显式 --mode 改判"
    else:
        r = Caller.route_mode(request)
        mode, plan_only, route_reason = r["mode"], bool(r.get("plan_only")), r.get("reason", "")
    if mode == "operator":
        print(json.dumps({
            "cmd": "go", "status": "not_dispatchable", "mode": "operator",
            "error": "operator 是 Caller 自持车道——核对白名单后自己跑，不派发。",
        }, ensure_ascii=False), file=_sys.stderr)
        return 2

    summary = args.summary or " ".join(request.split())[:24]

    # 2) 相关记忆定向行：areco 投递层 auto-recall 按「相关记忆：X」引导词查记忆库
    #    （room-relay recallQuery 的 guided 分支）；正文已带引导词则尊重原文不重复拼。
    dispatched_request = request
    if args.recall and not re.search(r"(?:相关记忆|recall)\s*[:：]", request, re.I):
        dispatched_request = f"{request}\n\n相关记忆：{args.recall.strip()}"

    log_audit("go", {
        "mode": mode, "blocked": False, "plan_only": plan_only,
        "explicit_mode": bool(args.mode), "recall": bool(args.recall),
        "dry_run": bool(args.dry_run), "request_preview": request[:200],
    })
    # 头行先落 stdout（flush）：通知回放时 Hermes 一眼见到分诊结论，转述不用再猜。
    caller = Caller()
    role = "worker" if mode in ("worker", "fast", "fanout", "plan") else "thinker"
    if args.template:
        selected_template = args.template
    elif mode == "fast":
        selected_template = caller.task_map.get("fast") or caller.default_worker_id
    elif role == "thinker":
        selected_template = caller.default_thinker_id
    elif mode == "worker":
        # ⑤ 路由反转：worker 模式=重活车道，锚 default_heavy_worker（加载层已由
        # resolve_lane_anchors 应用 areco 设置页真锚，2026-07-30 高律师定案），
        # 与 run 的实际派发口径一致（default_worker 已是 hy3）。
        selected_template = caller.default_heavy_worker_id
    else:
        selected_template = caller.default_worker_id
    print(json.dumps({
        "cmd": "go", "mode": mode, "role": role, "template_id": selected_template,
        "plan_only": plan_only, "summary": summary,
        "route_reason": route_reason[:80],
        # 车道锚来源横幅（2026-07-30 定案：真锚=areco 设置页；
        # 形如 "kimi-k3@areco-config" / "qclaw-flash@areco-api" / "kimi-k3@常量fallback"）
        "lane_anchor_source": caller.lane_anchor_sources or None,
        "recall": (args.recall or "").strip() or None,
        "caller": CALLER_NAME,  # 多向派发：头行亮明派发身份
    }, ensure_ascii=False), flush=True)

    if args.dry_run:
        # 预览要与真派发同貌：委派说明段也展示（真实注入在 _cmd_run 组包处）
        preview = ensure_infra_note(dispatched_request, depth=depth)
        print(json.dumps({"cmd": "go", "status": "dry_run", "dispatched": False,
                          "caller": CALLER_NAME, "depth": depth,
                          "request_final": preview[:600]}, ensure_ascii=False))
        return 0

    # 3) 委托 run --wait 全链（等待者模式：dispatch→poll→state→inbox→brief stdout）。
    ns = SimpleNamespace(
        request=dispatched_request,
        wait=True, bg=False, brief=not args.full,
        mode=mode, plan_only=plan_only, subs=list(args.subs or []),
        role=None, plan=False, task_type=args.task_type,
        template=args.template, room_id=args.room_id,
        summary=summary, file=args.file, timeout=args.timeout,
        no_relay=False, dry_run=False, reuse_plan=bool(args.reuse_plan),
        force=bool(getattr(args, "force", False)),
        fresh=bool(getattr(args, "fresh", False)),
        _caller=caller,  # P2-9：头行已实例化的 Caller 透传 _cmd_run，免二次三级读+registry 双载
        depth=getattr(args, "depth", None),  # 深度闸在 _cmd_run 统一执行
    )
    return _cmd_run(ns)


# ── ask 直投席位 claim（同轮并发闸）─────────────────────────────────
# 场景：Hermes 一回合并行起 N 个 ask，探灯彼此看不见（消息落库到 relay 投递有 2s+
# 延迟，trafficState 还没翻 working），全部判「空闲」→ 全挤进同一个会话，
# 「忙则另开」形同虚设。O_EXCL 文件抢占让同一常驻会话同刻只有一个直投者，
# 输家自动转并行 fork。

def _ask_claim_path(session_id: str) -> Path:
    return ASK_CLAIMS_DIR / f"{session_id}.claim"


def acquire_ask_claim(session_id: str, task_id: str, request: str = "") -> bool:
    """抢常驻会话的直投席位。持有者等待者进程已死 → 夺锁重试一次（防死锁烂尾：
    等待者被 kill -9 后席位永远占着，之后所有 ask 全被挤去 fork）。"""
    if not session_id:
        return False
    path = _ask_claim_path(session_id)
    payload = json.dumps({"pid": os.getpid(), "task_id": task_id, "at": _now_iso(),
                          "start_ts": _PROC_START_TS,
                          "req": " ".join((request or "").split())[:40]})
    for _ in range(2):
        try:
            ASK_CLAIMS_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, payload.encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                holder = json.loads(path.read_text())
            except Exception:
                holder = {}
            # 席位持有者的 cmdline 不含 task_id（ask 链 argv 是请求原文）——只凭
            # start_ts 对 lstart（pid 复用判别）+ 请求片段/caller.py 回落判活。
            if _waiter_alive(holder.get("pid"), start_ts=holder.get("start_ts"),
                             request=holder.get("req", "")):
                return False  # 真有人占着：转 fork
            try:
                path.unlink(missing_ok=True)  # 陈锁（持有者已死）：夺
            except OSError:
                return False
        except OSError:
            return False
    return False


def release_ask_claim(session_id: str, task_id: str) -> None:
    """只释放自己那份席位（task_id 比对），别把并发新持有者的锁放掉。"""
    if not session_id:
        return
    path = _ask_claim_path(session_id)
    try:
        holder = json.loads(path.read_text())
        if holder.get("task_id") == task_id:
            path.unlink(missing_ok=True)
    except Exception:
        pass


def _cmd_ask(args) -> int:
    """ask 单命令：点名常驻 agent（默认 Fable5）——先观察运行状态再投。

    2026-07-26 高律师需求原文：「总是派到同一个 fable5，可以加一个去观察运行状态，
    如果在运行就新建一个并行的任务」。路由：
        空闲 → 直投常驻会话（沿用其累积上下文，一房一线，回复照常落常驻房）；
        忙（working/needs-user）/ 不可用（会话被删、房归档、error）/ 直投席位被
        同轮并发 ask 抢走 → dispatch 新房并行跑（模板 = 常驻会话的 templateId）。
    两条路都走等待者链（state+面包屑+poll 红绿灯+inbox+brief），跑法与 go 完全一致：
    terminal background=true + notify_on_complete=true，进程退出由 gateway 唤醒。

    与既有 SOP 的边界：本命令只接**新任务**；对进行中任务的跟进/续跑/催促仍走
    areco-msg 快道（fork 出去的会话不带原上下文，跟进投过去等于对牛弹琴）。
    """
    request = (args.request or "").strip()

    # 0) Gatekeeper 快拒（与 go 同口径）：blocked 秒退，不投递不建房。
    #    刻意不做 operator 快退——ask 是点名通道，「让 Fable5 跑 X」里的 X 即使长得像
    #    Caller 白名单命令，也是要 Fable5 执行的任务，不是 Hermes 自持车道动作。
    gk = check_should_dispatch(request)
    if gk.get("category") == "blocked":
        log_audit("ask", {
            "mode": "worker", "blocked": True, "category": "blocked",
            "reason": gk.get("reason", ""), "request_preview": request[:200],
        })
        print(json.dumps({
            "cmd": "ask", "status": "blocked", "blocked": True,
            "error": gk.get("reason", ""), "request_preview": request[:200],
        }, ensure_ascii=False))
        return 2

    if args.fork and args.direct:
        print(json.dumps({
            "cmd": "ask", "status": "mode_conflict",
            "error": "--fork 与 --direct 互斥（一个要另开、一个要排队）",
        }, ensure_ascii=False), file=_sys.stderr)
        return 2

    # 0b) 派发深度闸（2026-08-02 多向派发）：ask 不走 _cmd_run，单独设闸。
    #     点名通道无 --force 越权门——深度超限说明转派链已过长，回报拆分建议即可。
    depth = DISPATCH_DEPTH if getattr(args, "depth", None) is None \
        else max(0, int(args.depth))
    if depth >= MAX_DISPATCH_DEPTH:
        log_audit("ask", {
            "mode": "worker", "blocked": True, "reason": "depth_limit",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "request_preview": request[:200],
        })
        print(json.dumps({
            "cmd": "ask", "status": "depth_blocked",
            "depth": depth, "max_depth": MAX_DISPATCH_DEPTH,
            "error": f"派发深度 {depth} 已达上限 {MAX_DISPATCH_DEPTH}——亲自完成或回报拆分建议。",
        }, ensure_ascii=False, indent=2), file=_sys.stderr)
        return 2

    caller = Caller()
    channel = caller.resolve_ask_channel(room_id=args.room_id, member=args.member)

    # 1) 定路由：显式旗标 > 探灯。--direct 在通道不可用时仍回落 fork（投不出去的
    #    「排队」没有意义）。
    if args.fork:
        route, probe_reason = "fork", "显式 --fork"
    elif args.direct:
        route, probe_reason = (
            ("direct", "显式 --direct（忙也排队直投）") if channel.get("ok")
            else ("fork", f"--direct 但通道不可用：{channel.get('reason', '')}")
        )
    else:
        route, probe_reason = caller.ask_channel_probe(channel)

    task_id = f"wait-{int(time.time())}-{uuid.uuid4().hex[:6]}"

    # 组包（2026-08-02 上移到 claim 之前——原位置在 acquire_ask_claim 引用
    # dispatched_request 之后，direct 路由一走就 NameError；顺带补委派说明注入）
    summary = args.summary or " ".join(request.split())[:24]
    dispatched_request = request
    if args.recall and not re.search(r"(?:相关记忆|recall)\s*[:：]", request, re.I):
        dispatched_request = f"{request}\n\n相关记忆：{args.recall.strip()}"
    dispatched_request = ensure_infra_note(dispatched_request, depth=depth)

    # 2) 直投席位：探灯说空闲还要抢到 claim 才算数（同轮并发闸，见 acquire_ask_claim）。
    claim_held = False
    if route == "direct":
        claim_held = acquire_ask_claim(channel.get("session_id", ""), task_id,
                                       request=dispatched_request)
        if not claim_held and not args.direct:
            route, probe_reason = "fork", "直投席位被并发 ask 占用，另开并行任务"

    log_audit("ask", {
        "mode": "worker", "blocked": False, "route": route,
        "route_reason": probe_reason, "member": channel.get("member", ""),
        "room_id": channel.get("room_id", ""), "dry_run": bool(args.dry_run),
        "recall": bool(args.recall), "request_preview": request[:200],
    })
    # 头行先落 stdout（flush）：通知回放时 Hermes 一眼看到走了哪条路、为什么，
    # 转述「已另开并行 Fable5」还是「Fable5 空闲直投」不用猜。
    print(json.dumps({
        "cmd": "ask", "route": route, "member": channel.get("member", ""),
        "room_id": channel.get("room_id"), "reason": probe_reason[:100],
        "summary": summary, "recall": (args.recall or "").strip() or None,
    }, ensure_ascii=False), flush=True)

    if args.dry_run:
        if claim_held:
            release_ask_claim(channel.get("session_id", ""), task_id)
        print(json.dumps({"cmd": "ask", "status": "dry_run", "dispatched": False,
                          "route": route,
                          "request_final": dispatched_request[:300]},
                         ensure_ascii=False))
        return 0

    timeout = args.timeout if args.timeout is not None else 0
    if MIN_TIMEOUT_SEC > 0 and 0 < timeout < MIN_TIMEOUT_SEC:
        logger.warning("ask 显式 --timeout %ds 低于下限，钳到 %ds", timeout, int(MIN_TIMEOUT_SEC))
        timeout = int(MIN_TIMEOUT_SEC)
    spec = {
        "request": dispatched_request, "task_type": "general",
        "role": "worker", "template": channel.get("template_id"),
        "room_id": channel.get("room_id") if route == "direct" else None,
        "summary": summary, "file": args.file, "timeout": timeout,
        "mode": "worker", "ask_route": route,
    }
    state = {
        "task_id": task_id, "mode": "wait", "work_mode": "ask",
        "ask_route": route, "spec": spec, "status": "running",
        "created_at": _now_iso(), "pid": os.getpid(),
        "start_ts": _PROC_START_TS,  # 同 run --wait：供 _waiter_alive 判 pid 复用
        "channel": _current_channel(),
    }
    _write_state(task_id, state)

    # 派发面包屑（与 run --wait 同构）：dispatch/直投一返回就落 state，
    # 等待者此后死掉 reconcile 都能凭它去房间补收。
    _bc_lock = threading.Lock()

    def _breadcrumb(d: dict) -> None:
        with _bc_lock:
            state.setdefault("dispatches", []).append({
                "task_id": d.get("task_id"),
                "room_id": d.get("room_id"),
                "session_id": d.get("session_id"),
                "stand_name": d.get("stand_name"),
                "stand_session_id": d.get("stand_session_id"),
                "message_id": d.get("message_id"),
                "at": _now_iso(),
            })
            _write_state(task_id, state)

    caller._on_dispatch = _breadcrumb
    try:
        if route == "direct":
            channel_was_exited = (channel.get("session") or {}).get("status") == "exited"
            d = caller.dispatch_to_channel(
                dispatched_request, channel, request_summary=summary
            )
            if channel_was_exited:
                # exited 会话靠 room-relay 投递时自动 restart resume；先等它回到
                # running 再开轮询，否则 poll 的 lost 判定会在重启窗口内误判失联
                caller.wait_channel_resumed(d.get("stand_session_id", ""))
            poll = caller.poll_result(
                room_id=d["room_id"], session_id=d["session_id"],
                stand_session_id=d.get("stand_session_id"),
                after_id=d.get("message_id", 0) or 0,
                stand_name=d.get("stand_name", ""),
                timeout=timeout, task_id=d.get("task_id", ""),
                role="worker", template=d.get("template_id", ""),
            )
            # 常驻房永不收口：room_created=False 本就不归档，连 finish_room 的
            # kept 台账也不写——台账即「StandCode 地盘」声明，高律师的房间不能进。
            res = {**d, **poll, "mode": "worker", "route": "direct"}
        else:
            fork_template = (
                args.template or channel.get("template_id") or ASK_TEMPLATE_FALLBACK
            )
            res = caller.dispatch_and_relay(
                dispatched_request, template_id=fork_template, mode="worker",
                request_summary=summary, file_path=args.file,
                poll_timeout=timeout, dry_run=True,
            )
            res["route"] = "fork"
            res.setdefault("mode", "worker")
    except GatekeeperBlockedError as e:
        state.update({"status": "blocked", "error": str(e), "completed_at": _now_iso()})
        _write_state(task_id, state)
        print(json.dumps(
            {"cmd": "ask", "task_id": task_id, "status": "blocked", "blocked": True,
             "error": str(e), "request_preview": request[:200]},
            ensure_ascii=False, indent=2,
        ))
        return 2
    except Exception as e:
        state.update({"status": "error", "error": str(e), "completed_at": _now_iso()})
        _write_state(task_id, state)
        print(json.dumps(
            {"cmd": "ask", "task_id": task_id, "status": "error", "error": str(e)},
            ensure_ascii=False, indent=2,
        ))
        return 1
    finally:
        if claim_held:
            release_ask_claim(channel.get("session_id", ""), task_id)

    # 公共收尾（2026-07-28 B4 抽并，顺带修 ask 路 verify_completion 漏传 plan
    # output_path——旧代码只传 files，plan 模式产物落点机检在 ask 路永远缺项）
    fin = _finalize_waiter(
        caller, task_id, state, res,
        spec=spec,
        files=[args.file] if args.file else [],
        request_summary=summary,
    )
    status = fin["status"]
    result_text = fin["result_text"]
    verification = fin["verification"]
    cost = fin["cost"]
    inbox_final = fin["inbox_path"]

    out_text = result_text
    truncated = False
    if not args.full and len(result_text) > 700:
        out_text = result_text[:700] + f"\n…[截断，全文 {len(result_text)} 字见 inbox]"
        truncated = True
    print(json.dumps(
        {
            "mode": "wait",
            "work_mode": "ask",
            "route": route,
            "task_id": task_id,
            "room_id": res.get("room_id"),
            "session_id": res.get("session_id"),
            "stand_name": res.get("stand_name"),
            "template_id": res.get("template_id"),
            "status": status,
            "elapsed": res.get("elapsed"),
            "completed_at": res.get("completed_at"),
            "inbox_path": str(inbox_final),
            "result_text": out_text,
            "result_truncated": truncated,
            "verification": verification,
            "cost": cost,
            "error_code": res.get("error_code") or classify_error_code(
                status, str(res.get("error") or "")),
            "error": res.get("error"),
        },
        ensure_ascii=False, indent=2,
    ))
    return 0 if status == "completed" else 1


def _reconcile_lock() -> bool:
    """reconcile 单实例锁：O_EXCL 创建；>5 分钟视为陈锁可夺。False = 另一实例在跑。"""
    lock = TASKS_DIR / ".reconcile.lock"
    try:
        TASKS_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            if time.time() - lock.stat().st_mtime > 300:
                lock.unlink(missing_ok=True)
                return _reconcile_lock()
        except OSError:
            pass
        return False


def _ps_c_escape(s: str) -> str:
    """把字符串转成 BSD ps 在 LC_ALL=C 下 command 列的 vis 转义呈现形态。

    C locale 下非 ASCII 字节被 ps 逐字节打成 M- 转义（UTF-8 中文即此形态，
    如「调」= E8 B0 83 → "M-hM-0M^C"）。_waiter_alive 拿中文 req_key 直接匹配
    cmdline 永不命中 → 活等待者被误判死、reconcile 抢跑定稿（2026-07-30 诊断 F1）。
    匹配前先把 req_key 做同款转义即可命中；纯 ASCII 输入转义后原样不变（退化为旧匹配）。
    """
    out = []
    for b in s.encode("utf-8", "replace"):
        meta = b >= 0x80
        c = b & 0x7F
        if c == 0x20:
            # vis(3) 特例：低 7 位是空格的字节一律走八进制（0xA0 → "\240"，如「你」的
            # 第三字节 E4 BD A0）；裸空格 0x20 本身可见不转义。实测踩坑修正（2026-07-30）
            out.append("\\240" if meta else " ")
        elif c < 0x20:
            out.append(("M^" if meta else "^") + chr(c + 0x40))
        elif c == 0x7F:
            out.append("M^?" if meta else "^?")
        elif meta:
            out.append("M-" + chr(c))
        else:
            out.append(chr(c))
    return "".join(out)


def _waiter_alive(pid, task_id: str = "", start_ts: float | None = None,
                  request: str = "", ps_line: str | None = None) -> bool:
    """等待者进程还活着吗（2026-07-28 B5 加固：pid 复用误判升级）。

    旧口径只看 ps 输出含 "caller.py"/"python"——pid 被任何一个常驻 python 复用即永久
    误判活，死等待者的房间结果永远漏收。新口径（state/席位带 start_ts）三连判：
      进程存在 且 ps lstart 与 start_ts 吻合（容差 2s）且 command 能认出原等待者——
      cmdline 含 task_id（_worker 后台链 argv 带 task_id）或请求片段（前台 --wait/ask
      链 argv 带请求原文）；两者都给不出时回落「含 caller.py/python 即活」的旧保守档。
    lstart 解析失败/取不到 → 视为死（新口径宁可误判死：启动时间都在手还判不了，
    说明进程已不是当初那个等待者）。旧 state 无 start_ts → 回落旧逻辑（查不动保守当活：
    误判死会双写 inbox，误判活只是晚一轮）。
    ps_line（P2-9 批量化）：调用方已用 _ps_lines_for 批量查过时传对应行（无行传 ""），
    本函数不再自己 fork ps；None = 未批量，自查。
    """
    if not pid:
        return False
    if ps_line is None:
        try:
            out = subprocess.run(
                ["ps", "-o", "pid=,lstart=,command=", "-p", str(pid)],
                capture_output=True, text=True, timeout=5,
                env={**os.environ, "LC_ALL": "C"},  # 锁 C locale，lstart 英文月份才解析得动
            )
        except Exception:
            return True  # ps 本身跑不动：保守当活（旧口径同款兜底）
        line = (out.stdout or "").strip()
    else:
        line = ps_line.strip()
    if not line:
        return False  # pid 无此进程：新旧口径都判死
    if not start_ts:
        # 旧 state 回落：含 caller.py/python 即活
        return "caller.py" in line or "python" in line.lower()
    # lstart 形如 "Tue Jul 28 10:00:00 2026"（LC_ALL=C 保证英文）
    try:
        parts = line.split(None, 6)
        lstart = datetime.strptime(
            " ".join(parts[1:6]), "%a %b %d %H:%M:%S %Y").timestamp()
        cmdline = parts[6] if len(parts) > 6 else ""
        if abs(lstart - float(start_ts)) > 2:
            return False  # pid 复用：启动时间对不上
    except Exception:
        return False  # 解析失败 → 视为死
    # cmdline 是 LC_ALL=C 下的 vis 转义形态：中文 task_id/req_key 须先做同款转义才
    # 匹配得上（2026-07-30 诊断 F1：中文请求永不命中 → 活 waiter 误判死 → 抢跑定稿）。
    # 纯 ASCII 转义后原样不变，行为与旧口径完全一致。
    if task_id and _ps_c_escape(task_id) in cmdline:
        return True
    req_key = " ".join((request or "").split())[:40]
    if req_key:
        esc = _ps_c_escape(req_key)
        if esc in cmdline:
            return True
        # 请求原文若含换行/制表（argv 里被 ps 打成 ^J/^I/\n），req_key 已把它们
        # 折成空格——把 cmdline 侧同样归一后再试一次
        norm = " ".join(cmdline.replace("^J", " ").replace("^I", " ")
                        .replace("\\n", " ").replace("\\t", " ").split())
        if esc in norm:
            return True
    if not task_id and not req_key:
        return "caller.py" in cmdline or "python" in cmdline.lower()
    return False


def _stand_msgs(msgs: list[dict], stand_name: str) -> list[dict]:
    """按 poll_result 同一口径过滤「我派的那个 Stand」的消息。"""
    out = []
    for m in msgs:
        s = m.get("from_agent", "")
        if not s or s in NON_STAND_SENDERS:
            continue
        if stand_name and s != stand_name:
            continue
        out.append(m)
    return out


def _rec_finalize(task_id: str, st: dict, replies: list[dict], *, dry_run: bool) -> None:
    """迟到回复落 inbox + state → completed_late（状态一变，下轮不再扫 = 幂等）。"""
    text = "\n\n".join(m.get("body", "") for m in replies if m.get("body")).strip()
    watermark = max((m.get("id", 0) for m in replies),
                    default=int(st.get("messages_count") or 0))
    if dry_run:
        return
    spec = st.get("spec") or {}
    write_inbox(task_id, {
        "task_id": task_id,
        "room_id": st.get("room_id"),
        "stand": st.get("stand_name") or "?",
        "role": st.get("role") or spec.get("role") or "",
        "status": "completed_late",
        "result_text": text,
        "files": [],
        "request_summary": (spec.get("summary") or "") + "（迟到补收）",
        "request": (spec.get("request") or "")[:200],
        "channel": st.get("channel") or "main",
        "error": None,
    })
    st.update({
        "status": "completed_late",
        "result_text": text,
        "result_preview": text[:500],
        "messages_count": watermark,
        "completed_at": _now_iso(),
        "reconciled_at": _now_iso(),
    })
    _write_state(task_id, st)


def _rec_archive_room(caller, st: dict, dry_run: bool, actions: list[str]) -> None:
    """补收后按「做完就删」收尾：归档任务房（→ sweeper 特许通道删除，级联停会话）。

    2026-07-27 实证：timeout/stuck 补收只落 inbox 不归档，六个 worker 会话
    completed_late 后仍 running 空转半天没人收尸。归档失败不阻塞对账主流程。

    存活探针（2026-07-27 与 finish_room 同款守卫）：补收到新回复 ≠ Stand 干完——
    灯仍 working 说明后面还有货，此时归档 = 级联 SIGTERM 杀 Stand（「看到中途结果
    误判完成而提前关闭」）。留到下轮 reconcile 再收。
    """
    room_id = st.get("room_id")
    if not room_id or dry_run:
        return
    sid = _last_stand_session(st)
    if sid:
        info = caller._session_info(sid)
        if info and info.get("status") == "running" and info.get("trafficState") == "working":
            actions.append(f"⏸ 房间 {room_id} 暂不归档（Stand 仍在干活，下轮再收）")
            return
    try:
        caller.archive_room(str(room_id))
        actions.append(f"▣ 房间 {room_id} 已归档（补收收尾）")
    except Exception as e:
        actions.append(f"⚠️ 房间 {room_id} 归档失败: {e}")


def _last_stand_session(st: dict) -> str:
    """从面包屑倒序找最近一次派发的 stand_session_id（没有则空串）。"""
    for d in reversed(st.get("dispatches") or []):
        if d.get("stand_session_id"):
            return str(d["stand_session_id"])
    return ""


def _rec_notice(task_id: str, st: dict, room_id, status: str, error: str) -> None:
    """把 lost/stuck 判定落 inbox 通知一次（Hermes 下轮 digest 转述）。"""
    spec = st.get("spec") or {}
    tag = {"stuck": "（卡在选项待人工）", "lost": "（任务丢失）"}.get(status, "")
    write_inbox(task_id, {
        "task_id": task_id,
        "room_id": room_id,
        "stand": st.get("stand_name") or "?",
        "role": st.get("role") or spec.get("role") or "",
        "status": status,
        "result_text": "",
        "files": [],
        "request_summary": (spec.get("summary") or "") + tag,
        "request": (spec.get("request") or "")[:200],
        "channel": st.get("channel") or "main",
        "error": error,
    })


def _cmd_reconcile(args) -> int:
    """对账补收（2026-07-26 方案C）：等待者死亡 / 卡死解开后的迟到结果，从房间捞回 inbox。

    扫 ~/.standcode/tasks/ 三类账：
      · status=stuck：人到看板点掉选项后 Stand 继续跑完——凭 messages_count 水位线
        增量取新回复，补写 inbox（completed_late）。
      · status=timeout 且未 late_scan_done：迟到货水位线补收（2026-07-27 加，补收≠重试）；
        无货且会话收尾 → late_scan_done 销账。
      · status=running 且等待者进程已死：凭 dispatches 面包屑定位房间——有新回复补收；
        无回复且 Stand 卡选项 → 转 stuck 落通知（下轮按上一类处理）；无回复且 Stand
        已退出 → 标 lost 落通知；Stand 还在干 → 留待下轮。
        无面包屑的存量死等待者标 dead 一次不再扫（定位不到房间，人工看板兜底）。

    幂等：只补不删，状态推进后不复扫；inbox 通知每任务至多一次（随状态迁移）。
    设计为 cron 佣工（每 10 分钟），零 LLM、零消息推送——结果只落 inbox，
    Hermes 下次被唤醒时 digest 自然带出，符合拉模式决议（2026-07-25）。
    """
    if not args.dry_run and not _reconcile_lock():
        print("另一 reconcile 实例在跑，跳过")
        return 0
    try:
        caller = Caller()
        # B6（2026-07-28）：sessions 全量列表每轮只拉一次，四个分支复用——此前每个
        # 任务各调一次 _session_info（每次全量列表线性匹配），N 倍 API 负载。
        # 拉取失败 = 空 dict：各分支维持 fail-open（查不到不判死、不拦，与
        # _session_info 返回 None 同语义）。
        try:
            sessions_by_id = {s.get("id"): s for s in caller.list_sessions()}
        except Exception:
            sessions_by_id = {}
        cutoff = time.time() - args.max_age_days * 86400
        counts = {"scanned": 0, "harvested": 0, "stuck_marked": 0,
                  "lost_marked": 0, "dead_marked": 0, "waiting": 0}
        actions: list[str] = []
        for p in sorted(TASKS_DIR.glob("*.json")):
            try:
                if p.stat().st_mtime < cutoff:
                    continue
                st = json.loads(p.read_text())
            except Exception:
                continue
            task_id = st.get("task_id") or p.stem
            status = st.get("status")

            if status in ("stuck", "stall"):
                counts["scanned"] += 1
                team = st.get("session_id")
                if not team:
                    counts["waiting"] += 1
                    continue
                try:
                    msgs = caller.get_messages(team, after_id=int(st.get("messages_count") or 0))
                except Exception as e:
                    actions.append(f"⚠️ {task_id} 读房间失败: {e}")
                    continue
                replies = _stand_msgs(msgs, st.get("stand_name") or "")
                if replies:
                    _rec_finalize(task_id, st, replies, dry_run=args.dry_run)
                    counts["harvested"] += 1
                    actions.append(f"✅ {task_id} 卡死解开，补收 {len(replies)} 条迟到回复")
                    _rec_archive_room(caller, st, args.dry_run, actions)
                else:
                    # 无新回复（全量修复 A2）：查会话态——卡死会话被人直接杀掉/归档
                    # （exited）则升级 lost 落通知，否则（还卡着/查不到）留待下轮
                    sid = _last_stand_session(st)
                    info = (sessions_by_id.get(sid) or {}) if sid else {}
                    if info.get("status") == "exited":
                        err = "卡死会话已退出且无回复——结果丢失，需人工重派"
                        if not args.dry_run:
                            st.update({"status": "lost", "error": err,
                                       "reconciled_at": _now_iso()})
                            _write_state(task_id, st)
                            _rec_notice(task_id, st, st.get("room_id"), "lost", err)
                        counts["lost_marked"] += 1
                        actions.append(f"❌ {task_id} 卡死会话已退出（转 lost，通知落 inbox）")
                    else:
                        counts["waiting"] += 1

            elif status == "completed" and st.get("settle_forced"):
                # 全量修复 A3：灯坏死被强制定稿的任务，Stand 真正干完的迟到结果落在
                # 房间水位线之后——增补进 inbox（completed_late）；确认无迟到货且会话
                # 已收尾就销账（settle_forced 置 False），不再每轮重扫。
                counts["scanned"] += 1
                team = st.get("session_id")
                if not team:
                    counts["waiting"] += 1
                    continue
                try:
                    msgs = caller.get_messages(team, after_id=int(st.get("messages_count") or 0))
                except Exception as e:
                    actions.append(f"⚠️ {task_id} 读房间失败: {e}")
                    continue
                replies = _stand_msgs(msgs, st.get("stand_name") or "")
                if replies:
                    _rec_finalize(task_id, st, replies, dry_run=args.dry_run)
                    counts["harvested"] += 1
                    actions.append(f"✅ {task_id} settle_forced 后补收 {len(replies)} 条迟到回复")
                else:
                    sid = _last_stand_session(st)
                    info = (sessions_by_id.get(sid) or {}) if sid else {}
                    if info.get("status") == "exited" or info.get("trafficState") in ("conclusion", "idle"):
                        if not args.dry_run:
                            st["settle_forced"] = False
                            st["reconciled_at"] = _now_iso()
                            _write_state(task_id, st)
                        actions.append(f"☑️ {task_id} settle_forced 销账（会话已收尾，无迟到回复）")
                    else:
                        counts["waiting"] += 1

            elif status == "timeout" and not st.get("late_scan_done"):
                # 超时是终态但不是句号（2026-07-27 25民1000 实证：两单 timeout 后
                # Worker 分别在死线前 8s / 后 2.5min 交活，结果躺房里没人收，Hermes
                # 又手工重做一遍）。凭水位线补收迟到货 → completed_late；确认无货且
                # 会话已收尾 → late_scan_done 销账不复扫。timeout 不重派的口径不变
                # ——补收 ≠ 重试。
                counts["scanned"] += 1
                team = st.get("session_id")
                if not team:
                    if not args.dry_run:
                        st["late_scan_done"] = True
                        _write_state(task_id, st)
                    continue
                try:
                    msgs = caller.get_messages(team, after_id=int(st.get("messages_count") or 0))
                except Exception as e:
                    actions.append(f"⚠️ {task_id} 读房间失败: {e}")
                    continue
                replies = _stand_msgs(msgs, st.get("stand_name") or "")
                if replies:
                    _rec_finalize(task_id, st, replies, dry_run=args.dry_run)
                    counts["harvested"] += 1
                    actions.append(f"✅ {task_id} 超时后补收 {len(replies)} 条迟到回复")
                    _rec_archive_room(caller, st, args.dry_run, actions)
                else:
                    sid = _last_stand_session(st)
                    info = (sessions_by_id.get(sid) or {}) if sid else {}
                    if info.get("status") == "exited" or info.get("trafficState") in ("conclusion", "idle"):
                        if not args.dry_run:
                            st["late_scan_done"] = True
                            st["reconciled_at"] = _now_iso()
                            _write_state(task_id, st)
                        actions.append(f"☑️ {task_id} 超时销账（会话已收尾，无迟到回复）")
                    else:
                        counts["waiting"] += 1

            elif status == "running":
                if _waiter_alive(st.get("pid"), task_id=task_id,
                                 start_ts=st.get("start_ts"),
                                 request=(st.get("spec") or {}).get("request", "")):
                    continue
                counts["scanned"] += 1
                disp = st.get("dispatches") or []
                if not disp:
                    if not args.dry_run:
                        st.update({
                            "status": "dead",
                            "error": "等待者死亡且无派发面包屑（旧版任务），定位不到房间——人工看板兜底",
                            "reconciled_at": _now_iso(),
                        })
                        _write_state(task_id, st)
                    counts["dead_marked"] += 1
                    actions.append(f"💀 {task_id} 等待者死亡（无面包屑，标 dead）")
                    continue
                last = disp[-1]
                team = last.get("session_id")
                stand = last.get("stand_name") or ""
                after = int(last.get("message_id") or 0)
                st.setdefault("room_id", last.get("room_id"))
                st.setdefault("session_id", team)
                st.setdefault("stand_name", stand)
                try:
                    msgs = caller.get_messages(team, after_id=after) if team else []
                except Exception as e:
                    actions.append(f"⚠️ {task_id} 读房间失败: {e}")
                    continue
                replies = _stand_msgs(msgs, stand)
                if replies:
                    _rec_finalize(task_id, st, replies, dry_run=args.dry_run)
                    counts["harvested"] += 1
                    actions.append(
                        f"✅ {task_id} 死等待者补收 {len(replies)} 条回复（房间 {last.get('room_id')}）")
                    continue
                info = sessions_by_id.get(last.get("stand_session_id") or "") or {}
                traffic, sess = info.get("trafficState"), info.get("status")
                if traffic == "needs-user":
                    err = (
                        f"等待者死亡且 Stand 卡在交互选项"
                        f"（尾屏：{(info.get('lastLine') or '')[:120]}）——去 areco 看板处理"
                    )
                    if not args.dry_run:
                        st.update({
                            "status": "stuck",
                            "messages_count": after,
                            "stuck_last_line": info.get("lastLine") or "",
                            "error": err,
                            "reconciled_at": _now_iso(),
                        })
                        _write_state(task_id, st)
                        _rec_notice(task_id, st, last.get("room_id"), "stuck", err)
                    counts["stuck_marked"] += 1
                    actions.append(f"🟡 {task_id} Stand 卡在选项（转 stuck，通知落 inbox）")
                elif sess == "exited":
                    err = "等待者死亡，Stand 已退出且无回复——结果丢失，需人工重派"
                    if not args.dry_run:
                        st.update({"status": "lost", "error": err, "reconciled_at": _now_iso()})
                        _write_state(task_id, st)
                        _rec_notice(task_id, st, last.get("room_id"), "lost", err)
                    counts["lost_marked"] += 1
                    actions.append(f"❌ {task_id} Stand 已退出无回复（标 lost，通知落 inbox）")
                else:
                    counts["waiting"] += 1
                    actions.append(f"⏳ {task_id} Stand 仍在跑（{traffic or '状态未知'}），下轮再看")

        # 拉模式决议（07-25）的唯一豁免（07-27 高律师问「补收怎么没叫醒」后加）：
        # 空转轮零推送不变；补收>0 才发一条唤醒触发，Hermes 醒来 digest 自然带出
        # 明细。没有这条，completed_late 结果要等下一次偶然唤醒才被看见。
        if counts["harvested"] and not args.dry_run:
            trig = send_callback_trigger(
                "reconcile",
                message=f"reconcile 补收 {counts['harvested']} 件迟到结果进 inbox，请汇总转述",
            )
            actions.append("📣 已发唤醒触发" if trig.get("ok")
                           else f"⚠️ 唤醒触发未发出: {(trig.get('error') or trig.get('stdout') or '')[:80]}")
        log_audit("reconcile", {**counts, "dry_run": bool(args.dry_run), "blocked": False})
        for line in actions:
            print(line)
        print(json.dumps({"cmd": "reconcile", **counts, "dry_run": bool(args.dry_run)},
                         ensure_ascii=False))
        return 0
    finally:
        if not args.dry_run:
            (TASKS_DIR / ".reconcile.lock").unlink(missing_ok=True)


# ── 收割巡检 harvest（方案D，2026-07-29）──────────────────────────────────
# cron 佣工（与 reconcile 同构），专收「无 caller 跟踪」的结果——把一切非 main 视野的
# 产出「拍平」进 main 通道收件箱，复用既有 inbox --digest → cc-send 送达高律师微信。
#   · Job1 通道交叉中继：扫 inbox 里 channel != main 的条目（如 secretary-01），重写成
#     main 的 harvest 条目、原条目改 .done（幂等）。secretary-01 无 weixin，这是它结果
#     送达的唯一路径——补缺不是重复。
#   · Job2 房间收割：读 tasks 面包屑排除 caller 活跟踪的房，对其余房读 messages 水位线后
#     的 assistant 消息，settle 门控（trafficLight 到 conclusion/idle/exited 或末条静默
#     ≥阈值）才捆成一条报告，写 harvest-{room}-{ts}.json，推进 {room}.hw 水位线。
# 断线恢复与 reconcile 同：HW 水位线幂等，进程死了/机器重启下轮从水位线追平，不重不漏。
# 首次见某房先锚定水位线到当前最新消息（bootstrap），只收此后新消息——不倒历史旧账。
HARVEST_DIR = Path(HOME_DIR) / ".standcode" / "harvest"
HARVEST_CONFIG = Path(HOME_DIR) / ".standcode" / "harvest.json"
# settle 静默门阈值：末条 assistant 消息静默多久算「这一轮说完了」（与 reconcile 60s 同口径）
HARVEST_SILENCE_SEC = _conf_float("STANDCODE_HARVEST_SILENCE_SEC", "harvest_silence_sec", 60)


def _harvest_lock() -> bool:
    """harvest 单实例锁：O_EXCL 创建；>5 分钟视为陈锁可夺（与 _reconcile_lock 同款）。"""
    lock = TASKS_DIR / ".harvest.lock"
    try:
        TASKS_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            if time.time() - lock.stat().st_mtime > 300:
                lock.unlink(missing_ok=True)
                return _harvest_lock()
        except OSError:
            pass
        return False


def _load_harvest_config() -> dict:
    """读 ~/.standcode/harvest.json；缺字段回退默认，坏文件回退全默认（不阻塞巡检）。"""
    default = {
        "include_rooms": [],               # 显式纳入收割的房（如 secretary-01 的 36a9180a）
        "denylist": [],                    # 噪音房（如常驻问答通道），永不收割
        "quiet_hours": ["23:00", "07:00"],  # 免打扰时段（本地时区 [起, 止)），不写 inbox
        "per_room_min_interval": 10,       # 同房最低报告间隔分钟（限频防轰炸）
        "wake_trigger": False,             # 收割>0 是否发唤醒触发（默认关=纯拉模式，对齐设计 3.1）
    }
    if not HARVEST_CONFIG.exists():
        return default
    try:
        d = json.loads(HARVEST_CONFIG.read_text(encoding="utf-8"))
        if not isinstance(d, dict):
            return default
    except Exception as e:
        logger.warning("harvest.json 读取失败，用默认配置: %s", e)
        return default
    for k, v in default.items():
        d.setdefault(k, v)
    return d


def _in_quiet_hours(qh) -> bool:
    """是否处于免打扰时段。qh=[起, 止] 本地 HH:MM；跨午夜（如 23:00-07:00）按环绕算。"""
    if not qh or not isinstance(qh, (list, tuple)) or len(qh) < 2:
        return False

    def _hm(s):
        try:
            h, m = str(s).split(":")[:2]
            return int(h) * 60 + int(m)
        except Exception:
            return None

    s, e = _hm(qh[0]), _hm(qh[1])
    if s is None or e is None or s == e:
        return False
    now = datetime.now()
    cur = now.hour * 60 + now.minute
    return (cur >= s or cur < e) if s > e else (s <= cur < e)


def _harvest_hw_path(room_id: str) -> Path:
    return HARVEST_DIR / f"{room_id}.hw"


def _read_harvest_hw(room_id: str) -> dict:
    p = _harvest_hw_path(room_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_harvest_hw(room_id: str, hw: dict) -> None:
    p = _harvest_hw_path(room_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(hw, ensure_ascii=False, indent=2), encoding="utf-8")


def _harvest_assistant_msgs(msgs: list[dict]) -> list[dict]:
    """筛 assistant 消息：from_agent 非 caller/human/system 且非人类转述（human_relay=0）。

    口径对齐 _stand_msgs 的 NON_STAND_SENDERS 排除，但不限定单一 stand 名——收割要收
    房内所有 agent 产出（含 stand 之间协作）；人类转述（Hermes 代发的人类原话，
    human_relay=1）不算 agent 结果。
    """
    out = []
    for m in msgs:
        s = m.get("from_agent", "")
        if not s or s in NON_STAND_SENDERS:
            continue
        if m.get("human_relay"):
            continue
        out.append(m)
    return out


def _room_settled(room: dict, sessions_by_id: dict,
                  last_asst_ts: float | None) -> tuple[bool, str]:
    """settle 门控（防轰炸核心，保守）：仅当房内无会话仍在 working/needs-user
    （即 trafficLight 收尾），或末条 assistant 消息静默 ≥阈值，才判可收割。

    会话态查不到不冒进（seen=0 不判 traffic_settled）——回落静默门，避免在 Stand
    还在干活时把半截对话当结果捆走。"""
    members = [m for m in room.get("members", [])
               if m.get("kind") == "session" and m.get("sessionId")]
    if members:
        seen, active = 0, False
        for m in members:
            info = sessions_by_id.get(m["sessionId"]) or {}
            if not info:
                continue
            seen += 1
            if info.get("trafficState") in ("working", "needs-user"):
                active = True
                break
        if seen and not active:
            return True, "traffic_settled"
    if last_asst_ts is not None and (time.time() - last_asst_ts) >= HARVEST_SILENCE_SEC:
        return True, "silent"
    return False, ""


def _cmd_harvest(args) -> int:
    """收割巡检 harvest（方案D v1，cron 佣工每 10 分钟）。

    把无 caller 跟踪的结果「拍平」进 main 通道收件箱：Job1 通道交叉中继 +
    Job2 房间收割，串行。零 LLM、结果只落 inbox，靠既有 inbox --digest → cc-send
    送达（拉模式，gateway 宕了也不丢）。幂等：水位线 + .done，只补不删。
    """
    cfg = _load_harvest_config()
    if _in_quiet_hours(cfg.get("quiet_hours")):
        print("（免打扰时段，跳过本轮 harvest）")
        log_audit("harvest", {"dry_run": bool(args.dry_run), "blocked": True,
                              "reason": "quiet_hours"})
        return 0
    if not args.dry_run and not _harvest_lock():
        print("另一 harvest 实例在跑，跳过")
        return 0
    try:
        caller = Caller()
        counts = {"job1_relayed": 0, "job2_harvested": 0, "rooms_scanned": 0,
                  "waiting": 0, "skipped": 0}
        actions: list[str] = []
        mine = "main"
        include_rooms = set(cfg.get("include_rooms") or [])
        denylist = set(cfg.get("denylist") or [])
        interval_sec = float(cfg.get("per_room_min_interval") or 0) * 60

        # ── Job1 通道交叉中继：扫 inbox 非本通道条目 → 重写成 main harvest ──
        INBOX_DIR.mkdir(parents=True, exist_ok=True)
        for p in sorted(INBOX_DIR.iterdir()):
            if p.suffix != ".json":
                continue
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            ch = d.get("channel") or "main"
            if ch == mine:
                continue  # 已是 main，留给 digest
            orig_task = d.get("task_id") or p.stem
            new_task = f"harvest-{ch}-{orig_task}"
            if _inbox_path(new_task).exists():
                # 已中继过（幂等）：只把原条目改 .done 防重扫，不重写、不改原 .json 内容
                if not args.dry_run:
                    p.rename(p.with_name(p.name + DONE_SUFFIX))
                counts["job1_relayed"] += 1
                actions.append(f"🔁 {orig_task}（via {ch}）已中继过，原条目标 .done")
                continue
            summary = (d.get("request_summary") or d.get("request") or "").strip()
            if not args.dry_run:
                write_inbox(new_task, {
                    "task_id": new_task,
                    "channel": mine,
                    "source": "harvest",
                    "via": ch,                       # 来源标注
                    "status": d.get("status") or "completed",
                    "result_text": d.get("result_text") or "",
                    "request_summary": f"[{ch} 转达] {summary}"[:200],
                    "stand": d.get("stand") or "",
                    "role": d.get("role") or "",
                    "room_id": d.get("room_id"),
                    "files": d.get("files") or [],
                    "error": d.get("error"),
                })
                p.rename(p.with_name(p.name + DONE_SUFFIX))
            counts["job1_relayed"] += 1
            actions.append(f"🔁 {orig_task}（via {ch}）中继进 main inbox → {new_task}")

        # ── Job2 房间收割：排除 caller 活跟踪的房，其余 settle 后捆报 ──
        # 排除集 = status=='running' 任务的 dispatches[].room_id（只排活跟踪；死等待者
        # 由 reconcile 接手，harvest 兜底，互补不冲突）。
        tracked: set[str] = set()
        for tp in TASKS_DIR.glob("*.json"):
            try:
                st = json.loads(tp.read_text(encoding="utf-8"))
            except Exception:
                continue
            if st.get("status") != "running":
                continue
            for d in st.get("dispatches") or []:
                if d.get("room_id"):
                    tracked.add(str(d["room_id"]))
        try:
            sessions_by_id = {s.get("id"): s for s in caller.list_sessions()}
        except Exception:
            sessions_by_id = {}
        rooms = caller.list_rooms()  # 默认不含已归档（归档房不可投递，无新结果）
        now = time.time()
        for room in rooms:
            rid = str(room.get("id") or "")
            if not rid or rid in tracked or rid in denylist:
                continue
            team = room.get("team")
            if not team:
                continue
            sess_members = [m for m in room.get("members", [])
                            if m.get("kind") == "session" and m.get("sessionId")]
            if not sess_members and rid not in include_rooms:
                continue  # 无 agent 会话又未显式纳入，无结果可收
            hw = _read_harvest_hw(rid)
            after_id = int(hw.get("message_id") or 0)
            try:
                msgs = caller.get_messages(team, after_id=after_id)
            except Exception as e:
                actions.append(f"⚠️ 房间 {rid} 读消息失败: {e}")
                continue
            counts["rooms_scanned"] += 1

            if after_id == 0:
                # 首次见该房（无水位线）：锚定到当前最新消息，只收此后新消息——
                # 不把历史旧账当结果倒灌进 inbox（首部署不轰炸）。
                max_id = max((int(m.get("id") or 0) for m in msgs), default=0)
                if max_id and not args.dry_run:
                    _write_harvest_hw(rid, {
                        "message_id": max_id,
                        "created_at": (msgs[-1].get("created_at") if msgs else "") or "",
                        "last_harvest_ts": now, "bootstrap": True,
                    })
                actions.append(f"📍 房间 {rid}（{(room.get('name') or '')[:24]}）"
                               f"首次锚定水位线 {max_id}（不倒历史旧账）")
                continue

            asst = _harvest_assistant_msgs(msgs)
            if not asst:
                continue
            # 额度/限流扫描（2026-07-29 机制）：收割前对每条 Stand 回复过信号词，
            # 命中即停新单+车道改道+微信告警（幂等）。from_agent 是显示名（如
            # 「Glm5.2」），尽量反查模板 id——停新单/备胎表都按模板 id 记。
            for m in asst:
                hit = quota_signal_hit(m.get("body") or "")
                if not hit:
                    continue
                sender = m.get("from_agent") or ""
                tid = next(
                    (t for t in caller.template_names
                     if t == sender or t in sender.lower()
                     or sender.lower().replace(".", "").replace("-", "")
                        in t.replace("-", "")),
                    sender or "unknown",
                )
                handle_quota_hit(
                    tid, hit, source=f"harvest:{rid}",
                    sample=(m.get("body") or "")[:120],
                    dry_run=bool(args.dry_run),
                )
            # 限频：同房报告间隔内跳过（水位线未推进，消息留待下轮不丢）
            last_harv = hw.get("last_harvest_ts")
            if (last_harv and interval_sec > 0
                    and (now - float(last_harv)) < interval_sec):
                counts["skipped"] += 1
                continue
            last = asst[-1]
            settled, reason = _room_settled(room, sessions_by_id,
                                            _parse_iso_ts(last.get("created_at")))
            if not settled:
                counts["waiting"] += 1
                actions.append(f"⏳ 房间 {rid}（{(room.get('name') or '')[:24]}）未 settle，下轮再看")
                continue
            # 收割：把这一轮 assistant 消息捆成一条报告写 main inbox
            new_task = f"harvest-{rid}-{int(now)}"
            stands = sorted({m.get("from_agent", "") for m in asst if m.get("from_agent")})
            bodies = [m.get("body", "").strip() for m in asst if m.get("body", "").strip()]
            text = "\n\n---\n\n".join(bodies)
            if len(text) > 3000:
                text = text[:3000] + f"\n\n…（共 {len(bodies)} 条，已截断）"
            if not args.dry_run:
                write_inbox(new_task, {
                    "task_id": new_task,
                    "channel": mine,
                    "source": "harvest",
                    "via": f"room:{rid}",
                    "status": "completed",
                    "result_text": text,
                    "request_summary": f"[房间收割] {(room.get('name') or rid)[:40]}：{len(asst)} 条新回复",
                    "stand": "、".join(stands),
                    "room_id": rid,
                    "room_name": room.get("name") or "",
                    "files": [],
                    "harvested_msg_ids": [m.get("id") for m in asst],
                    "error": None,
                })
                _write_harvest_hw(rid, {
                    "message_id": max(int(m.get("id") or 0) for m in asst),
                    "created_at": last.get("created_at") or "",
                    "last_harvest_ts": now,
                    "via_task": new_task,
                })
            counts["job2_harvested"] += 1
            actions.append(f"✅ 房间 {rid}（{(room.get('name') or '')[:24]}）"
                           f"收割 {len(asst)} 条回复 → {new_task}（{reason}）")

        harvested_total = counts["job1_relayed"] + counts["job2_harvested"]
        # 唤醒触发默认关（纯拉模式，对齐设计 3.1）；wake_trigger=true 时与 reconcile 同款——
        # 补收>0 发一条触发，Hermes 醒来 digest 自然带出明细（否则要等下一次偶然唤醒）。
        if cfg.get("wake_trigger") and harvested_total and not args.dry_run:
            trig = send_callback_trigger(
                "harvest",
                message=(f"harvest 收割 {harvested_total} 件结果进 inbox"
                         f"（relay {counts['job1_relayed']}/room {counts['job2_harvested']}），请汇总转述"),
            )
            actions.append("📣 已发唤醒触发" if trig.get("ok")
                           else f"⚠️ 唤醒触发未发出: {(trig.get('error') or trig.get('stdout') or '')[:80]}")
        log_audit("harvest", {**counts, "dry_run": bool(args.dry_run), "blocked": False})
        for line in actions:
            print(line)
        print(json.dumps({"cmd": "harvest", **counts, "dry_run": bool(args.dry_run)},
                         ensure_ascii=False))
        return 0
    finally:
        if not args.dry_run:
            (TASKS_DIR / ".harvest.lock").unlink(missing_ok=True)


def _cmd_report(args) -> int:
    """复盘报表（2026-07-26，08-05 试运行复盘口径）：聚合审计日志出派发质量统计。

    输出为微信/房间可直接粘贴的紧凑几行；--json 供机器读。数据全部来自
    ~/.standcode/audit.jsonl（dispatch/poll_*/go/reconcile/plan_degraded 事件），
    与决议复盘四指标对齐：成功率、返工线索（stuck/lost/settle_forced/降级）、耗时。
    """
    cutoff = time.time() - args.days * 86400
    ev: dict[str, int] = {}
    modes: dict[str, int] = {}
    reused = settle_forced = go_blocked = go_operator = go_real = stubbed = 0
    standby_hits = prewarm_n = 0
    elapsed_sum, elapsed_n = 0.0, 0
    rec = {"harvested": 0, "stuck_marked": 0, "lost_marked": 0, "dead_marked": 0, "runs": 0}
    try:
        lines = Path(AUDIT_LOG_PATH).read_text(encoding="utf-8").splitlines()
    except OSError:
        print("无审计日志")
        return 0
    for line in lines:
        try:
            r = json.loads(line)
        except Exception:
            continue
        try:
            t = datetime.strptime(r.get("timestamp") or "", "%Y-%m-%dT%H:%M:%SZ") \
                .replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            continue
        if t < cutoff:
            continue
        if _audit_is_stub(r):
            stubbed += 1
            continue
        e = r.get("event") or "?"
        ev[e] = ev.get(e, 0) + 1
        if e == "standby_claim":
            standby_hits += 1
        elif e == "prewarm_worker":
            prewarm_n += 1
        if e == "dispatch":
            m = r.get("mode") or "?"
            modes[m] = modes.get(m, 0) + 1
            if r.get("room_reused"):
                reused += 1
        elif e == "poll_completed":
            if r.get("settle_forced"):
                settle_forced += 1
            if isinstance(r.get("elapsed"), (int, float)):
                elapsed_sum += r["elapsed"]
                elapsed_n += 1
        elif e == "go":
            if r.get("blocked"):
                go_blocked += 1
            elif r.get("mode") == "operator":
                go_operator += 1
            elif not r.get("dry_run"):
                go_real += 1
        elif e == "reconcile":
            rec["runs"] += 1
            for k in ("harvested", "stuck_marked", "lost_marked", "dead_marked"):
                rec[k] += int(r.get(k) or 0)
    out = {
        "window_days": args.days,
        "dispatch_total": sum(modes.values()),
        "by_mode": modes,
        "room_reused": reused,
        "completed": ev.get("poll_completed", 0),
        "avg_elapsed_sec": round(elapsed_sum / elapsed_n, 1) if elapsed_n else None,
        "settle_forced": settle_forced,
        "stuck": ev.get("poll_stuck", 0),
        "lost": ev.get("poll_lost", 0),
        "timeout": ev.get("poll_timeout", 0),
        "plan_degraded": ev.get("plan_degraded", 0),
        "go": {"real": go_real, "blocked": go_blocked, "operator_rejected": go_operator},
        "reconcile": rec,
        "standby_hits": standby_hits,
        "prewarm_worker": prewarm_n,
        "stub_excluded": stubbed,
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
        return 0
    md = " / ".join(f"{k} {v}" for k, v in sorted(modes.items())) or "无"
    avg = f"，均耗时 {out['avg_elapsed_sec']}s" if out["avg_elapsed_sec"] is not None else ""
    print(f"📊 StandCode 派发报表（近 {args.days:g} 天）")
    print(f"派发 {out['dispatch_total']} 单：{md}（复用房 {reused}）")
    print(f"完成 {out['completed']}{avg}（强制定稿 {settle_forced}）｜"
          f"卡死 {out['stuck']}｜失联 {out['lost']}｜超时 {out['timeout']}｜计划降级 {out['plan_degraded']}")
    print(f"go 入口：真派 {go_real}｜红线拦截 {go_blocked}｜operator 拦回 {go_operator}")
    print(f"对账（{rec['runs']} 轮）：补收 {rec['harvested']}｜转stuck {rec['stuck_marked']}｜"
          f"标lost {rec['lost_marked']}｜标dead {rec['dead_marked']}")
    if standby_hits or prewarm_n:
        print(f"提速：暖池命中 {standby_hits}｜plan 预热 {prewarm_n}")
    if stubbed:
        print(f"（已剔除测试桩事件 {stubbed} 条——报表只算真实流量）")
    return 0


def _cmd_inbox(args) -> int:
    """收信箱运维：列出待取 / 清理已汇报 / 解死锁。

    补的是一个空白：inbox 是拉模式的落点（SKILL.md「每次被微信唤醒、办正事前 ls 一下」），
    但此前唯一的程序入口是隐藏的 `_process_inbox` argv 分支，--help 里没有；
    `.done` 的重命名约定只写在 SKILL.md 里、代码一无所知，于是 data/inbox/ 只增不减；
    卡死的 .processing 锁更是没有任何办法清。
    """
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    pending, done, locks = [], [], []
    for p in sorted(INBOX_DIR.iterdir()):
        if p.name.endswith(PROCESSING_SUFFIX):
            locks.append(p)
        elif p.name.endswith(DONE_SUFFIX):
            done.append(p)
        elif p.suffix == ".json":
            pending.append(p)

    # ── --digest：一条命令消化全部待取（2026-07-26 token 纪律）──
    # 此前 SKILL 的拉模式仪式是 ls → 逐个 cat → 逐个 mv .done，一次唤醒烧 3N+1 个
    # tool call、每个都携带全量上下文回放（今天实测 inbox 类调用 34 次）。digest 把
    # 整套仪式折成一条命令：每任务一段微信可直接转述的紧凑简报，读完即标 .done
    # （--keep 可只读不标）。输出刻意精简——它同样进 Hermes 历史被反复回放。
    if getattr(args, "digest", False):
        if not pending:
            print("收信箱空")
            return 0
        # 通道隔离（2026-07-26 双通道上线）：收信箱是两条微信通道共用的目录，
        # 不过滤的话 A 通道派的任务会被 B 通道的 digest 抢先标 .done 并汇报到
        # 错误的聊天窗口。默认只消化本通道（channel 字段缺省按 main 算——
        # 存量文件都来自主通道），--all-channels 才全收。
        mine = _current_channel()
        skipped_other = 0
        for p in pending:
            try:
                d = json.loads(p.read_text())
            except Exception as e:
                print(f"── {p.stem}（读取失败: {e}）")
                continue
            if not getattr(args, "all_channels", False) and (d.get("channel") or "main") != mine:
                skipped_other += 1
                continue  # 不显示也不标 .done，留给所属通道消化
            status = d.get("status", "?")
            concl = (d.get("request_summary") or "").strip()
            body = (d.get("result_text") or "").strip()
            if not concl:
                concl = next(
                    (l.strip() for l in body.splitlines() if l.strip()), "（无结论）"
                )
            print(f"── {p.stem} [{status}]")
            # 证据分级（agentacct 借鉴，与 summarize_inbox 同口径）
            ver = d.get("verification") or {}
            if status == "completed" and ver.get("level") == "verified":
                print(f"✅ {concl[:120]}（已验证{'·打回补齐' if ver.get('bounced') else ''}）")
            elif status == "completed" and ver.get("level") == "check_failed":
                failed = [c["check"] for c in ver.get("checks", []) if not c.get("passed")]
                tag = "已打回仍未过·升级人工" if ver.get("escalated") else "判据未过"
                print(f"❌ {concl[:120]}（{tag}:{'、'.join(failed[:2]) or '机检失败'}）")
            elif status == "completed" and ver.get("level") == "agent_reported":
                note = "无判据未验" if "无验收栏" in str(ver.get("note") or "") else "自述"
                print(f"⚠️ {concl[:120]}（{note}）")
            else:
                print(f"✅ {concl[:120]}")
            pts = []
            for line in body.splitlines():
                s = line.strip()
                if not s or s == concl or s.startswith(("```", "#", "---", "===")):
                    continue
                pts.append(s[:100])
                if len(pts) >= 3:
                    break
            for i, s in enumerate(pts, 1):
                print(f"{i}. {s}")
            files = d.get("files") or []
            if isinstance(files, str):
                files = [files]
            if files:
                print(f"📄 {files[0] if len(files) == 1 else '; '.join(files[:3])}")
            cost = d.get("cost") or {}
            if cost.get("source") == "client_reported":
                total = int(cost.get("input_tokens", 0)) + int(cost.get("output_tokens", 0))
                print(f"💰 ~{total/1000:.1f}k tok（client_reported）")
            if d.get("error"):
                print(f"⚠️ {str(d.get('error'))[:120]}")
            print(f"   （房间 {d.get('room_id') or '-'} · 全文 {p.name}）")
            if not getattr(args, "keep", False):
                try:
                    p.rename(p.with_name(p.name + DONE_SUFFIX))
                except OSError as e:
                    print(f"   ⚠️ 标记 .done 失败: {e}")
        print(
            f"共 {len(pending) - skipped_other} 条"
            + ("（--keep 未标记，下次仍会出现）" if getattr(args, "keep", False) else "（已标 .done）")
            + (f"；另通道 {skipped_other} 条未动（--all-channels 可看）" if skipped_other else "")
        )
        if len(pending) == skipped_other:
            print("（本通道收信箱空）")
        return 0

    if args.gc or args.unlock:
        removed = 0
        if args.gc:
            cutoff = time.time() - args.older_than * 86400
            for p in done:
                if p.stat().st_mtime < cutoff:
                    if args.yes:
                        p.unlink(missing_ok=True)
                    removed += 1
            print(f"{'已清理' if args.yes else '可清理'} {removed} 个 {DONE_SUFFIX} "
                  f"（超过 {args.older_than} 天）" + ("" if args.yes else "；加 --yes 真删"))
        if args.unlock:
            stale = 0
            for p in locks:
                age = time.time() - p.stat().st_mtime
                if args.force or age > LOCK_STALE_SEC:
                    if args.yes:
                        p.unlink(missing_ok=True)
                    stale += 1
                    print(f"  {'解锁' if args.yes else '可解锁'} {p.name}（已 {age/60:.0f} 分钟）")
            print(f"{'已解' if args.yes else '可解'} {stale} 个锁"
                  + ("" if args.yes else "；加 --yes 真解"))
        return 0

    if args.json:
        print(json.dumps({
            "inbox_dir": str(INBOX_DIR),
            "pending": [p.stem for p in pending],
            "done": len(done),
            "locked": [p.name.replace(PROCESSING_SUFFIX, "") for p in locks],
        }, ensure_ascii=False, indent=2))
        return 0

    print(f"收信箱 {INBOX_DIR}")
    if not pending:
        print("  待取：无")
    else:
        print(f"  待取 {len(pending)} 条：")
        for p in pending:
            try:
                d = json.loads(p.read_text())
                print(f"    · {p.stem}  [{d.get('status','?')}] "
                      f"{(d.get('request_summary') or d.get('request') or '')[:40]}")
            except Exception:
                print(f"    · {p.stem}  （读取失败）")
    if locks:
        print(f"  处理中锁 {len(locks)} 个：")
        for p in locks:
            age = (time.time() - p.stat().st_mtime) / 60
            flag = " ⚠️已过期，可 --unlock" if age * 60 > LOCK_STALE_SEC else ""
            print(f"    · {p.name.replace(PROCESSING_SUFFIX,'')}（{age:.0f} 分钟）{flag}")
    if done:
        print(f"  已汇报 {done and len(done)} 个 {DONE_SUFFIX}（`inbox --gc` 清理）")
    return 0


def _cmd_plans(args) -> int:
    """计划库（P1-3）：列出 / 查看 / 试匹配。

    --match 是给人用的安全阀：在真的加 --reuse-plan 之前，先看清它会套用哪一条、
    相似度多少。复用之所以默认关，就是因为套错计划的错不会报警。
    """
    plans = load_plans()

    if args.show:
        hit = next((p for p in plans if p.get("task_id") == args.show), None)
        if not hit:
            print(f"计划库里没有 {args.show}", file=_sys.stderr)
            return 1
        try:
            print(Path(hit["path"]).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"读取失败 {hit.get('path')}: {e}", file=_sys.stderr)
            return 1
        return 0

    if args.match:
        scored = sorted(
            ((_similarity(args.match, p.get("request", "")), p) for p in plans),
            key=lambda x: -x[0],
        )[:5]
        if args.json:
            print(json.dumps({
                "query": args.match,
                "threshold": PLAN_REUSE_MIN_SCORE,
                "would_reuse": bool(scored and scored[0][0] >= PLAN_REUSE_MIN_SCORE),
                "candidates": [{"task_id": p["task_id"], "score": round(s, 3),
                                "request": p.get("request", "")[:120]} for s, p in scored],
            }, ensure_ascii=False, indent=2))
            return 0
        print(f"查询：{args.match}\n阈值：{PLAN_REUSE_MIN_SCORE}")
        if not scored:
            print("  计划库为空——没有可复用的历史计划")
            return 0
        for s, p in scored:
            flag = " ← 会命中复用" if s >= PLAN_REUSE_MIN_SCORE else ""
            print(f"  {s:.3f}  {p['task_id']}  {p.get('request','')[:60]}{flag}")
        if scored[0][0] < PLAN_REUSE_MIN_SCORE:
            print("  （最高分未过阈值 → --reuse-plan 也会正常派 Thinker）")
        return 0

    if args.json:
        print(json.dumps({"plans_dir": str(PLANS_DIR), "count": len(plans),
                          "plans": plans}, ensure_ascii=False, indent=2))
        return 0
    print(f"计划库 {PLANS_DIR}（{len(plans)} 条，新→旧）")
    if not plans:
        print("  空。跑过 --mode plan 且计划合格后会自动落盘。")
    for p in plans[:30]:
        print(f"  · {p.get('task_id')}  [{p.get('steps', 0)} 步]  "
              f"{p.get('goal') or p.get('request', '')[:50]}")
    return 0


def _cmd_check(args) -> int:
    """Gatekeeper CLI：核查一个任务 / 命令是否必须派发（check_should_dispatch）"""
    verdict = check_should_dispatch(args.task)
    # 记账：operator 车道的决策只在这里留痕——Caller 直干不走 dispatch，审计日志里
    # 唯一能看到「Caller 判了自己能干」的地方就是这条。没有它，跟进率算不出来。
    log_audit("gatekeeper_check", {
        "mode": {"operator": "operator", "blocked": "blocked"}.get(
            verdict.get("category", ""), "worker"
        ),
        "category": verdict.get("category", ""),
        "should_dispatch": verdict.get("should_dispatch"),
        "blocked": verdict.get("blocked", False),
        "reason": verdict.get("reason", ""),
        "task_preview": (args.task or "")[:200],
    })
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    # 退出码恒 0：Hermes 直接读 json 的 should_dispatch 字段分流，无需按退出码判断。
    return 0


def _cmd_route(args) -> int:
    """分诊快道（2026-07-26）：四格路由 + Gatekeeper 一条命令出结果。

    给 Caller（Hermes）当分诊第一步：拿到 mode 决策与可直接照抄的派发命令，
    不必每轮在长上下文里重跑决策树——判定口径稳定、快、且 mode 落审计可统计。
    输出刻意单行紧凑（indent=None）：它会进 Hermes 会话历史，每个字节都随
    后续每次 API 调用回放，缩进就是持续付费的空白。
    """
    import shlex

    r = Caller.route_mode(args.request)
    gk = check_should_dispatch(args.request)
    mode = r["mode"]
    # ⑤ 路由反转取证（2026-07-29）：路由结论附实际会派的模板 id（含 areco 设置页
    # 覆盖后的真值）——冒烟/审计不用再猜「fast 是谁、worker 是谁」。
    try:
        _c = Caller()
        template_id = (
            (_c.task_map.get("fast") or _c.default_worker_id) if mode == "fast"
            else _c.default_heavy_worker_id if mode == "worker"
            else _c.default_thinker_id if mode in ("think", "plan")
            else _c.default_worker_id
        )
    except Exception:
        template_id = None
    # suggest 直出成品命令（2026-07-26 二阶）：任务原文 shlex.quote 嵌入、summary 自动取
    # 压缩空白后的前 24 字——Hermes 拿到即可原样执行，省掉一轮「往骨架里填参数」的组装。
    summary = " ".join((args.request or "").split())[:24]
    suggest = (
        f"python3 {Path(__file__).resolve()} run --wait --brief --mode {mode}"
        + (" --plan-only" if r.get("plan_only") else "")
        + f" {shlex.quote(args.request)} --summary {shlex.quote(summary)}"
    )
    if gk.get("category") == "blocked":
        suggest = "拒绝执行（BLOCKED 红线，勿派发勿直干）"
    out = {
        "mode": mode,
        "template_id": template_id,
        "plan_only": r.get("plan_only", False),
        "deliverable": r.get("deliverable"),
        "structure": r.get("structure"),
        "gatekeeper": gk.get("category"),
        "reason": r.get("reason"),
        "suggest": suggest,
    }
    log_audit("route", {
        "mode": mode,
        "blocked": gk.get("category") == "blocked",
        "category": gk.get("category"),
        "plan_only": r.get("plan_only", False),
        "request_preview": (args.request or "")[:200],
    })
    print(json.dumps(out, ensure_ascii=False))
    return 0


def _cmd_status(args) -> int:
    state = _read_state(args.task_id)
    if not state:
        print(f"❌ 未找到任务 {args.task_id}")
        print(f"   任务状态目录: {TASKS_DIR}")
        return 1
    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    spec = state.get("spec", {})
    print(f"task_id       : {state.get('task_id')}")
    print(f"status        : {state.get('status')}")
    print(f"pid           : {state.get('pid')}")
    print(f"request       : {spec.get('request', '')[:80]}")
    print(f"role/template : {spec.get('role')} / {state.get('template_id') or spec.get('template')}")
    if state.get("room_id"):
        print(f"room/session  : {state.get('room_id')} / {state.get('session_id')}")
    if state.get("stand_name"):
        print(f"stand         : {state.get('stand_name')}")
    if state.get("elapsed") is not None:
        print(f"elapsed       : {state.get('elapsed')}s")
    if state.get("completed_at"):
        print(f"completed_at  : {state.get('completed_at')}")
    _dr = state.get("wechat_dry_run")
    print(
        f"wechat_relayed: {state.get('wechat_relayed')}"
        + ("（dry-run，未真发）" if _dr else "")
    )
    _tg = state.get("trigger")
    if _tg:
        _tg_rc = _tg.get("returncode", _tg.get("error", ""))
        print(
            f"trigger       : ok={_tg.get('ok')} dry_run={_tg.get('dry_run')} rc={_tg_rc}"
        )
    if state.get("error"):
        print(f"error         : {state.get('error')}")
    if state.get("result_text"):
        print("\n── 结果预览 ──")
        print(state["result_text"][:800])
    print(f"\nlog: {state.get('log_path')}")
    return 0


def _cmd_list(args) -> int:
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(TASKS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        print(f"（暂无后台任务，目录 {TASKS_DIR}）")
        return 0
    print(f"{'task_id':<28} {'status':<10} {'created':<21} request")
    for f in files:
        try:
            s = json.loads(f.read_text())
        except Exception:
            continue
        req = (s.get("spec", {}).get("request", ""))[:40]
        print(
            f"{s.get('task_id', ''):<28} {s.get('status', ''):<10} "
            f"{s.get('created_at', ''):<21} {req}"
        )
    return 0


def _cmd_aggregate(args) -> int:
    caller = Caller()
    entries = []
    for tid in args.task_ids:
        s = _read_state(tid)
        if not s:
            print(f"⚠️ 跳过未找到的任务 {tid}")
            continue
        entries.append(_result_to_aggregate_entry(s))
    if not entries:
        print("无可汇总的任务")
        return 1
    msg = caller.aggregate_results(entries)
    if args.send:
        r = caller.relay_to_wechat(msg, summary="多任务汇总")
        print(f"已汇总并发送微信: ok={r.get('ok')}")
    else:
        print(msg)
    return 0


def _room_idle_min(room: dict) -> float | None:
    """房间静置分钟数：优先 lastMessageAt（ISO Z），无消息时退回 createdAt（ms epoch）"""
    ts = room.get("lastMessageAt")
    if ts:
        try:
            dt = datetime.strptime(str(ts), "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
            return (time.time() - dt.timestamp()) / 60
        except ValueError:
            pass
    created = room.get("createdAt")
    if isinstance(created, (int, float)):
        return (time.time() - created / 1000) / 60
    return None


def _room_view(room: dict, ledger: dict, sessions: dict) -> dict:
    """把 areco 房间 + 台账 + 会话状态拼成一行可判断的视图"""
    rid = room.get("id", "")
    rec = ledger.get(rid, {})
    members = [m for m in room.get("members", []) if m.get("sessionId")]
    running = sum(
        1 for m in members if (sessions.get(m["sessionId"], {}) or {}).get("status") == "running"
    )
    name = room.get("name") or ""
    if rid in ledger:
        source = "台账"
    elif ROOM_MARK and name.startswith(ROOM_MARK):
        source = "标记"
    elif _LEGACY_ROOM_RE.match(name) or _ROOM_TAIL_RE.search(name):
        source = "旧命名"
    else:
        source = "外部"
    return {
        "room_id": rid,
        "name": name,
        "archived": room.get("archivedAt") is not None,
        "members": len(members),
        "running": running,
        "idle_min": _room_idle_min(room),
        "source": source,
        "standcode": source != "外部",
        "task_id": rec.get("task_id"),
        "role": rec.get("role"),
        "template_id": rec.get("template_id"),
        "ledger_event": rec.get("event"),
    }


def _cmd_rooms(args) -> int:
    """房间台账 × areco 现状：列出 / 认领存量 / 清扫积压。

    清扫只归档、永不删除——归档可逆（UI「恢复任务」），删除不可逆，按章程不由 agent 代做。
    """
    caller = Caller()
    ledger = ledger_load()
    rooms = caller.list_rooms(include_archived=True)
    sessions = {s.get("id"): s for s in caller.list_sessions()}
    views = [_room_view(r, ledger, sessions) for r in rooms]

    # 认领：台账上线前建的房间（Stand-* / ·W1a2b 尾巴）补录，之后清扫才认得它们
    if args.adopt:
        adopted = [
            v for v in views
            if v["standcode"] and v["source"] != "台账"
        ]
        # 干跑默认（对齐 --sweep）：认领是**不可逆**的——台账按 room_id 折叠且没有
        # unadopt 事件，一旦认错（人手建的房间碰巧以 ⚙ 开头或以 ·T1a2b 结尾），
        # is_standcode_room 就永远返回 True，之后 --sweep --yes 会把它归档掉。
        # 判据又只是名字启发式，误判面真实存在。所以要 --yes 才真写。
        if not args.yes:
            print(f"[干跑] 可认领 {len(adopted)} 个存量房间（判据=名字启发式，"
                  f"认领不可逆，确认无误后加 --yes 真写台账）")
            for v in adopted:
                print(f"  · {v['room_id']}  {v['name']}  [{v['source']}]")
            if not adopted:
                print("  （无待认领房间：要么已在台账，要么不是 StandCode 派发的）")
            return 0
        for v in adopted:
            ledger_append(
                "adopted", v["room_id"], room_name=v["name"],
                archived=v["archived"], by="rooms --adopt",
            )
        print(f"已认领 {len(adopted)} 个存量房间进台账（{ROOMS_LEDGER_PATH}）")
        for v in adopted:
            print(f"  · {v['room_id']}  {v['name']}")
        if not adopted:
            print("  （无待认领房间：要么已在台账，要么不是 StandCode 派发的）")
        ledger = ledger_load()
        views = [_room_view(r, ledger, sessions) for r in rooms]

    scope = views if args.all else [v for v in views if v["standcode"]]

    # 清扫：静了、没人在跑、还没归档的自家房间
    if args.sweep:
        cand = [
            v for v in scope
            if v["standcode"] and not v["archived"] and v["running"] == 0
            and (v["idle_min"] is None or v["idle_min"] >= args.idle)
        ]
        if not cand:
            print(f"无可清扫房间（门槛：静置 ≥ {args.idle:g} 分钟且房内无运行中会话）")
            return 0
        print(f"{'干跑' if not args.yes else '执行'}：{len(cand)} 个房间可归档"
              f"（静置 ≥ {args.idle:g} 分钟、无运行中会话）")
        for v in cand:
            idle = f"{v['idle_min']:.0f}m" if v["idle_min"] is not None else "?"
            print(f"  · {v['room_id']}  静置{idle:>6}  {v['name']}")
        if not args.yes:
            print("\n以上仅列出未执行。确认后加 --yes 真归档（可逆：UI 点「恢复任务」还原）。")
            return 0
        okc = 0
        for v in cand:
            try:
                caller.archive_room(v["room_id"])
                ledger_append("archived", v["room_id"], room_name=v["name"], by="sweep")
                okc += 1
            except Exception as e:
                print(f"  ⚠️ 归档失败 {v['room_id']}: {e}")
        log_audit("room_sweep", {"candidates": len(cand), "archived": okc})
        print(f"\n已归档 {okc}/{len(cand)} 个房间（会话随房间一并归档，看板已清）")
        return 0

    if args.json:
        print(json.dumps(scope, ensure_ascii=False, indent=2))
        return 0

    if not scope:
        print("（没有 StandCode 房间；台账 %s）" % ROOMS_LEDGER_PATH)
        return 0
    print(f"{'room':<10} {'状态':<8} {'来源':<7} {'成员':<5} {'在跑':<5} {'静置':<8} 名字")
    for v in sorted(scope, key=lambda x: (x["archived"], x["idle_min"] or 0)):
        idle = f"{v['idle_min']:.0f}m" if v["idle_min"] is not None else "?"
        state = "已归档" if v["archived"] else "在看板"
        print(
            f"{v['room_id']:<10} {state:<8} {v['source']:<7} {v['members']:<5} "
            f"{v['running']:<5} {idle:<8} {v['name']}"
        )
    live = [v for v in scope if not v["archived"]]
    gone = [rid for rid in ledger if rid not in {r.get("id") for r in rooms}]
    print(
        f"\n合计 {len(scope)} 个（在看板 {len(live)} / 已归档 {len(scope) - len(live)}）"
        f"；台账已消失房间 {len(gone)} 个；自动归档开关 auto_archive="
        f"{'on' if AUTO_ARCHIVE else 'off'}"
    )
    if live:
        print("清扫积压：caller.py rooms --sweep（干跑）→ 加 --yes 执行")
    return 0


def _cmd_pool(args) -> int:
    """暖池运维 + 模板健康闸：现状 / 播种（warm）/ 清扫（sweep）/ --heal 解除模板隔离。

    warm 是幂等的：每个目标模板池满即跳过，适合 cron 定时跑——areco 重启会把待命
    TUI 全杀成 exited（认领时才发现 = 那一单退回冷启动），定时播种把这个窗口收窄。
    """
    caller = Caller()
    if args.heal:
        # 手动解除模板隔离（确认模板已修复后用；until 过期本来也会自动恢复）
        d = _read_unhealthy()
        if args.heal in d:
            d.pop(args.heal, None)
            _write_unhealthy(d)
            print(f"已解除模板『{args.heal}』的隔离（健康闸）")
        else:
            print(f"模板『{args.heal}』不在健康闸黑名单中")
        return 0
    out: dict = {"enabled": STANDBY_ENABLED, "pool_size": STANDBY_POOL_SIZE,
                 "max_age_sec": STANDBY_MAX_AGE_SEC}
    if args.sweep or args.warm:
        out["sweep"] = caller.standby_sweep()
    if args.warm:
        if not STANDBY_ENABLED:
            print("暖池已关（STANDBY_ENABLED=False，2026-07-29 高律师令），不播种")
            return 0
        targets = [args.template] if args.template else list(dict.fromkeys(
            [caller.default_worker_id, caller.default_thinker_id]))
        refilled = []
        for tpl in targets:
            if not tpl:
                continue
            r = caller.standby_refill(tpl)
            if r:
                refilled.append({"template": tpl, "room_id": r["room_id"]})
        out["refilled"] = refilled
    out["standby"] = caller.standby_status()
    # 健康闸黑名单（2026-07-28 A3）：until 过期的记录自动视为恢复，不展示
    _now = time.time()
    out["unhealthy"] = {
        t: e for t, e in _read_unhealthy().items()
        if float(e.get("until") or 0) > _now
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    print(f"暖池 {'on' if STANDBY_ENABLED else 'off'}（每模板 {STANDBY_POOL_SIZE} 位，"
          f"保鲜 {STANDBY_MAX_AGE_SEC / 60:.0f} 分钟）")
    for s in out["standby"]:
        print(f"  ⚙ {s.get('template_id')}  room={s.get('room_id')}  "
              f"龄 {s.get('age_sec', 0) / 60:.1f}min  会话={s.get('session_status')}")
    if not out["standby"]:
        print("  （空——下一单冷派发会自动播种，或 pool --warm 手动补）")
    if out["unhealthy"]:
        print("模板黑名单（健康闸）：")
        for t, e in sorted(out["unhealthy"].items()):
            left = (float(e.get("until") or 0) - _now) / 60
            print(f"  ✖ {t}  连挂 {e.get('failures')} 次，剩 {left:.0f}min 自动恢复"
                  f"（pool --heal {t} 手动解除）  last_error: {str(e.get('last_error', ''))[:60]}")
    else:
        print("模板黑名单：空（无被隔离模板）")
    if args.warm:
        print(f"播种 {len(out.get('refilled') or [])} 个；清扫 {out.get('sweep')}")
    elif args.sweep:
        print(f"清扫 {out.get('sweep')}")
    return 0


def _build_parser():
    import argparse

    p = argparse.ArgumentParser(
        prog="caller.py",
        description="StandCode Caller CLI — 一行命令派发/主动轮询/代发微信（支持后台）",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("run", help="派发+主动轮询（--wait 等待者模式=唤醒主链；--bg 已弃用）")
    pr.add_argument("request", help="任务描述")
    pr.add_argument("--wait", action="store_true",
                    help="等待者模式（2026-07-25 定案唤醒主链）：前台阻塞到 Stand 完成，结果写 inbox + stdout 全文，"
                         "不发微信、不发触发消息。供 Hermes terminal 工具 background=true+notify_on_complete=true 调用，"
                         "进程退出由 gateway 自动回注原微信会话；执行者 Stand 全程留在 areco 看板可见")
    pr.add_argument("--bg", "--background", dest="bg", action="store_true",
                    help="[已弃用→用 --wait] shell 级脱管后台（start_new_session，gateway 追踪不到，唤醒靠 cc-send 外网绕行）")
    pr.add_argument("--task-type", default="general", help="任务类型（默认 general）")
    pr.add_argument("--role", choices=["thinker", "worker"], default=None, help="角色分派")
    pr.add_argument("--template", default=None, help="指定模板 id")
    pr.add_argument("--room-id", default=None, help="复用现有房间")
    pr.add_argument("--summary", default=None, help="一句话结论（代发微信用）")
    pr.add_argument("--file", "--file-path", dest="file", default=None, help="产物文件路径")
    pr.add_argument("--timeout", type=int, default=None,
                    help="轮询超时秒数（未显式给时：--wait/--bg 0=无限等，普通前台 600）")
    pr.add_argument("--no-relay", action="store_true", help="不代发微信，只取结果")
    pr.add_argument(
        "--dry-run",
        action="store_true",
        help="测试用：前台模式不真发微信（拉模式下 --bg 触发消息已恒不发，本开关只影响裸前台 relay）",
    )
    pr.add_argument("--plan", action="store_true", help="[= --mode plan] 两段式：Thinker 出计划 → Worker 执行")
    pr.add_argument(
        "--mode", choices=list(MODES), default=None,
        help="工作模式（docs/work-modes.md）：worker=直派 Worker（单步、要东西）｜"
             "think=派 Thinker（要判断，不要东西；+--plan-only 则只出结构化计划）｜"
             "plan=两段式 Thinker→Worker（多步有依赖、要东西）｜"
             "fanout=多 Worker 并行（配 --sub，N 个互不依赖子任务）｜"
             "operator=Caller 自持车道（run 不受理，见 `caller.py check`）。"
             "不给则由旧 --role/--plan 推导",
    )
    pr.add_argument(
        "--plan-only", dest="plan_only", action="store_true",
        help="只出六段结构化计划、不执行（自动按 --mode think 走；与 --plan 互斥）",
    )
    pr.add_argument(
        "--sub", dest="subs", action="append", default=[], metavar="子任务",
        help="fanout 子任务，可重复给（≥2 个）。positional request 作为共享前置上下文拼到每个子任务前。"
             "⚠️ 当前无文件隔离，多 Worker 并发写同一文件会互相覆盖——只适合只读或互不相干的子任务",
    )
    pr.add_argument(
        "--reuse-plan", dest="reuse_plan", action="store_true",
        help="[--mode plan] 命中足够相似的历史计划就跳过 Thinker 段（省一个 Stand）。"
             "默认关——静默套用过期计划会产出「看起来做完了但做错了」的结果；"
             "命中时一律回报套用了哪一条（reused_plan）",
    )
    pr.add_argument(
        "--brief", action="store_true",
        help="[--wait] stdout 的 result_text 截到 700 字（全文仍在 inbox）。"
             "stdout 会进 Caller 会话历史被反复回放，长结果全文回放极烧 token——"
             "Hermes 派发一律带上（SKILL.md token 纪律）",
    )
    pr.add_argument(
        "--isolated", action="store_true",
        help="[worker] 工作区隔离：为本任务建独立目录（配 --workspace-repo 则 git worktree），"
             "经 areco per-session cwd 让 Stand 落在隔离目录里跑（2026-07-26 起 areco 侧支持）。"
             "隔离派发不走暖池（cwd 在 spawn 时定）",
    )
    pr.add_argument(
        "--workspace-repo", dest="workspace_repo", default=None,
        help="[--isolated] 基于哪个 git 仓库建 worktree；不给则只建空目录",
    )
    pr.add_argument(
        "--force", action="store_true",
        help="跳过重复派发闸（同一 request 有在途 running 任务也强派；默认拦截，退出码 2）",
    )
    pr.add_argument(
        "--fresh", action="store_true",
        help="干净上下文标记（2026-07-29 会话复用层）：跳过旧会话复用、强制 spawn 新会话。"
             "擂台/基准测试必须带（公平性，各模型同起点）；正文含「干净上下文」/[fresh] 同效",
    )
    pr.add_argument(
        "--depth", type=int, default=None,
        help="派发深度（2026-08-02 多向派发防套娃）：顶层派发 0（默认），Stand 转派子任务"
             "按任务书「委派说明」+1。达上限（默认 2，STANDCODE_MAX_DISPATCH_DEPTH 可调）"
             "拒派退出码 2，--force 可越；env STANDCODE_DISPATCH_DEPTH 为缺省来源",
    )
    pr.set_defaults(func=_cmd_run)

    pg = sub.add_parser(
        "go",
        help="单命令收口（Hermes 主道，2026-07-26）：gatekeeper→route 定模式→相关记忆引导→派发+等待+inbox，"
             "替代 route→run 两连。跑法与 run --wait 相同：background=true+notify_on_complete=true",
    )
    pg.add_argument("request", help="用户原文（go 自动分诊定模式）")
    pg.add_argument("--summary", default=None, help="一句话摘要（缺省取压缩空白后前 24 字）")
    pg.add_argument(
        "--recall", default=None, metavar="词组",
        help="相关记忆定向词组：拼「相关记忆：<词组>」行进任务文本，areco 投递层 auto-recall 按它查记忆库"
             "（缺省服务端用正文前 120 字；正文已含引导词则不重复拼）",
    )
    pg.add_argument("--mode", choices=list(MODES), default=None,
                    help="显式改判模式（缺省 route 四格自动判；route 明显不合常识才用）")
    pg.add_argument("--plan-only", dest="plan_only", action="store_true",
                    help="配 --mode think：只出结构化计划不执行")
    pg.add_argument("--sub", dest="subs", action="append", default=[], metavar="子任务",
                    help="--mode fanout 的子任务，可重复（route 判不出 fanout，必须显式声明拆法）")
    pg.add_argument("--template", default=None, help="指定模板 id（缺省按角色默认）")
    pg.add_argument("--room-id", default=None, help="复用现有房间")
    pg.add_argument("--task-type", default="general", help="任务类型（默认 general）")
    pg.add_argument("--file", "--file-path", dest="file", default=None, help="产物文件路径")
    pg.add_argument("--timeout", type=int, default=None, help="轮询超时秒（缺省 0=无限等到 Stand 完成）")
    pg.add_argument("--full", action="store_true",
                    help="stdout 结果不截断（缺省按 --brief 口径截 700 字，全文在 inbox）")
    pg.add_argument("--reuse-plan", dest="reuse_plan", action="store_true",
                    help="[plan 模式] 命中足够相似的历史计划则跳过 Thinker 段")
    pg.add_argument("--dry-run", action="store_true",
                    help="只分诊+组包不派发（测试/预览用；audit 照记 dry_run=true）")
    pg.add_argument("--force", action="store_true",
                    help="跳过重复派发闸（同一 request 有在途 running 任务也强派；默认拦截，退出码 2）")
    pg.add_argument("--fresh", action="store_true",
                    help="干净上下文标记：跳过旧会话复用、强制新会话"
                         "（擂台/基准测试必带；正文含「干净上下文」/[fresh] 同效）")
    pg.add_argument("--depth", type=int, default=None,
                    help="派发深度（多向派发防套娃）：Stand 转派子任务时按任务书「委派说明」"
                         "带 +1；达上限拒派（--force 可越），详见 run --depth")
    pg.set_defaults(func=_cmd_go)

    pk = sub.add_parser(
        "ask",
        help="点名常驻 agent（默认 Fable5）——先观察运行状态：空闲直投常驻会话，"
             "忙/不可用则自动另开并行任务（2026-07-26）。跑法与 go 相同："
             "background=true+notify_on_complete=true；仅限新任务，跟进/续跑走 areco-msg",
    )
    pk.add_argument("request", help="任务原文（点名通道，不走 route 分诊）")
    pk.add_argument("--summary", default=None, help="一句话摘要（缺省取压缩空白后前 24 字）")
    pk.add_argument(
        "--recall", default=None, metavar="词组",
        help="相关记忆定向词组（同 go：拼「相关记忆：<词组>」行，areco 投递层 auto-recall 按它查库）",
    )
    pk.add_argument("--member", default=None,
                    help=f"通道成员名（缺省 env/local.json ask_channel，当前默认 {ASK_MEMBER}）")
    pk.add_argument("--room-id", default=None, help="通道房间 id（缺省配置值，漂移时按成员名搜）")
    pk.add_argument("--template", default=None,
                    help="fork 时用的模板 id（缺省取常驻会话的 templateId）")
    pk.add_argument("--fork", action="store_true",
                    help="强制另开并行任务（跳过探灯；与 --direct 互斥）")
    pk.add_argument("--direct", action="store_true",
                    help="强制直投常驻会话（忙也排队；仅确知是同上下文延续时用；与 --fork 互斥）")
    pk.add_argument("--file", "--file-path", dest="file", default=None, help="产物文件路径（机检收口用）")
    pk.add_argument("--timeout", type=int, default=None, help="轮询超时秒（缺省 0=无限等到完成）")
    pk.add_argument("--full", action="store_true",
                    help="stdout 结果不截断（缺省截 700 字，全文在 inbox）")
    pk.add_argument("--dry-run", action="store_true",
                    help="只探灯+定路由不投递（测试/预览用）")
    pk.add_argument("--depth", type=int, default=None,
                    help="派发深度（多向派发防套娃）：达上限直接拒（ask 无 --force 门），"
                         "详见 run --depth")
    pk.set_defaults(func=_cmd_ask)

    prt = sub.add_parser(
        "route",
        help="分诊快道：四格路由 + Gatekeeper 一次出结果（单行 JSON，含建议派发命令）",
    )
    prt.add_argument("request", help="用户任务原文")
    prt.set_defaults(func=_cmd_route)

    ps = sub.add_parser("status", help="查看后台任务状态/结果")
    ps.add_argument("task_id", help="任务 id")
    ps.add_argument("--json", action="store_true", help="输出原始 json")
    ps.set_defaults(func=_cmd_status)

    pc = sub.add_parser(
        "check",
        help="Gatekeeper：核查一个任务/命令是否必须派发（check_should_dispatch）",
    )
    pc.add_argument("task", help="任务描述或即将执行的 terminal 命令")
    pc.set_defaults(func=_cmd_check)

    pl = sub.add_parser("list", help="列出所有后台任务")
    pl.set_defaults(func=_cmd_list)

    pi = sub.add_parser(
        "inbox",
        help="收信箱：--digest 一键消化全部待取（推荐）/ 列出待取 / --gc 清理 / --unlock 解死锁",
    )
    pi.add_argument(
        "--digest", action="store_true",
        help="消化模式：每条待取输出微信可直接转述的紧凑简报并标 .done——"
             "替代 ls→cat→mv 三连（一次唤醒 1 个 tool call 搞定全部积压）",
    )
    pi.add_argument("--keep", action="store_true", help="配合 --digest：只读简报，不标 .done")
    pi.add_argument(
        "--all-channels", dest="all_channels", action="store_true",
        help="配合 --digest：跨通道全收（默认只消化本通道——收信箱两条微信通道共用，"
             "乱收会把别人通道的结果标 .done 并汇报到错误聊天窗口）",
    )
    pi.add_argument("--json", action="store_true", help="结构化输出")
    pi.add_argument("--gc", action="store_true", help=f"清理 {DONE_SUFFIX}（默认干跑）")
    pi.add_argument("--older-than", type=float, default=7, help="配合 --gc：保留最近 N 天（默认 7）")
    pi.add_argument("--unlock", action="store_true", help="解过期 .processing 锁（默认干跑）")
    pi.add_argument("--force", action="store_true", help="配合 --unlock：连未过期的锁一并解")
    pi.add_argument("--yes", action="store_true", help="真执行（--gc / --unlock 默认只干跑）")
    pi.set_defaults(func=_cmd_inbox)

    prr = sub.add_parser(
        "reconcile",
        help="对账补收（cron 佣工，每10分钟）：等待者死亡/卡死解开后的迟到结果从房间捞回 inbox；幂等只补不删",
    )
    prr.add_argument("--dry-run", action="store_true", help="只报告不写")
    prr.add_argument("--max-age-days", type=float, default=7.0, help="只扫最近 N 天的 state（默认 7）")
    prr.set_defaults(func=_cmd_reconcile)

    ph = sub.add_parser(
        "harvest",
        help="收割巡检（cron 佣工，每10分钟）：无 caller 跟踪的结果拍平进 main inbox——"
             "Job1 通道交叉中继（secretary-01 等非 main 通道）+ Job2 房间收割（settle 门控捆报）",
    )
    ph.add_argument("--dry-run", action="store_true", help="只报告不写 inbox / 不推进水位线")
    ph.set_defaults(func=_cmd_harvest)

    prp = sub.add_parser(
        "report",
        help="复盘报表：聚合审计出派发质量统计（08-05 试运行复盘口径，输出可直接贴房间/微信）",
    )
    prp.add_argument("--days", type=float, default=1.0, help="统计窗口天数（默认 1）")
    prp.add_argument("--json", action="store_true", help="机器可读输出")
    prp.set_defaults(func=_cmd_report)

    pp2 = sub.add_parser("plans", help="计划库：列出历史 Thinker 计划 / 查相似度（P1-3 复用）")
    pp2.add_argument("--show", default=None, metavar="TASK_ID", help="打印某条计划全文")
    pp2.add_argument("--match", default=None, metavar="任务描述",
                     help="拿一段任务描述去比相似度，看会不会命中复用（不派发，纯查）")
    pp2.add_argument("--json", action="store_true", help="结构化输出")
    pp2.set_defaults(func=_cmd_plans)

    pm = sub.add_parser(
        "rooms",
        help="房间台账 × areco 现状：列出 / 认领存量 / 清扫积压（只归档，永不删除）",
    )
    pm.add_argument("--all", action="store_true", help="连非 StandCode 房间一起列（默认只列自家派发房）")
    pm.add_argument("--json", action="store_true", help="输出结构化 json")
    pm.add_argument(
        "--idle", type=float, default=SWEEP_IDLE_MIN,
        help=f"清扫的静置门槛分钟数（默认 {SWEEP_IDLE_MIN:g}，防止扫掉正在追问的房间）",
    )
    pm.add_argument("--adopt", action="store_true", help="把台账上线前的存量派发房间补录进台账（默认干跑，--yes 真写；认领不可逆）")
    pm.add_argument("--sweep", action="store_true", help="清扫：列出可归档房间（默认干跑）")
    pm.add_argument("--yes", action="store_true", help="配合 --sweep 真执行归档（可逆，UI 可恢复）")
    pm.set_defaults(func=_cmd_rooms)

    pa = sub.add_parser("aggregate", help="把多个后台任务结果汇总成一条微信消息（aggregate_results）")
    pa.add_argument("task_ids", nargs="+", help="一个或多个 task_id")
    pa.add_argument("--send", action="store_true", help="直接发送微信（默认只打印）")
    pa.set_defaults(func=_cmd_aggregate)

    pw = sub.add_parser(
        "pool",
        help="暖池运维：列出待命 Stand / warm 播种+清扫 / sweep 只清扫（2026-07-26 提速批件）；"
             "--heal 解除模板健康闸隔离",
    )
    pw.add_argument("--warm", action="store_true",
                    help="播种：给默认 Worker/Thinker 模板各补满待命位（幂等，池满跳过）+顺手清扫过期位")
    pw.add_argument("--sweep", action="store_true", help="只清扫：过期待命位归档回收，不播种")
    pw.add_argument("--template", default=None, help="[--warm] 只给指定模板播种")
    pw.add_argument("--heal", default=None, metavar="模板ID",
                    help="手动解除模板健康闸隔离（确认模板已修复后用；until 到期本来也会自动恢复）")
    pw.add_argument("--json", action="store_true", help="结构化输出")
    pw.set_defaults(func=_cmd_pool)

    return p


def _cli() -> int:
    # 隐藏的 worker 子命令（后台进程用，不出现在 help）
    if len(_sys.argv) >= 2 and _sys.argv[1] == "_worker":
        return _bg_worker(_sys.argv[2])

    if len(_sys.argv) >= 2 and _sys.argv[1] == "_process_inbox":
        task_id = _sys.argv[2]
        result = process_inbox_callback(task_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 1
    args = _build_parser().parse_args()
    return args.func(args) or 0


if __name__ == "__main__":
    _sys.exit(_cli())
