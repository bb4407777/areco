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
from typing import Optional

import requests

logger = logging.getLogger("standcode.caller")

# ── 默认配置 ────────────────────────────────────────────────────────
ARECO_BASE = os.environ.get("ARECO_BASE", "http://127.0.0.1:8790")
ARECO_ROOT = os.environ.get("ARECO_ROOT", str(Path.home() / "Code" / "areco"))
PROJECTS_DB = Path(ARECO_ROOT) / "data" / "projects.db"
REGISTRY_PATH = Path(__file__).resolve().parent.parent / "stand" / "registry.json"

# ── 微信代发配置 ────────────────────────────────────────────────────
CC_SEND_BIN = os.environ.get("CC_SEND_BIN", "/Users/gao/scripts/cc-send.sh")
WECHAT_TARGET = os.environ.get(
    "WECHAT_TARGET",
    "weixin:dm:o9cq802pfYrkgul79flJor4d7uQs@im.wechat",
)
HOME_DIR = os.environ.get("STANDCODE_HOME", "/Users/gao")

# ── 审计日志（Gatekeeper BLOCKED + dispatch / poll 关键节点）─────────
# 每行一条 JSON：{timestamp, event, task_id, role, template, blocked, ...}。
# STANDCODE_AUDIT_LOG 可覆盖路径（测试用 /tmp 之外的隔离）。
AUDIT_LOG_PATH = os.environ.get("STANDCODE_AUDIT_LOG", "/tmp/standcode-audit.jsonl")

# ── 会话可靠性 / 工作区隔离（docs/architecture-optimization.md 建议 4）─────────
# 心跳目录：Caller 只「读」这里的 {session_id}.hb；「写」应由 Stand 宿主进程
# （areco session / wrapper 脚本）负责——只有宿主活着才等于 Stand 活着。
# Caller 进程自写的心跳只证明 Caller 跟踪循环在跑，对「Stand 是否掉线」是假信号
# （详见 _HeartbeatWriter 与 read_heartbeat 的注释）。
HEARTBEAT_DIR = Path(os.environ.get("STANDCODE_HEARTBEAT_DIR", "/tmp/standcode-heartbeat"))
WORKSPACE_DIR = Path(os.environ.get("STANDCODE_WORKSPACE_DIR", "/tmp/standcode-workspaces"))
HEARTBEAT_STALE_SEC = float(os.environ.get("STANDCODE_HEARTBEAT_STALE", "15"))
HEARTBEAT_TICK_SEC = float(os.environ.get("STANDCODE_HEARTBEAT_TICK", "5"))
# 自动重派发默认关闭：会外部 spawn 新房间 + 新 Stand 会话（消耗额度、产生持久状态、
# 不可逆）。须高律师显式开 max_retries>0 才生效，对齐「对外不可逆动作事前确认」。
DEFAULT_MAX_REDISPATCH = 0

# ── 默认模板：完全由 stand/registry.json 驱动 ──────────────────────
# 历史上这里硬编码过 DEFAULT_TEMPLATE_ID="claude" 与 DEFAULT_TASK_MAP（search/coding/
# writing/analysis/general → reasonix）。那套 task_type 与模板 id 与 registry 不一致：
# registry 用 think/plan/execute/work/fast，模板用 stand-thinker-*/stand-worker-*，且
# reasonix 根本不在 registry 模板表里（孤儿）。已改为默认值全部由 Caller._load_registry()
# 从 registry.json 读取，此处不再保留任何业务硬编码默认。
# registry.json 字段映射：
#   default_thinker     → default_thinker_id（Thinker 角色）
#   default_worker      → default_worker_id（Worker 角色 + 全局兜底 default_template_id）
#   task_type_defaults  → task_map（任务类型 → 模板 id）
# registry 文件缺失/解析失败时的紧急兜底见 _load_registry() 顶部局部常量。

# 来自 Caller 自身的身份标识
CALLER_NAME = "Hermes"

