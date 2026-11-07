"""Areco TTS：kokoro-onnx 本地优先，edge-tts 云端兜底；输出 24kHz PCM16LE。"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator

from .config import Config

logger = logging.getLogger(__name__)


class TTSEngine:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._kokoro = None
        self._kokoro_voice = None
        self._backend: str | None = None

    def load(self) -> None:
        if self.cfg.tts_backend in ("auto", "kokoro"):
            try:
                self._load_kokoro()
            except Exception as exc:
                if self.cfg.tts_backend == "kokoro":
                    raise
                logger.warning("kokoro TTS 加载失败，回退 edge-tts: %s", exc)
        if self._backend is None:
            self._backend = "edge"
            logger.info("TTS: edge-tts (cloud)")

    def _load_kokoro(self) -> None:
        model = Path(self.cfg.kokoro_model).expanduser()
        voices = Path(self.cfg.kokoro_voices).expanduser()
        if not model.is_file():
            raise FileNotFoundError(f"kokoro model not found: {model}")
        if not voices.is_file():
            raise FileNotFoundError(f"kokoro voices not found: {voices}")
        try:
            import kokoro_onnx
        except ImportError as exc:
            raise ImportError("kokoro-onnx not installed") from exc
        self._kokoro = kokoro_onnx.Kokoro(str(model), str(voices))
        self._kokoro_voice = self._kokoro.get_voice_style(self.cfg.kokoro_voice)
        self._backend = "kokoro"
        logger.info("TTS: kokoro-onnx %s ready", self.cfg.kokoro_voice)

    async def synth_stream(self, text: str) -> AsyncIterator[bytes]:
        if self._backend is None:
            self.load()
        if self._backend == "kokoro":
            async for chunk in self._synth_kokoro(text):
                yield chunk
        else:
            async for chunk in self._synth_edge(text):
                yield chunk

    async def _synth_kokoro(self, text: str) -> AsyncIterator[bytes]:
        import numpy as np

        try:
            async for audio_arr, _sample_rate in self._kokoro.create_stream(
                text,
                voice=self._kokoro_voice,
                speed=self.cfg.kokoro_speed,
                lang="cmn",
            ):
                if audio_arr is None or len(audio_arr) == 0:
                    continue
                pcm = (np.clip(audio_arr, -1.0, 1.0) * 32767).astype(np.int16)
                yield pcm.tobytes()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.cfg.tts_backend == "kokoro":
                raise
            logger.warning("kokoro 合成失败，回退 edge-tts: %s", exc)
            async for chunk in self._synth_edge(text):
                yield chunk

    async def _synth_edge(self, text: str) -> AsyncIterator[bytes]:
        import av
        import edge_tts

        codec = av.CodecContext.create("mp3", "r")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=self.cfg.out_rate)
        comm = edge_tts.Communicate(text, voice=self.cfg.tts_voice, rate=self.cfg.tts_rate)
        got_audio = False
        try:
            async for chunk in comm.stream():
                if chunk["type"] != "audio":
                    continue
                got_audio = True
                for pcm in self._decode(codec, resampler, chunk["data"]):
                    yield pcm
            if got_audio:
                for pcm in self._flush(codec, resampler):
                    yield pcm
        except asyncio.CancelledError:
            raise

    @staticmethod
    def _pcm_bytes(frame) -> bytes:
        return frame.to_ndarray().tobytes()

    def _decode(self, codec, resampler, data: bytes):
        import av

        for packet in codec.parse(data):
            try:
                frames = codec.decode(packet)
            except av.FFmpegError:
                continue
            for frame in frames:
                for out in resampler.resample(frame):
                    yield self._pcm_bytes(out)

    def _flush(self, codec, resampler):
        import av

        try:
            frames = codec.decode(None)
        except av.FFmpegError:
            frames = []
        for frame in frames:
            for out in resampler.resample(frame):
                yield self._pcm_bytes(out)
        try:
            for out in resampler.resample(None):
                yield self._pcm_bytes(out)
        except av.FFmpegError:
            pass
