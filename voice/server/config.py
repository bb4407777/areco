"""Areco TTS 配置：本地 config.json 覆盖默认值，环境变量再覆盖。"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, fields
from pathlib import Path

VOICE_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    port: int = 8792
    out_rate: int = 24000
    tts_backend: str = "edge"  # auto | kokoro | edge
    tts_voice: str = "zh-CN-XiaoxiaoNeural"
    tts_rate: str = "+0%"
    kokoro_model: str = ""
    kokoro_voices: str = ""
    kokoro_voice: str = "zf_001"
    kokoro_speed: float = 1.0
    sentence_max_buffer: int = 50
    sentence_first_min: int = 10


def load_config(path: str | os.PathLike | None = None) -> Config:
    cfg = Config()
    config_path = Path(path) if path else VOICE_ROOT / "config.json"
    if config_path.exists():
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("TTS config 必须是 JSON 对象")
        known = {f.name for f in fields(Config)}
        for key, value in raw.items():
            if key in known:
                setattr(cfg, key, value)
    for field in fields(Config):
        env = os.environ.get(f"ARECO_TTS_{field.name.upper()}")
        if env is None:
            continue
        current = getattr(cfg, field.name)
        if isinstance(current, int):
            setattr(cfg, field.name, int(env))
        elif isinstance(current, float):
            setattr(cfg, field.name, float(env))
        else:
            setattr(cfg, field.name, env)
    if cfg.out_rate != 24000:
        raise ValueError("Areco PCM 输出固定为 24000Hz")
    if cfg.tts_backend not in {"auto", "kokoro", "edge"}:
        raise ValueError("tts_backend 只支持 auto、kokoro、edge")
    return cfg