# 房间里"非 Stand"的发件人 —— 这些消息不算 Stand 的执行结果：
#   Hermes  = Caller 自己（直写 SQLite 时 from_agent）
#   高律师  = 用户（REST 通道 from 为 "高律师"）
#   all/system = 广播/系统消息
NON_STAND_SENDERS = {CALLER_NAME, "高律师", "all", "system"}

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

# 门控信号词（should_plan 用）：命中 PLAN_KEYWORDS 且未强命中 DIRECT_KEYWORDS → 走两段式
PLAN_KEYWORDS = (
    "调研", "研究", "方案", "设计", "架构", "对比", "规划", "拆解",
    "分几步", "计划", "梳理流程", "可行性", "评估", "多步", "分阶段",
)
DIRECT_KEYWORDS = (
    "总结", "摘要", "翻译", "转格式", "转成", "改成", "找一下", "查找",
    "下载", "生成这份", "套模板", "格式转换", "提取",
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


class GatekeeperBlockedError(RuntimeError):
    """dispatch 因 Gatekeeper BLOCKED 分级拒绝执行时抛出。

    check_should_dispatch 本身是 advisory（只判定、不拦截）；dispatch 对命中 BLOCKED
    的任务硬拒绝——抛本异常并记审计。调用方（_bg_worker 的 try/except、_cmd_run 前台
    专捕）捕获后优雅降级，不破坏既有正常派发流程。
    """


def log_audit(event: str, detail: dict | None = None) -> None:
    """审计日志：每行一条 JSON 追加写入 AUDIT_LOG_PATH（默认 /tmp/standcode-audit.jsonl）。

    固定字段：timestamp / event / task_id / role / template / blocked；
    detail 中的其余字段（reason / room_id / verdict 等）透传追加，便于追溯。
    写入失败只 warning、永不抛——审计不得阻塞主流程。

    参数:
        event:  事件名（如 "dispatch" / "dispatch_blocked" /
                "poll_completed" / "poll_lost" / "poll_timeout"）
        detail: 审计上下文；至少应含 task_id / role / template / blocked，
                其余键原样并入记录。
    """
    d = detail or {}
    record = {
        "timestamp": _now_iso(),
        "event": event,
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
        _FALLBACK_THINKER = "stand-thinker-workbuddy"
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
        """列出所有房间"""
        rooms = self._api_get("/rooms")
        return rooms.get("rooms", [])

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

    def get_room(self, room_id: str) -> dict:
        """获取单个房间详情"""
        rooms = self._api_get("/rooms")
        for r in rooms.get("rooms", []):
            if r["id"] == room_id:
                return r
        raise KeyError(f"房间不存在: {room_id}")

    # ── Stand（成员）管理 ───────────────────────────────────────

    def add_stand(self, room_id: str, template_id: str) -> dict:
        """在房间中添加一个 Stand（worker agent session）
        
        返回成员信息，包含 name（用于发消息时定位）和 sessionId。
        """
        member = self._api_post(f"/rooms/{room_id}/members", {"templateId": template_id})
        logger.info(
            "添加 Stand: room=%s template=%s → name=%s session=%s",
            room_id, template_id, member.get("name"), member.get("sessionId"),
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
        human_relay: 是否按「转述人类原话」投递（默认 True）。Caller 代发任务=转述高律师
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
            return [dict(r) for r in rows]
        except sqlite3.OperationalError:
            return []
        finally:
            conn.close()

    def get_room_messages_rest(self, room_id: str, limit: int = 100) -> list[dict]:
        """通过 REST API 获取房间消息（只读场景用，from 为 '高律师'）"""
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
    ) -> dict:
        """向 Stand 派发任务

        参数:
            request:    任务描述（自然语言）
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
                        ⚠️ 当前仅「准备目录 + 回填 workspace_cwd 到结果」，并不真正
                        把 Stand 的 cwd 改过去——areco addMember 只收 {templateId}
                        （rooms.ts:113），cwd 来自模板（固定 /Users/gao），Caller 无权
                        覆盖。需 areco 支持 per-session cwd 后才能落地（见 prepare_workspace）。
                        默认 False，行为与改动前完全一致。
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

        # 2. 创建或使用已有房间
        if room_id:
            room = self.get_room(room_id)
        else:
            room = self.create_room(
                f"Stand-{effective_role}-{effective_task_type}-{uuid.uuid4().hex[:6]}"
            )

        team = room["team"]
        rid = room["id"]

        # 3. 添加 Stand（agent session）
        member = self.add_stand(rid, tid)
        stand_name = member["name"]
        stand_session_id = member.get("sessionId", "")

        # 4. 等待片刻让 session 启动（TUI boot）
        time.sleep(3)

        # 5. 向房间发送任务消息（直写 SQLite）
        msg_id = self.send_message(team, stand_name, request)

        result = {
            "task_id": task_id,
            "session_id": team,
            "room_id": rid,
            "room_name": room.get("name", ""),
            "stand_name": stand_name,
            "stand_session_id": stand_session_id,
            "message_id": msg_id,
            "task_type": effective_task_type,
            "template_id": tid,
            "role": effective_role,
            "workspace": (workspace_info or {}).get("path"),
            "workspace_cwd": bool((workspace_info or {}).get("applied", False)),
        }
        log_audit("dispatch", {
            "task_id": task_id,
            "role": effective_role,
            "template": tid,
            "blocked": False,
            "task_type": effective_task_type,
            "room_id": rid,
            "stand_name": stand_name,
        })
        logger.info(
            "派发任务: session=%s room=%s stand=%s role=%s task_type=%s tid=%s",
            team, rid, stand_name, effective_role, effective_task_type, tid,
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
    ) -> dict:
        """派给 Thinker（registry.default_thinker）：规划、分析、判断、路由

        plan_only=True 时强制「只规划不执行」：把 request 包进 PLAN_TEMPLATE，
        要求 Thinker 按「目标/上下文/步骤/约束/判据/落点」结构化产出可执行计划，
        供 Worker（registry.default_worker）直接执行。用于 plan_and_execute 的 Thinker 阶段。
        """
        if plan_only:
            request = PLAN_TEMPLATE.format(request=request)
        return self.dispatch(
            request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role="thinker",
        )

    def dispatch_worker(
        self,
        request: str,
        task_type: str | None = None,
        room_id: str | None = None,
        template_id: str | None = None,
    ) -> dict:
        """派给 Worker（registry.default_worker）：代码、搜索、文书、下载、总结"""
        return self.dispatch(
            request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role="worker",
        )

    def poll_result(
        self,
        room_id: str | None = None,
        session_id: str | None = None,
        timeout: int = 600,
        poll_interval: float = 1.0,
        stand_session_id: str | None = None,
        after_id: int = 0,
        *,
        task_id: str = "",
        role: str = "",
        template: str = "",
    ) -> dict:
        """轮询 Stand 执行结果（Caller 主动拉，不依赖 Stand 自汇报 cc-send）

        参数:
            room_id:  房间短 ID（REST 兜底/日志用；可为 None）
            session_id: dispatch() 返回的 session_id（房间 team 名，如 "room-xxxx"）。必填。
            timeout:  最大等待秒数（默认 600）；<=0 表示无限等待，直到 Stand 完成/失联
            poll_interval: 轮询间隔
            stand_session_id: Stand 的 areco session ID（可选，检测 Stand 提前退出）
            after_id: 只看 id>此值的消息（续跑场景）
            task_id/role/template: 仅用于审计日志（log_audit），由上层 dispatch 结果透传；
                缺省空串——审计仍写，只是 task_id 一列留空。

        返回:
            {
                "session_id": str,
                "room_id": str | None,
                "status": "completed" | "timeout" | "error",
                "result_text": str,         # Stand 回复合并文本（completed 才有）
                "stand_replies": [...],     # 仅 Stand 的回复（排除 Hermes/高律师）
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
                sender = msg.get("from_agent", "")
                # 非 Caller、非高律师 = Stand 的回复
                if sender and sender not in NON_STAND_SENDERS:
                    stand_replies.append(msg)

            if stand_replies:
                # 收到首条 Stand 回复后再等一小段，合并可能的后续增量
                time.sleep(3)
                try:
                    tail = self.get_messages(session_id, after_id=last_id)
                    for msg in tail:
                        last_id = max(last_id, msg.get("id", 0))
                        sender = msg.get("from_agent", "")
                        if sender and sender not in NON_STAND_SENDERS:
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

        返回 {path, kind, applied}。applied 恒为 False：Caller 无权把 Stand 的 cwd 切到
        此目录（areco addMember 只收 templateId，cwd 来自模板固定 /Users/gao）。真正落地
        需 areco 支持 per-session cwd（见 docs/architecture-optimization.md 技术依赖）。
        所以这里只「准备目录 + 回填路径」，不改 Stand 行为。
        """
        ws = WORKSPACE_DIR / task_id
        kind = "empty"
        try:
            if source_repo:
                # 真 worktree：基于 source_repo 建独立工作树，新分支名 stand-<task_id>
                ws.parent.mkdir(parents=True, exist_ok=True)
                branch = f"stand-{task_id}"
                subprocess.run(
                    ["git", "-C", source_repo, "worktree", "add", "-b", branch,
                     str(ws)],
                    capture_output=True, text=True, timeout=30,
                )
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
        timeout: int = 300,
        max_retries: int = DEFAULT_MAX_REDISPATCH,
    ) -> dict:
        """派发并等待结果（dispatch + poll_result 一站式）。

        max_retries: Stand 失联（status='lost'）时自动重新派发到新 Stand 的次数上限。
            默认 0（关）——与改动前完全一致；重派发会外部 spawn 新房间+会话，属不可逆
            动作，须高律师显式开 >0 才生效。仅对 'lost' 重试，'timeout'/'error' 不重试
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
    ) -> dict:
        """把 Stand 结果代发到微信（Caller 主动回执，不依赖 Stand 自汇报）

        调用 cc-send.sh -s <target> -m "<内容>"，纯文字消息不经 .ok gate。
        微信消息格式：一句话结论 + 文件路径 + 核心要点 3-5 条。

        参数:
            message:   Stand 结果正文（poll_result['result_text']）
            summary:   一句话结论；None 时从正文自动提炼首行
            file_path: 产物文件路径（可选）
            dry_run:   True=只拼装不发送（测试用）

        返回:
            {"ok": bool, "dry_run": bool, "content": str,
             "stdout": str, "returncode": int, "error"?: str}
        """
        content = self._format_wechat(message, summary=summary, file_path=file_path)

        if dry_run:
            logger.info("[dry-run] 微信代发内容（未发送）:\n%s", content)
            return {
                "ok": True,
                "dry_run": True,
                "content": content,
                "stdout": "",
                "returncode": 0,
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
    ) -> dict:
        """一键派发 → 主动轮询 → 代发微信

        参数:
            request:         任务描述
            task_type:        任务类型
            request_summary: 一句话结论（代发微信用）；None 时从结果正文自动提炼
            role:             'thinker' | 'worker' | None（按角色选默认模板）
            room_id/template_id/file_path/poll_timeout/dry_run: 见 dispatch/poll_result/relay_to_wechat

        返回: dispatch() + poll_result() + {relay_summary, wechat, relayed}
        """
        dispatch_result = self.dispatch(
            request=request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
            role=role,
        )
        poll = self.poll_result(
            room_id=dispatch_result["room_id"],
            session_id=dispatch_result["session_id"],
            stand_session_id=dispatch_result.get("stand_session_id"),
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

        return {
            **dispatch_result,
            **poll,
            "relay_summary": request_summary,
            "wechat": wechat,
            "relayed": relayed,
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
    ) -> dict:
        """任务含规划需求时：Caller 先派 Thinker 做计划，再把计划交给 Worker 执行

        流程:
            1. Thinker（registry.default_thinker）拆解任务、产出可执行计划（不直接动手）
            2. Worker（registry.default_worker）按计划执行，产出结果
            3. 结果代发微信（dry_run 时只拼不发）

        返回:
            {
                "stage": "execute" | "plan_failed",
                "plan": {...},        # Thinker 的 dispatch+poll
                "execute": {...},     # Worker 的 dispatch+poll
                "plan_text": str,
                "result_text": str,   # Worker 最终结果
                "wechat": {...}, "relayed": bool,
            }
        """
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
            timeout=poll_timeout,
            task_id=plan_dispatch.get("task_id", ""),
            role=plan_dispatch.get("role", ""),
            template=plan_dispatch.get("template_id", ""),
        )
        plan_text = plan_poll.get("result_text", "")
        if not plan_text:
            logger.warning("Thinker 未产出计划，跳过执行阶段")
            return {
                "stage": "plan_failed",
                "plan": {**plan_dispatch, **plan_poll},
                "execute": {},
                "plan_text": "",
                "plan_parsed": {"valid": False},
                "result_text": "",
                "wechat": None,
                "relayed": False,
                "error": plan_poll.get("error", "Thinker 未产出计划"),
            }
        # 结构化校验：plan 必须含「步骤」段，否则视为不合格，不喂 Worker
        plan = self._parse_plan(plan_text)
        if not plan["valid"]:
            logger.warning("Thinker 计划未通过结构化校验（缺步骤段）: %s", plan)
            return {
                "stage": "plan_failed",
                "plan": {**plan_dispatch, **plan_poll},
                "execute": {},
                "plan_text": plan_text,
                "plan_parsed": plan,
                "result_text": "",
                "wechat": None,
                "relayed": False,
                "error": "Thinker 计划未通过结构化校验（缺步骤段）",
            }

        # 2. Worker（registry.default_worker）严格按计划执行：只执行不决策
        exec_request = (
            "请严格按以下计划执行并交付结果。你是 Worker，只执行不决策——"
            "不要重新规划，照步骤做；遇阻在结果里说明，不要擅自改方案。\n\n"
            "【计划】\n" + plan_text + "\n\n【原始任务】\n" + request
        )
        if plan.get("done_when"):
            exec_request += "\n\n【完成判据】\n" + plan["done_when"]
        exec_dispatch = self.dispatch_worker(exec_request, task_type=task_type)
        exec_poll = self.poll_result(
            room_id=exec_dispatch["room_id"],
            session_id=exec_dispatch["session_id"],
            stand_session_id=exec_dispatch.get("stand_session_id"),
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

        return {
            "stage": "execute",
            "plan": {**plan_dispatch, **plan_poll},
            "execute": {**exec_dispatch, **exec_poll},
            "plan_text": plan_text,
            "plan_parsed": plan,
            "result_text": result_text,
            "wechat": wechat,
            "relayed": relayed,
        }

    # ── 严格分工辅助：门控 / plan 解析 / 自动选路 ─────────────────

    @staticmethod
    def should_plan(request: str) -> bool:
        """门控：判断任务是否需要走两段式（Thinker→plan→Worker）。

        规划价值高的任务（多步/取舍/探索/工程预估）→ True，简单执行型 → False。
        启发式：命中 PLAN_KEYWORDS 且未强命中 DIRECT_KEYWORDS → True。
        Caller 可据此自动选 dispatch_worker vs plan_and_execute。
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
        return {
            "mode": "direct",
            **exec_dispatch,
            **exec_poll,
            "result_text": result_text,
            "wechat": wechat,
            "relayed": relayed,
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
                )
                poll = self.poll_result(
                    room_id=d.get("room_id"),
                    session_id=d["session_id"],
                    stand_session_id=d.get("stand_session_id"),
                    timeout=poll_timeout,
                    poll_interval=poll_interval,
                    task_id=d.get("task_id", ""),
                    role=d.get("role", ""),
                    template=d.get("template_id", ""),
                )
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
) -> dict:
    """代发微信（创建临时 Caller 实例）"""
    caller = Caller()
    return caller.relay_to_wechat(
        message, summary=summary, file_path=file_path, dry_run=dry_run
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
    os.environ.get("STANDCODE_TASKS_DIR", str(Path.home() / ".standcode" / "tasks"))
)

# ── 异步回调 inbox ────────────────────────────────────────────────────
INBOX_DIR = Path(
    __file__).resolve().parent.parent / "data" / "inbox"
PROCESSING_SUFFIX = ".processing"


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
    """尝试获取 .processing 锁，成功返回 True，失败（已有他人处理中）返回 False"""
    pp = _processing_path(task_id)
    if pp.exists():
        return False
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    try:
        pp.write_text(_now_iso())
        return True
    except Exception as e:
        logger.warning("获取 .processing 锁失败 %s: %s", pp, e)
        return False


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

        # 4. 发回微信（传文件路径以便 relay_to_wechat 格式化为 📄 文件行）
        files = payload.get("files") or payload.get("file", [])
        if isinstance(files, str):
            files = [files]
        file_path = files[0] if files else None
        r = relay_to_wechat(
            summary,
            summary=payload.get("request_summary"),
            file_path=file_path,
        )
        ok = r.get("ok", False)
        msg = summary

        # 5. 清理 inbox
        delete_inbox(task_id)

        return {"ok": ok, "task_id": task_id, "message": msg, "action": "relayed"}
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
    # 拉模式（2026-07-25 高律师定）：spec.dry_run 不再影响任何发送——触发消息链已废除
    # （下方两处 send_callback_trigger 恒 dry_run=True 只拼不发），结果只落 inbox 等 Hermes 拉取。
    caller = Caller()
    state["status"] = "running"
    _write_state(task_id, state)
    try:
        if spec.get("plan"):
            res = caller.plan_and_execute(
                spec.get("request", ""),
                task_type=spec.get("task_type") or "general",
                request_summary=spec.get("summary"),
                file_path=spec.get("file"),
                poll_timeout=0,  # 0 = 无限等待，直到 Stand 完成
                dry_run=True,  # 后台不直接发完整结果（inbox 设计：Hermes 读 inbox 后代发）
            )
            exe = res.get("execute", {}) or {}
            result_text = res.get("result_text") or exe.get("result_text", "")
            poll_status = exe.get("status", "completed")
            room_id = exe.get("room_id")
            session_id = exe.get("session_id")
        else:
            res = caller.dispatch_and_relay(
                spec.get("request", ""),
                task_type=spec.get("task_type") or "general",
                request_summary=spec.get("summary"),
                role=spec.get("role"),
                room_id=spec.get("room_id"),
                template_id=spec.get("template"),
                file_path=spec.get("file"),
                poll_timeout=0,  # 0 = 无限等待，直到 Stand 完成
                dry_run=True,  # 后台不直接发完整结果 → 转 inbox + 触发消息
            )
            result_text = res.get("result_text", "")
            poll_status = res.get("status", "completed")
            room_id = res.get("room_id")
            session_id = res.get("session_id")

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
        # 拉模式（2026-07-25 高律师定）：触发消息链废除，恒 dry_run=True 只拼不发——
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


def _cmd_run(args) -> int:
    # 兜底扫描入口：scripts/room-inbox-sync.py（cron/常驻每 60s 扫漏写 inbox 的 room，补写 + 发房间内触发）
    # --timeout 未显式给时：--wait/--bg 默认 0（无限等到 Stand 完成），普通前台默认 600
    timeout = args.timeout if args.timeout is not None else (
        0 if (getattr(args, "wait", False) or getattr(args, "bg", False)) else 600
    )
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
        }
        state = {
            "task_id": task_id,
            "mode": "wait",
            "spec": spec,
            "status": "running",
            "created_at": _now_iso(),
            "pid": os.getpid(),
        }
        _write_state(task_id, state)
        caller = Caller()
        try:
            # dry_run=True：relay_to_wechat 只拼不发——微信回复由 gateway notify 唤醒 Hermes 后自行组织
            if args.plan:
                res = caller.plan_and_execute(
                    args.request, task_type=args.task_type, request_summary=args.summary,
                    file_path=args.file, poll_timeout=timeout, dry_run=True,
                )
                exe = res.get("execute", {}) or {}
                result_text = res.get("result_text") or exe.get("result_text", "")
                status = exe.get("status", res.get("status", "completed"))
                room_id = exe.get("room_id") or res.get("room_id")
                session_id = exe.get("session_id") or res.get("session_id")
            else:
                res = caller.dispatch_and_relay(
                    args.request, task_type=args.task_type, request_summary=args.summary,
                    role=args.role, room_id=args.room_id, template_id=args.template,
                    file_path=args.file, poll_timeout=timeout, dry_run=True,
                )
                result_text = res.get("result_text", "")
                status = res.get("status", "completed")
                room_id = res.get("room_id")
                session_id = res.get("session_id")
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
        print(json.dumps(
            {
                "mode": "wait",
                "task_id": task_id,
                "room_id": room_id,
                "session_id": session_id,
                "stand_name": res.get("stand_name"),
                "template_id": res.get("template_id"),
                "role": res.get("role"),
                "status": status,
                "elapsed": res.get("elapsed"),
                "completed_at": res.get("completed_at"),
                "inbox_path": str(_inbox_path(task_id)),
                "result_text": result_text,
                "error": res.get("error"),
            },
            ensure_ascii=False, indent=2,
        ))
        return 0 if status == "completed" else 1

    # ── 前台同步 ──
    caller = Caller()
    fg_dry_run = bool(args.no_relay) or bool(args.dry_run)
    try:
        if args.plan:
            res = caller.plan_and_execute(
                args.request, task_type=args.task_type, request_summary=args.summary,
                file_path=args.file, poll_timeout=timeout, dry_run=fg_dry_run,
            )
        else:
            res = caller.dispatch_and_relay(
                args.request, task_type=args.task_type, request_summary=args.summary,
                role=args.role, room_id=args.room_id, template_id=args.template,
                file_path=args.file, poll_timeout=timeout, dry_run=fg_dry_run,
            )
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
            "task_id": res.get("task_id"),
            "room_id": res.get("room_id"),
            "session_id": res.get("session_id"),
            "stand_name": res.get("stand_name"),
            "template_id": res.get("template_id"),
            "role": res.get("role"),
            "status": res.get("status"),
            "elapsed": res.get("elapsed"),
            "completed_at": res.get("completed_at"),
            "relayed": res.get("relayed"),
            "error": res.get("error"),
            "result_preview": (res.get("result_text") or "")[:500],
        },
        ensure_ascii=False, indent=2,
    ))
    return 0 if res.get("status") == "completed" else 1


def _cmd_check(args) -> int:
    """Gatekeeper CLI：核查一个任务 / 命令是否必须派发（check_should_dispatch）"""
    verdict = check_should_dispatch(args.task)
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    # 退出码恒 0：Hermes 直接读 json 的 should_dispatch 字段分流，无需按退出码判断。
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
    pr.add_argument("--plan", action="store_true", help="两段式：Thinker 出计划 → Worker 执行")
    pr.set_defaults(func=_cmd_run)

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
