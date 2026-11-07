"""Areco 独立 TTS sidecar：仅回环 HTTP，无 ASR/VAD/麦克风/HermesClient。"""

from __future__ import annotations

import argparse
import asyncio
import logging
from typing import AsyncIterator, Protocol

from aiohttp import web

from .config import Config, load_config
from .sentencer import SentenceAssembler
from .tts import TTSEngine

MAX_TEXT_LENGTH = 8000


class TTS(Protocol):
    def synth_stream(self, text: str) -> AsyncIterator[bytes]: ...


def create_app(engine: TTS, cfg: Config) -> web.Application:
    async def healthz(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "service": "areco-tts", "sampleRate": 24000})

    async def synthesize(request: web.Request) -> web.StreamResponse:
        try:
            payload = await request.json()
        except Exception:
            raise web.HTTPBadRequest(text="invalid JSON")
        text = payload.get("text", "") if isinstance(payload, dict) else ""
        if not isinstance(text, str) or not text.strip():
            raise web.HTTPBadRequest(text="text is required")
        if len(text) > MAX_TEXT_LENGTH:
            raise web.HTTPBadRequest(text="text is too long")

        assembler = SentenceAssembler(cfg.sentence_max_buffer, cfg.sentence_first_min)
        sentences = [*assembler.feed(text), *assembler.flush()]
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Audio-Sample-Rate": "24000",
                "X-Audio-Channels": "1",
                "X-Audio-Format": "pcm16le",
            },
        )
        await response.prepare(request)
        try:
            for sentence in sentences:
                stream = engine.synth_stream(sentence)
                try:
                    async for chunk in stream:
                        if chunk:
                            await response.write(chunk)
                finally:
                    await stream.aclose()
            await response.write_eof()
        except (ConnectionResetError, asyncio.CancelledError):
            raise
        return response

    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_post("/synthesize", synthesize)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config")
    args = parser.parse_args()
    cfg = load_config(args.config)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    web.run_app(create_app(TTSEngine(cfg), cfg), host="127.0.0.1", port=cfg.port, print=None)


if __name__ == "__main__":
    main()
