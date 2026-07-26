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

import requests

logger = logging.getLogger("standcode.caller")

# ── 默认配置 ────────────────────────────────────────────────────────
ARECO_BASE = os.environ.get("ARECO_BASE", "http://127.0.0.1:8790")
# ── 本机私有配置 ────────────────────────────────────────────────────
# 本机私有值不进仓：优先级 env > config/local.json（gitignore）> 默认。
# WECHAT_TARGET 为空时 relay_to_wechat 直接返回未配置错误，不影响 dispatch/poll/inbox 主链。
#
# ⚠️ 这一段必须在 ARECO_ROOT 之前——HOME_DIR 是所有「家目录派生路径」的唯一源头。
# 改动前 ARECO_ROOT/TASKS_DIR 走 Path.home()、而 HOME_DIR 走 local.json，两者在隔离
# HOME 下会分裂：REST 照样连本机 8790 建出真房间、起真 Stand（烧额度），随后 send_message
# 却对着 $HOME/Code/areco/data/projects.db 找不到库而炸——留下一个永远收不到任务的孤儿房。
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
    # 2026-07-26 subtree 并入后 caller.py 位于 <areco仓根>/standcode/caller/，向上两级
    # 即仓根——同仓自证，彻底免疫隔离 HOME 分裂（见上）。npm 安装场景
    # （node_modules/standcode/caller/）向上两级是 node_modules，靠 areco 源码仓
    # 特有的 packages/server 标志排除，防止把别人的目录误认成 areco。
    root = Path(__file__).resolve().parents[2]
    return str(root) if (root / "packages" / "server").is_dir() else None


