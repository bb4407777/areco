"""Silero VAD 分段：32ms 帧流 → utterance（含 pre-roll 环形缓冲）。

移植自 hermes-live server/vad.py 的 Segmenter，只保留语音输入需要的部分。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from pysilero_vad import SileroVoiceActivityDetector

FRAME_MS = 32  # 512 样本 @ 16k
FRAME_BYTES = 1024

THRESHOLD = 0.5
START_FRAMES = 6          # 连续 6 帧（192ms）判入语音段
END_SILENCE_MS = 1100     # 尾静音多久判段结束
MIN_UTTERANCE_MS = 300    # 短于此丢弃（咳嗽/键盘）
MAX_UTTERANCE_MS = 30000  # 强制截断
PREROLL_MS = 300


@dataclass
class Utterance:
    pcm: bytes
    duration_ms: int


class Segmenter:
    """帧进、事件出。feed() 返回 ("start"|"end", Utterance|None) 或 None。"""

    def __init__(self, vad: SileroVoiceActivityDetector):
        self.vad = vad
        self.preroll: deque[bytes] = deque(maxlen=max(1, PREROLL_MS // FRAME_MS))
        self.in_speech = False
        self.voiced_run = 0
        self.silence_run_ms = 0
        self.buf: list[bytes] = []
        self.buf_ms = 0

    def reset(self) -> None:
        self.preroll.clear()
        self.in_speech = False
        self.voiced_run = 0
        self.silence_run_ms = 0
        self.buf = []
        self.buf_ms = 0

    def feed(self, frame: bytes) -> tuple[str, Utterance | None] | None:
        prob = self.vad(frame)
        if not self.in_speech:
            self.preroll.append(frame)
            if prob >= THRESHOLD:
                self.voiced_run += 1
                if self.voiced_run >= START_FRAMES:
                    self.in_speech = True
                    self.buf = list(self.preroll)
                    self.buf_ms = len(self.buf) * FRAME_MS
                    self.silence_run_ms = 0
                    self.voiced_run = 0
                    return ("start", None)
            else:
                self.voiced_run = 0
            return None

        self.buf.append(frame)
        self.buf_ms += FRAME_MS
        if prob >= THRESHOLD:
            self.silence_run_ms = 0
        else:
            self.silence_run_ms += FRAME_MS

        end = self.silence_run_ms >= END_SILENCE_MS
        force = self.buf_ms >= MAX_UTTERANCE_MS
        if not (end or force):
            return None

        pcm = b"".join(self.buf)
        dur = self.buf_ms - (self.silence_run_ms if end else 0)
        self.reset()
        if dur < MIN_UTTERANCE_MS:
            return None
        return ("end", Utterance(pcm=pcm, duration_ms=dur))


def new_vad() -> SileroVoiceActivityDetector:
    return SileroVoiceActivityDetector()
