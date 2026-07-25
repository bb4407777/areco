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
import sqlite3
import subprocess
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

# 任务类型 → 模板 ID 映射（从 registry 加载，此处为兜底默认值）
# 所有 worker 类任务（search/coding/writing/analysis/general）默认走 Worker = reasonix
#   （= Reasonix QClaw DeepSeek-v4-flash，与 registry default_worker 一致）
# 备选 Worker（需 --template 显式指定）：claude(GLM-5.2) / workbuddy-deepseek / codex
# Thinker 默认 claude（default_thinker_id，走 --role thinker 或 dispatch_thinker）
DEFAULT_TEMPLATE_ID = "claude"
DEFAULT_TASK_MAP = {
    "search": "reasonix",
    "coding": "reasonix",
    "writing": "reasonix",
    "analysis": "reasonix",
    "general": "reasonix",
}

# 来自 Caller 自身的身份标识
CALLER_NAME = "Hermes"

# 房间里"非 Stand"的发件人 —— 这些消息不算 Stand 的执行结果：
#   Hermes  = Caller 自己（直写 SQLite 时 from_agent）
#   高律师  = 用户（REST 通道 from 为 "高律师"）
#   all/system = 广播/系统消息
NON_STAND_SENDERS = {CALLER_NAME, "高律师", "all", "system"}