ARECO_ROOT = (
    os.environ.get("ARECO_ROOT")
    or _detect_areco_root()
    or str(Path(HOME_DIR) / "Code" / "areco")
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
# BOOT_WAIT_SEC：add_stand 返回 → send_message 之间的等待。历史值 3s 是「等 TUI boot」
# 的保险，但消息走 SQLite 落库、由 areco room-relay 2s tick 投递，注入前还有
# onceQuiet（输出安静 1.2s）挡竞态——Stand 没 ready 消息也不会丢，3s 纯属重复保险。
# MERGE_WAIT_SEC：poll 收到首条 Stand 回复后的合并窗（等可能的连发增量）。
# POLL_INTERVAL_SEC：轮询间隔；读的是本地 SQLite，0.5s 的成本可忽略。
BOOT_WAIT_SEC = _conf_float("STANDCODE_BOOT_WAIT", "boot_wait_sec", 1.0)
MERGE_WAIT_SEC = _conf_float("STANDCODE_MERGE_WAIT", "merge_wait_sec", 1.5)
POLL_INTERVAL_SEC = _conf_float("STANDCODE_POLL_INTERVAL", "poll_interval_sec", 0.5)

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

# 来自 Caller 自身的身份标识
CALLER_NAME = "Hermes"

# 房间里"非 Stand"的发件人 —— 这些消息不算 Stand 的执行结果：
#   Hermes  = Caller 自己（直写 SQLite 时 from_agent）
#   HUMAN_NAME = 人类用户（REST 通道的 from_agent）。名称因人而异，故走
#                env > config/local.json > 默认 的三层配置，不硬编码个人称谓。
#   all/system = 广播/系统消息
HUMAN_NAME = os.environ.get("STANDCODE_HUMAN_NAME") or _LOCAL_CONF.get("human_name") or "user"
NON_STAND_SENDERS = {CALLER_NAME, HUMAN_NAME, "all", "system"}

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
PLAN_KEYWORDS = (
    "调研", "研究", "方案", "设计", "架构", "对比", "规划", "拆解",
    "分几步", "计划", "梳理流程", "可行性", "评估", "多步", "分阶段",
)
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
MODES = ("operator", "worker", "think", "plan", "fanout")
DISPATCH_MODES = ("worker", "think", "plan", "fanout")  # run 能派的（operator 不派发）

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
    try:
        with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning("审计日志写入失败 event=%s: %s", event, e)


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
    return f"{ROOM_MARK}{label or 'Stand'}·{tag}{uuid.uuid4().hex[:4]}"


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
    rec = {"ts": _now_iso(), "event": event, "room_id": room_id, **fields}
    try:
        ROOMS_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        with ROOMS_LEDGER_PATH.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except OSError as e:
        logger.warning("房间台账写入失败 %s: %s", ROOMS_LEDGER_PATH, e)


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
        self.default_caller_id: str = ""  # areco 设置页的 caller 默认（仅记录，caller 角色由入口 agent 自任）
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
        _FALLBACK_THINKER = "workbuddy-deepseek-pro"
        _FALLBACK_WORKER = "claude"

        def _apply_fallback(reason: str) -> None:
            logger.warning(
                "%s；改用紧急兜底 thinker=%s worker=%s",
                reason, _FALLBACK_THINKER, _FALLBACK_WORKER,
            )
            self.default_thinker_id = _FALLBACK_THINKER
            self.default_worker_id = _FALLBACK_WORKER
            self.default_template_id = _FALLBACK_WORKER
            self.task_map = {}
            self._apply_areco_defaults()  # registry 挂了仍吃 areco 设置页的角色默认

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

    def finish_room(self, dispatch_result: dict, status: str) -> dict:
        """一次派发的收口：成功即归档自建房间，其余情况留在看板。

        只归档「StandCode 自己新建」的房间（dispatch_result["room_created"]）——
        用户传 room_id 复用的房间是人家的地盘，收口时一律不动。
        归档失败只告警：房间没清掉是脏数据，把整条任务链带崩才是事故。

        返回 {"archived": bool, "room_id": str|None, "reason": str}
        """
        room_id = dispatch_result.get("room_id")
        if not room_id:
            return {"archived": False, "room_id": None, "reason": "no_room"}
        task_id = dispatch_result.get("task_id", "")
        if not dispatch_result.get("room_created", False):
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="reused_room")
            return {"archived": False, "room_id": room_id, "reason": "reused_room"}
        if not AUTO_ARCHIVE:
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="auto_archive_off")
            return {"archived": False, "room_id": room_id, "reason": "auto_archive_off"}
        if status != "completed":
            # 失败/超时/失联：留在看板才看得见，别把现场归档掉
            ledger_append("kept", room_id, task_id=task_id, status=status, reason="not_completed")
            return {"archived": False, "room_id": room_id, "reason": "not_completed"}
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
        human_relay: bool = True,
    ) -> int:
        """向房间发送消息（直写 SQLite）

        team: 房间 team 名（如 "room-xxxx"）
        to:   收件人成员名
        body: 消息正文
        from_: 发件人身份（默认 "Hermes"）
        human_relay: 是否按「转述人类原话」投递（默认 True）。Caller 代发任务=转述用户
            意图，置 True 让 areco room-relay 把 Hermes 当人类发言（默认投全体 + 清零链深
            + 附 context 预览），Stand 才会当指令回应。前提：from（Hermes）需在 areco
            config.json 的 humanRelayAgents 白名单（生产已配 = ['Hermes']）。
        返回消息 ID
        """
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
                "workspace_cwd": bool,       # Stand cwd 是否已真正切到 workspace（当前恒 False）
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

        # 1.5 工作区隔离（默认关）。仅准备目录 + 回填结果；cwd 落地待 areco 支持。
        workspace_info = (
            self.prepare_workspace(task_id, source_repo=workspace_repo)
            if isolated else None
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

            # 4. 等待片刻让 session 启动（投递链自带 2s tick + onceQuiet，见 BOOT_WAIT_SEC 注释）
            time.sleep(BOOT_WAIT_SEC)

            # 5. 向房间发送任务消息（直写 SQLite）
            msg_id = self.send_message(team, stand_name, request)
        except Exception as e:
            logger.error("派发中途失败（room=%s tid=%s）：%s", rid, tid, e)
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
            "workspace": (workspace_info or {}).get("path"),
            "workspace_cwd": bool((workspace_info or {}).get("applied", False)),
        }
        if room_created:
            # 补一条带 Stand 信息的台账（created 已在建房后先落，这里只是补全）
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
        })
        logger.info(
            "派发任务: session=%s room=%s stand=%s mode=%s role=%s task_type=%s tid=%s",
            team, rid, stand_name, mode or "-", effective_role, effective_task_type, tid,
        )
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
        )

    def dispatch_worker(
        self,
        request: str,
        task_type: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
        request_summary: str | None = None,
        mode: str = "worker",
    ) -> dict:
        """派给 Worker（registry.default_worker）：代码、搜索、文书、下载、总结"""
        return self.dispatch(
            request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role="worker",
            request_summary=request_summary,
            mode=mode,
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

        返回:
            {
                "session_id": str,
                "room_id": str | None,
                "status": "completed" | "timeout" | "error",
                "result_text": str,         # Stand 回复合并文本（completed 才有）
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
            except Exception as e:
                logger.warning("查询消息失败: %s", e)
                time.sleep(poll_interval)
                continue

            for msg in messages:
                last_id = max(last_id, msg.get("id", 0))
                if _is_my_stand(msg.get("from_agent", "")):
                    stand_replies.append(msg)

            if stand_replies:
                # 收到首条 Stand 回复后再等一小段，合并可能的后续增量
                time.sleep(MERGE_WAIT_SEC)
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
                    "轮询完成: session=%s %d 条 Stand 回复（耗时 %.1fs）",
                    session_id, len(stand_replies), elapsed,
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
                    "error": None,
                }

            # 2) 还没收到回复 —— best-effort 判定是否「lost」（Stand 失联）
            #    两路信号（建议 4a·会话可靠性）：
            #    (a) areco 会话状态 == exited：主信号、真实（直查 areco /api/sessions）。
            #    (b) 心跳文件过期（>15s 未更新）：辅信号。仅当 Stand 宿主写了心跳才有意义；
            #        无心跳文件（None）不参与判定——Caller 不自写心跳（假信号，见 _HeartbeatWriter）。
            #    命中任一 → status='lost'，区别于普通 error/timeout，便于上层有针对性地重派发。
            if stand_session_id and time.time() - last_status_check > 10:
                last_status_check = time.time()
                lost_reason: str | None = None
                ses = self._session_status(stand_session_id)
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
                        "error": f"Stand 失联：{lost_reason}",
                    }

            time.sleep(poll_interval)

        elapsed = round(time.time() - start_time, 2)
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
            "error": f"轮询超时（{timeout}s）",
        }

    def _session_status(self, session_id: str) -> str | None:
        """best-effort 查 areco 会话状态（'running'/'exited'/...）。失败或找不到返回 None。

        走 GET /api/sessions 列表线性匹配；只读，不改 areco 服务端。
        """
        try:
            data = self._api_get("/sessions")
            sessions = data if isinstance(data, list) else data.get("sessions", [])
            for s in sessions:
                if s.get("id") == session_id:
                    return s.get("status")
        except Exception:
            return None
        return None

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
            if poll.get("status") == "lost" and retries < max_retries:
                retries += 1
                logger.warning("lost → 重派发 %d/%d", retries, max_retries)
                dispatch_result = self.redispatch(
                    dispatch_result, request,
                    task_type=task_type, template_id=template_id,
                )
                continue
            poll["redispatch_count"] = retries
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

        # 收口：结果已收完（且已代发/已落 inbox），成功就把自建房间归档，别在看板堆着
        archive = self.finish_room(dispatch_result, status)

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
                )
            logger.info("无足够相似的历史计划（阈值 %.2f），正常派 Thinker", PLAN_REUSE_MIN_SCORE)

        # 1. Thinker 出结构化计划（plan_only 强制「只规划不执行」+ 结构化模板）
        plan_dispatch = self.dispatch_thinker(
            request,
            task_type=task_type,
            plan_only=True,
        )
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
                # 降级 1：同房间、同 Stand 重申格式（不新建房、不新起 Stand，只多一轮对话）
                retry_msg_id = self.send_message(
                    plan_dispatch["session_id"],
                    plan_dispatch["stand_name"],
                    PLAN_RETRY_TEMPLATE,
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

        # 2. Worker 按计划执行
        return self._execute_with_plan(
            request, plan_text, plan,
            task_type=task_type, request_summary=request_summary,
            file_path=file_path, poll_timeout=poll_timeout, dry_run=dry_run,
            plan_dispatch=plan_dispatch, plan_poll=plan_poll,
            degraded=degraded, degrade_reason=degrade_reason,
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
    ) -> dict:
        """两段式的执行半段：拿着计划派 Worker → 轮询 → 代发 → 收口。

        抽出来是因为有两个入口共用它：正常的 Thinker→Worker，以及计划复用
        （plan_dispatch=None，直接从历史计划开工，跳过整个 Thinker 段）。
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
        archive = {"execute": self.finish_room(exec_dispatch, exec_status)}
        if plan_dispatch:
            archive["plan"] = self.finish_room(plan_dispatch, exec_status)

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

        判定顺序（先到先得）：
            1. 命中 PLAN_ONLY_KEYWORDS（「只要计划」「别动手」）→ think + plan_only
            2. 交付物 = 判断（命中 JUDGMENT 且未命中 ARTIFACT）→ think
               （多步则 plan_only=True——多步判断的自然产物就是结构化计划）
            3. 交付物 = 东西 且 多步有依赖 → plan（两段式）
            4. 其余 → worker

        刻意不返回 fanout / operator：
            fanout 要求「N 个互不依赖的子任务」，关键词启发式判不出子任务边界——
                   必须调用方显式 --mode fanout --sub … 声明拆法。
            operator 判的是「命令」不是「任务」，归 check_should_dispatch。

        返回:
            {
                "mode": "worker" | "think" | "plan",
                "plan_only": bool,
                "deliverable": "judgment" | "artifact",
                "structure": "multi_step" | "single_step",
                "reason": str,
                "signals": {"judgment": [...], "artifact": [...],
                            "plan": [...], "direct": [...], "plan_only": [...]},
            }
        """
        text = request or ""

        def _hits(kws) -> list[str]:
            return [k for k in kws if k in text]

        judgment = _hits(JUDGMENT_KEYWORDS)
        artifact = _hits(ARTIFACT_KEYWORDS)
        plan_kw = _hits(PLAN_KEYWORDS)
        direct_kw = _hits(DIRECT_KEYWORDS)
        plan_only_kw = _hits(PLAN_ONLY_KEYWORDS)
        signals = {
            "judgment": judgment, "artifact": artifact,
            "plan": plan_kw, "direct": direct_kw, "plan_only": plan_only_kw,
        }

        # 结构维度：沿用 should_plan 的强否逻辑——只命中 DIRECT 不命中 PLAN 视为单步
        multi_step = bool(plan_kw) and not (direct_kw and not plan_kw)
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
            return {
                "mode": "plan", "plan_only": False,
                "deliverable": "artifact", "structure": "multi_step",
                "reason": f"交付物是东西且多步有依赖（命中 {plan_kw}）→ Thinker 出计划、Worker 执行",
                "signals": signals,
            }

        # 4) 单步执行
        return {
            "mode": "worker", "plan_only": False,
            "deliverable": "artifact", "structure": "single_step",
            "reason": (
                f"单步可完成、判据明确（命中 {direct_kw or artifact or '无信号，按保守默认'}）→ 直派 Worker"
            ),
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
        return {
            "goal": goal,
            "context": context,
            "steps": steps,
            "constraints": constraints,
            "done_when": done_when,
            "output_path": output_path,
            "valid": valid,
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
        archive = self.finish_room(exec_dispatch, exec_poll.get("status"))
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
            {"room_id": "...", "stand": "Glm5.2", "role": "thinker",
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
                d["archive"] = self.finish_room(d, poll.get("status"))
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

def _inbox_path(task_id: str) -> Path:
    return INBOX_DIR / f"{task_id}.json"


def _processing_path(task_id: str) -> Path:
    return INBOX_DIR / f"{task_id}{PROCESSING_SUFFIX}"


def write_inbox(task_id: str, payload: dict) -> None:
    """把任务结果写入 inbox（供 Hermes 回调汇总读取）"""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    payload["task_id"] = payload.get("task_id", task_id)
    payload["inbox_created_at"] = _now_iso()
    tmp = _inbox_path(task_id).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    tmp.replace(_inbox_path(task_id))
    logger.info("inbox 写入: %s (task=%s)", _inbox_path(task_id), task_id)


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
    task_id: str, summary_hint: str = "", dry_run: bool = False
) -> dict:
    """发送极简触发消息到微信，告知 Hermes 去 inbox 取结果

    dry_run=True 时只拼装不发送（测试用）；默认 False 真发 cc-send 触发消息。
    返回里带 dry_run / stdout / returncode，便于上层落 state、status 可见是否真发——
    避免「dry-run 未真发」误判掩盖真实的 cc-send 失败。
    """
    msg = f"任务 {summary_hint}（{task_id}）完成，Hermes 正在汇总…"

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

    msg_parts = [f"✅ {conclusion}"]
    if files:
        msg_parts.append(f"📄 文件：{files[0] if len(files) == 1 else ', '.join(files[:3])}")
    if bullets:
        msg_parts.append("核心要点：")
        for i, b in enumerate(bullets, 1):
            msg_parts.append(f"{i}. {b}")
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
        )
        # dry_run=True：后台不直接发完整结果（inbox 设计：Hermes 读 inbox 后代发）
        # poll_timeout=0：无限等待，直到 Stand 完成
        res = _run_by_mode(caller, decision, bg_args, 0, dry_run=True)
        result_text = res.get("result_text", "")
        poll_status = res.get("status", "completed")
        room_id = res.get("room_id")
        session_id = res.get("session_id")
        state["work_mode"] = res.get("mode")

        state.update(
            {
                "status": "completed" if poll_status == "completed" else poll_status,
                "result_text": result_text,
                "result_preview": result_text[:500],
                "elapsed": res.get("elapsed"),
                "completed_at": res.get("completed_at") or _now_iso(),
                "room_id": room_id,
                "session_id": session_id,
                "stand_name": res.get("stand_name"),
                "template_id": res.get("template_id"),
                "role": res.get("role"),
                "error": res.get("error"),
                # 注：完整结果不直接发（inbox 设计：Hermes 读 inbox 后由
                # process_inbox_callback 代发）。wechat_relayed/wechat_dry_run 改由下方
                # 触发消息结果决定，避免「dry-run 未真发」误判掩盖真实 cc-send 失败。
            }
        )

        # 异步回调：写 inbox + 发触发消息（不直接发完整结果）
        inbox_payload = {
            "task_id": task_id,
            "room_id": room_id,
            "stand": state.get("stand_name") or spec.get("role") or "?",
            "role": state.get("role") or spec.get("role") or "",
            "status": state.get("status"),
            "result_text": result_text,
            "files": [spec["file"]] if spec.get("file") else [],
            "request_summary": spec.get("summary"),
            "request": spec.get("request", "")[:200],
            "error": state.get("error"),
        }
        write_inbox(task_id, inbox_payload)
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

    # think / worker：单段派发
    res = caller.dispatch_and_relay(
        args.request,
        role=decision["role"],
        room_id=args.room_id,
        template_id=args.template,
        plan_only=decision["plan_only"],
        mode=mode,
        **common,
    )
    return {**res, "mode": mode}


def _cmd_run(args) -> int:
    # --timeout 未显式给时：--wait/--bg 默认 0（无限等到 Stand 完成），普通前台默认 600
    timeout = args.timeout if args.timeout is not None else (
        0 if (getattr(args, "wait", False) or getattr(args, "bg", False)) else 600
    )

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
            "no_relay": args.no_relay,
            "dry_run": args.dry_run,
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
        }
        state = {
            "task_id": task_id,
            "mode": "wait",
            "work_mode": decision["mode"],
            "spec": spec,
            "status": "running",
            "created_at": _now_iso(),
            "pid": os.getpid(),
        }
        _write_state(task_id, state)
        caller = Caller()
        try:
            # dry_run=True：relay_to_wechat 只拼不发——微信回复由 gateway notify 唤醒 Hermes 后自行组织
            res = _run_by_mode(caller, decision, args, timeout, dry_run=True)
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
            state.update({"status": "error", "error": str(e), "completed_at": _now_iso()})
            _write_state(task_id, state)
            print(json.dumps(
                {"mode": "wait", "task_id": task_id, "status": "error", "error": str(e)},
                ensure_ascii=False, indent=2,
            ))
            return 1
        state.update({
            "status": status,
            "result_text": result_text,
            "result_preview": result_text[:500],
            "elapsed": res.get("elapsed"),
            "completed_at": res.get("completed_at") or _now_iso(),
            "room_id": room_id,
            "session_id": session_id,
            "stand_name": res.get("stand_name"),
            "template_id": res.get("template_id"),
            "role": res.get("role"),
            "error": res.get("error"),
        })
        _write_state(task_id, state)
        # inbox 与 _bg_worker 同构：Hermes 醒来后凭 task_id 读全文（process_inbox_callback 兼容）
        write_inbox(task_id, {
            "task_id": task_id,
            "room_id": room_id,
            "stand": res.get("stand_name") or args.role or "?",
            "role": res.get("role") or args.role or "",
            "status": status,
            "result_text": result_text,
            "files": [args.file] if args.file else [],
            "request_summary": args.summary,
            "request": (args.request or "")[:200],
            "error": res.get("error"),
        })
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
                "inbox_path": str(_inbox_path(task_id)),
                "result_text": out_text,
                "result_truncated": truncated,
                "error": res.get("error"),
            },
            ensure_ascii=False, indent=2,
        ))
        return 0 if status == "completed" else 1

    # ── 前台同步 ──
    caller = Caller()
    fg_dry_run = bool(args.no_relay) or bool(args.dry_run)
    try:
        res = _run_by_mode(caller, decision, args, timeout, dry_run=fg_dry_run)
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
    print(json.dumps({
        "cmd": "go", "mode": mode, "plan_only": plan_only, "summary": summary,
        "route_reason": route_reason[:80],
        "recall": (args.recall or "").strip() or None,
    }, ensure_ascii=False), flush=True)

    if args.dry_run:
        print(json.dumps({"cmd": "go", "status": "dry_run", "dispatched": False,
                          "request_final": dispatched_request[:300]}, ensure_ascii=False))
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
    )
    return _cmd_run(ns)


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
        for p in pending:
            try:
                d = json.loads(p.read_text())
            except Exception as e:
                print(f"── {p.stem}（读取失败: {e}）")
                continue
            status = d.get("status", "?")
            concl = (d.get("request_summary") or "").strip()
            body = (d.get("result_text") or "").strip()
            if not concl:
                concl = next(
                    (l.strip() for l in body.splitlines() if l.strip()), "（无结论）"
                )
            print(f"── {p.stem} [{status}]")
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
            if d.get("error"):
                print(f"⚠️ {str(d.get('error'))[:120]}")
            print(f"   （房间 {d.get('room_id') or '-'} · 全文 {p.name}）")
            if not getattr(args, "keep", False):
                try:
                    p.rename(p.with_name(p.name + DONE_SUFFIX))
                except OSError as e:
                    print(f"   ⚠️ 标记 .done 失败: {e}")
        print(
            f"共 {len(pending)} 条"
            + ("（--keep 未标记，下次仍会出现）" if getattr(args, "keep", False) else "（已标 .done）")
        )
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
    pg.set_defaults(func=_cmd_go)

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
    pi.add_argument("--json", action="store_true", help="结构化输出")
    pi.add_argument("--gc", action="store_true", help=f"清理 {DONE_SUFFIX}（默认干跑）")
    pi.add_argument("--older-than", type=float, default=7, help="配合 --gc：保留最近 N 天（默认 7）")
    pi.add_argument("--unlock", action="store_true", help="解过期 .processing 锁（默认干跑）")
    pi.add_argument("--force", action="store_true", help="配合 --unlock：连未过期的锁一并解")
    pi.add_argument("--yes", action="store_true", help="真执行（--gc / --unlock 默认只干跑）")
    pi.set_defaults(func=_cmd_inbox)

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
