"""Areco 语音输入 sidecar：浏览器 PCM 上行 → Silero VAD 分段 → 豆包流式 ASR。

协议（WebSocket /asr）：
  客户端 → 服务端   {"type":"start"} / {"type":"stop"} + 1024 字节 PCM16LE 16k 二进制帧
  服务端 → 客户端   {"type":"partial","text":...} / {"type":"final","text":...}
                    / {"type":"error","message":...}

只回环监听，鉴权与转发由 areco Node 服务代理。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path

from aiohttp import WSMsgType, web

from .vad import FRAME_BYTES, Segmenter, new_vad

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("areco.asr")

DEFAULT_CREDENTIAL = Path("~/.config/doubao-asr/credentials.json").expanduser()


class DoubaoASR:
    """豆包输入法流式 ASR：一个话轮一条 WebSocket，帧进、中间/最终结果出。"""

    def __init__(self, credential_path: Path = DEFAULT_CREDENTIAL):
        self.credential_path = credential_path
        self._config = None
        self._available = False
        self._queue: asyncio.Queue | None = None
        self._future: asyncio.Future | None = None
        self._task: asyncio.Task | None = None
        self._partial = ""

    def load(self) -> bool:
        try:
            from doubaoime_asr import ASRConfig

            self._config = ASRConfig(credential_path=str(self.credential_path))
            self._available = True
            logger.info("豆包流式 ASR ready")
            return True
        except Exception as exc:  # 依赖缺失或凭证不可读
            logger.warning("豆包 ASR 初始化失败：%s", exc)
            return False

    @property
    def available(self) -> bool:
        return self._available

    def start_turn(self) -> None:
        if not self._available:
            return
        loop = asyncio.get_event_loop()
        self._queue = asyncio.Queue()
        self._future = loop.create_future()
        self._partial = ""
        self._task = loop.create_task(self._run(self._queue, self._future))

    async def _run(self, queue: asyncio.Queue, future: asyncio.Future) -> None:
        from doubaoime_asr import transcribe_realtime

        async def pcm_gen():
            while True:
                chunk = await queue.get()
                if chunk is None:
                    return
                yield chunk

        final_text = ""
        try:
            async for resp in transcribe_realtime(pcm_gen(), config=self._config):
                kind = resp.type.name
                if kind == "INTERIM_RESULT":
                    self._partial = resp.text
                elif kind == "FINAL_RESULT":
                    final_text = resp.text
                elif kind == "ERROR":
                    logger.warning("豆包 ASR 错误：%s", resp.error_msg)
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("豆包 ASR 会话异常：%s", exc)
        finally:
            if not future.done():
                future.set_result(final_text)

    def feed(self, pcm: bytes) -> str:
        if not self._available or self._queue is None:
            return ""
        self._queue.put_nowait(pcm)
        return self._partial

    async def finish(self) -> str:
        if not self._available or self._queue is None:
            return ""
        self._queue.put_nowait(None)
        text = ""
        if self._future:
            try:
                text = (await asyncio.wait_for(self._future, timeout=8.0)).strip()
            except asyncio.TimeoutError:
                text = self._partial.strip()
        return text

    def reset(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self._queue = None
        self._future = None
        self._partial = ""


class AsrConnection:
    def __init__(self, ws: web.WebSocketResponse, asr: DoubaoASR):
        self.ws = ws
        self.asr = asr
        self.segmenter = Segmenter(new_vad())
        self.active = False
        self.finishing = False
        self.backlog: list[bytes] = []
        self.last_partial = ""

    async def send(self, **payload) -> None:
        if not self.ws.closed:
            await self.ws.send_str(json.dumps(payload, ensure_ascii=False))

    async def on_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        kind = msg.get("type") if isinstance(msg, dict) else None
        if kind == "start":
            self.active = True
            self.segmenter.reset()
            await self.send(type="ready")
        elif kind == "stop":
            if self.segmenter.in_speech:
                self.backlog.clear()
                await self.finalize()
            self.active = False

    async def on_frame(self, pcm: bytes) -> None:
        if not self.active or len(pcm) != FRAME_BYTES:
            return
        if self.finishing:
            self.backlog.append(pcm)
            return

        ev = self.segmenter.feed(pcm)
        if ev and ev[0] == "start":
            self.asr.reset()
            self.asr.start_turn()
            for frame in self.segmenter.buf:  # pre-roll 一次性补喂
                self.asr.feed(frame)
        elif self.segmenter.in_speech:
            partial = self.asr.feed(pcm)
            if partial and partial != self.last_partial:
                self.last_partial = partial
                await self.send(type="partial", text=partial)

        if ev and ev[0] == "end" and ev[1]:
            self.asr.feed(b"\x00" * FRAME_BYTES)  # 补一帧静音促 flush
            await self.finalize()

    async def finalize(self) -> None:
        if self.finishing:
            return
        self.finishing = True
        try:
            text = await self.asr.finish()
            if text:
                await self.send(type="final", text=text)
        finally:
            self.asr.reset()
            self.last_partial = ""
            self.finishing = False
            backlog, self.backlog = self.backlog, []
            for frame in backlog:
                await self.on_frame(frame)


def create_app(asr: DoubaoASR) -> web.Application:
    async def healthz(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "service": "areco-asr", "backend": "doubao", "available": asr.available})

    async def asr_ws(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        conn = AsrConnection(ws, asr)
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await conn.on_text(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await conn.on_frame(msg.data)
        conn.active = False
        if conn.segmenter.in_speech:
            conn.backlog.clear()
            await conn.finalize()
        return ws

    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/asr", asr_ws)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8794)
    parser.add_argument("--config")
    args = parser.parse_args()

    credential = DEFAULT_CREDENTIAL
    if args.config:
        try:
            raw = json.loads(Path(args.config).read_text(encoding="utf-8"))
            if raw.get("asr_credential_path"):
                credential = Path(raw["asr_credential_path"]).expanduser()
        except (OSError, ValueError):
            pass

    asr = DoubaoASR(credential)
    asr.load()
    web.run_app(create_app(asr), host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