# ── Thinker/Worker 严格分工：结构化 plan 模板 + 门控 ──────────────
# plan 模板：强制 Thinker 按「目标/上下文/步骤/约束/判据/落点」结构化输出，
# Worker（默认 Reasonix）拿到即可执行、不必再「理解意图」。三属性：结构化/自包含/有判据。
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

        # 加载注册表
        self.task_map: dict[str, str] = dict(DEFAULT_TASK_MAP)
        self.registry: dict = {}
        self.default_template_id: str = DEFAULT_TEMPLATE_ID
        self.default_thinker_id: str = DEFAULT_TEMPLATE_ID
        self.default_worker_id: str = DEFAULT_TEMPLATE_ID
        self.template_names: dict[str, str] = {}
        self.roles: dict[str, str] = {}  # template_id → "thinker" | "worker"
        self._load_registry()

    # ── 注册表加载 ──────────────────────────────────────────────

    def _load_registry(self) -> None:
        """从 registry.json 加载模板映射和元信息

        兼容两种 registry 格式：
          - 旧：{"task_type_defaults": {<type>: {"template_id": ...}}}
          - 新：{"default_template": "claude", "templates": [{"id","name","task_types"}]}

        新格式下 default_template 作为兜底默认；templates 的 task_types 仅作元信息存档，
        不反向覆盖 task_map —— 以保留 DEFAULT_TASK_MAP 里的专家分派
        （search→kimi / coding→codex / analysis→reasonix）。
        """
        if not self.registry_path.exists():
            logger.warning("注册表不存在 %s，使用默认映射", self.registry_path)
            return
        try:
            data = json.loads(self.registry_path.read_text())
            self.registry = data
            # 新格式：default_template
            if data.get("default_template"):
                self.default_template_id = data["default_template"]
                self.task_map.setdefault("general", self.default_template_id)
            # 角色默认（Caller/Thinker/Worker 层级）
            self.default_thinker_id = (
                data.get("default_thinker") or self.default_template_id
            )
            self.default_worker_id = (
                data.get("default_worker") or self.default_template_id
            )
            # 旧格式：task_type_defaults
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
        except Exception as e:
            logger.warning("加载注册表失败: %s，使用默认映射", e)

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
    ) -> dict:
        """向 Stand 派发任务

        参数:
            request:    任务描述（自然语言）
            task_type:  任务类型（search/coding/writing/analysis/general）；None=不按类型分派
            room_id:    指定房间（None=新建）
            template_id: 指定模板（None=自动选择）
            role:       角色分派：'thinker' | 'worker' | None
                        - 'thinker' → default_thinker（默认 claude / GLM-5.2）
                        - 'worker'  → default_worker （默认 reasonix / DeepSeek-v4-flash）
                        优先级：template_id > task_type 映射 > role 默认 > default_template

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
            }
        """
        # 1. 确定模板 ID（template_id > 显式 role > task_type 映射 > 全局默认）
        #    role 优先于 task_type：dispatch_thinker/worker 的角色意图必须胜过 task_type
        #    的通用映射——否则 task_type="general"→reasonix 会把 Thinker 顶成 Worker。
        if template_id:
            tid = template_id
        elif role == "thinker":
            tid = self.default_thinker_id
        elif role == "worker":
            tid = self.default_worker_id
        elif task_type and self.task_map.get(task_type):
            tid = self.task_map[task_type]
        else:
            tid = self.default_template_id or DEFAULT_TEMPLATE_ID
        task_id = f"task-{uuid.uuid4().hex[:12]}"
        effective_task_type = task_type or "general"
        effective_role = role or self.roles.get(tid, "worker")

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
        }
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
        """派给 Thinker（默认 GLM-5.2）：规划、分析、判断、路由

        plan_only=True 时强制「只规划不执行」：把 request 包进 PLAN_TEMPLATE，
        要求 Thinker 按「目标/上下文/步骤/约束/判据/落点」结构化产出可执行计划，
        供 Worker（默认 Reasonix）直接执行。用于 plan_and_execute 的 Thinker 阶段。
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
        """派给 Worker（默认 Reasonix / DeepSeek-v4-flash）：代码、搜索、文书、下载、总结"""
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
    ) -> dict:
        """轮询 Stand 执行结果（Caller 主动拉，不依赖 Stand 自汇报 cc-send）

        参数:
            room_id:  房间短 ID（REST 兜底/日志用；可为 None）
            session_id: dispatch() 返回的 session_id（房间 team 名，如 "room-xxxx"）。必填。
            timeout:  最大等待秒数（默认 600）
            poll_interval: 轮询间隔
            stand_session_id: Stand 的 areco session ID（可选，检测 Stand 提前退出）
            after_id: 只看 id>此值的消息（续跑场景）

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

        while time.time() < deadline:
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

            # 2) 还没收到回复 —— best-effort 检测 Stand 是否已提前退出
            #    （Stand 会话经常退出前没回执，这里避免空等满 timeout）
            if stand_session_id and time.time() - last_status_check > 10:
                last_status_check = time.time()
                status = self._session_status(stand_session_id)
                if status == "exited":
                    elapsed = round(time.time() - start_time, 2)
                    logger.warning(
                        "Stand 会话已退出但无回复: session=%s stand=%s",
                        session_id, stand_session_id,
                    )
                    return {
                        "session_id": session_id,
                        "room_id": room_id,
                        "status": "error",
                        "result_text": "",
                        "stand_replies": [],
                        "elapsed": elapsed,
                        "completed_at": None,
                        "messages_count": last_id,
                        "error": f"Stand 会话已退出（{stand_session_id}）但未产生回复",
                    }

            time.sleep(poll_interval)

        elapsed = round(time.time() - start_time, 2)
        logger.warning("轮询超时: session=%s timeout=%ds", session_id, timeout)
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

    # ── 综合便捷方法 ────────────────────────────────────────────

    def dispatch_and_wait(
        self,
        request: str,
        task_type: str = "general",
        room_id: str | None = None,
        template_id: str | None = None,
        timeout: int = 300,
    ) -> dict:
        """派发并等待结果（dispatch + poll_result 一站式）"""
        dispatch_result = self.dispatch(
            request=request,
            task_type=task_type,
            room_id=room_id,
            template_id=template_id,
        )
        poll_result = self.poll_result(
            session_id=dispatch_result["session_id"],
            timeout=timeout,
        )
        return {**dispatch_result, **poll_result}

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
            1. Thinker（GLM-5.2）拆解任务、产出可执行计划（不直接动手）
            2. Worker（Reasonix）按计划执行，产出结果
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

        # 2. Worker（默认 Reasonix）严格按计划执行：只执行不决策
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
    """派给 Thinker（默认 GLM-5.2）：规划/分析/判断/路由"""
    caller = Caller()
    return caller.dispatch_thinker(request, task_type=task_type, **kwargs)


