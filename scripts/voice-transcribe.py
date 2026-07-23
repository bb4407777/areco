#!/usr/bin/env python3
"""
areco 语音输入转写脚本（供 areco server 的 /api/voice/transcribe 通过 spawn 调用）。

读一个 wav，调本地 FunASR(Paraformer/SenseVoice) 或 Whisper，stdout 输出单行 JSON：
  {"text": "识别正文", "engine": "paraformer|sensevoice|whisper"}
出错也输出 JSON（带 error），并以非 0 退出，便于 Node 端解析后报给前端：
  {"text": "", "engine": "...", "error": "错误信息"}

设计要点：
- areco 前端 AudioWorklet 产的已是 16kHz 单声道 PCM wav，通常可直接喂 FunASR；
  为兼容任意输入（万一），ensure_wav16k 用 ffmpeg 统一转 16k 单声道；无 ffmpeg
  或转码失败则回退原文件（FunASR 对 16k wav 直读无碍）。
- 不钉死模型缓存路径（开源通用）：MODELSCOPE_CACHE 默认走 funasr 默认（~/.cache/modelscope），
  可用环境变量覆盖。
- 说话人分离关闭（语音输入就一个人说话，省 cam++ 开销与碎句）。

依赖（系统级 python 包，不进 areco package.json）：funasr、openai-whisper（仅 whisper 引擎）、ffmpeg。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(payload):
    """单行 JSON 输出到 stdout（Node 端按最后一行解析）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure_wav16k(audio_path):
    """返回 (wav_path, is_temp)。无 ffmpeg / 转码失败 → 原样回退 (audio_path, False)。"""
    ffmpeg = os.environ.get("ARECO_FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        return audio_path, False
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    ret = subprocess.run(
        [ffmpeg, "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav],
        capture_output=True, text=True,
    )
    if ret.returncode != 0:
        try:
            os.remove(wav)
        except OSError:
            pass
        return audio_path, False
    return wav, True


def transcribe_funasr(wav, engine, hotwords):
    from funasr import AutoModel
    if engine == "sensevoice":
        model = AutoModel(
            model="iic/SenseVoiceSmall",
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            disable_update=True,
        )
        res = model.generate(
            input=wav, language="auto", use_itn=True,
            batch_size_s=300, merge_vad=True, merge_length_s=15,
        )
        raw = res[0]["text"] if res else ""
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        return rich_transcription_postprocess(raw).strip()
    # paraformer（默认）：带 ct-punc 标点，无说话人分离
    model = AutoModel(
        model="paraformer-zh",
        vad_model="fsmn-vad",
        punc_model="ct-punc",
        vad_kwargs={"max_single_segment_time": 15000},
        disable_update=True,
    )
    res = model.generate(input=wav, batch_size_s=300, hotword=hotwords)
    return ((res[0]["text"] if res else "") or "").strip()


def transcribe_whisper(wav):
    import whisper
    model = whisper.load_model("medium")
    return (model.transcribe(wav, language="zh")["text"] or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["paraformer", "sensevoice", "whisper"], default="paraformer")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--hotwords", default="")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        emit({"text": "", "engine": args.engine, "error": f"音频文件不存在: {args.audio}"})
        return 2

    wav, is_temp = ensure_wav16k(args.audio)
    try:
        if args.engine == "whisper":
            text = transcribe_whisper(wav)
        else:
            text = transcribe_funasr(wav, args.engine, args.hotwords)
        emit({"text": text, "engine": args.engine})
        return 0
    finally:
        if is_temp:
            try:
                os.remove(wav)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - 顶层兜底，保证 Node 端总能拿到结构化错误
        emit({"text": "", "engine": "", "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)