def dispatch_worker(request: str, task_type: str | None = None, **kwargs) -> dict:
    """派给 Worker（默认 Reasonix / DeepSeek-v4-flash）：执行型任务"""
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


def send_callback_trigger(task_id: str, summary_hint: str = "") -> dict:
    """发送极简触发消息到微信，告知 Hermes 去 inbox 取结果"""
    status_hint = f"（{summary_hint}）" if summary_hint else ""
    msg = f"任务 {task_id} 完成，Hermes 正在汇总{status_hint}…"
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
        logger.info("回调触发消息已发: task=%s ok=%s", task_id, ok)
        return {"ok": ok, "task_id": task_id, "message": msg}
    except Exception as e:
        logger.warning("回调触发消息发送失败: %s", e)
        return {"ok": False, "task_id": task_id, "error": str(e)}


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
                poll_timeout=spec.get("timeout", 600),
                dry_run=True,  # 后台不直接发完整结果
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
                poll_timeout=spec.get("timeout", 600),
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
                "wechat_relayed": bool(res.get("relayed")),
                "wechat_dry_run": (res.get("wechat") or {}).get("dry_run", False),
                "error": res.get("error"),
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
        send_callback_trigger(task_id, summary_hint="后台任务完成")
        state["callback_triggered"] = True
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
            send_callback_trigger(task_id, summary_hint="异常")
            state["callback_triggered"] = True
            state["wechat_relayed_error"] = True
        except Exception:
            pass
    _write_state(task_id, state)
    return 0 if state.get("status") == "completed" else 1


def _cmd_run(args) -> int:
    # ── 后台 ──
    if getattr(args, "bg", False):
        task_id = _new_bg_task_id()
        spec = {
            "request": args.request,
            "task_type": args.task_type,
            "role": args.role,
            "template": args.template,
            "room_id": args.room_id,
            "summary": args.summary,
            "file": args.file,
            "timeout": args.timeout,
            "plan": args.plan,
            "no_relay": args.no_relay,
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

    # ── 前台同步 ──
    caller = Caller()
    if args.plan:
        res = caller.plan_and_execute(
            args.request, task_type=args.task_type, request_summary=args.summary,
            file_path=args.file, poll_timeout=args.timeout, dry_run=bool(args.no_relay),
        )
    else:
        res = caller.dispatch_and_relay(
            args.request, task_type=args.task_type, request_summary=args.summary,
            role=args.role, room_id=args.room_id, template_id=args.template,
            file_path=args.file, poll_timeout=args.timeout, dry_run=bool(args.no_relay),
        )
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

    pr = sub.add_parser("run", help="派发+主动轮询+代发微信（默认前台；--bg 后台）")
    pr.add_argument("request", help="任务描述")
    pr.add_argument("--bg", "--background", dest="bg", action="store_true",
                    help="后台运行（立刻返回 task_id，caller 自己轮询并回微信）")
    pr.add_argument("--task-type", default="general", help="任务类型（默认 general）")
    pr.add_argument("--role", choices=["thinker", "worker"], default=None, help="角色分派")
    pr.add_argument("--template", default=None, help="指定模板 id")
    pr.add_argument("--room-id", default=None, help="复用现有房间")
    pr.add_argument("--summary", default=None, help="一句话结论（代发微信用）")
    pr.add_argument("--file", "--file-path", dest="file", default=None, help="产物文件路径")
    pr.add_argument("--timeout", type=int, default=600, help="轮询超时秒数（默认 600）")
    pr.add_argument("--no-relay", action="store_true", help="不代发微信，只取结果")
    pr.add_argument("--plan", action="store_true", help="两段式：Thinker 出计划 → Worker 执行")
    pr.set_defaults(func=_cmd_run)

    ps = sub.add_parser("status", help="查看后台任务状态/结果")
    ps.add_argument("task_id", help="任务 id")
    ps.add_argument("--json", action="store_true", help="输出原始 json")
    ps.set_defaults(func=_cmd_status)

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
