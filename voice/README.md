# Areco voice

仅提供回环 `127.0.0.1:8792` 的 TTS sidecar：`GET /healthz`、`POST /synthesize`。
输出固定为 24kHz、单声道、PCM16 little-endian 原始流；不含 ASR、VAD、麦克风或 Hermes 客户端。

```bash
python3 -m venv voice/.venv
voice/.venv/bin/pip install -r voice/requirements.txt
cp voice/config.example.json voice/config.json
python3 -m voice.server.main --config voice/config.json
```

Koa 首次收到 `/api/tts` 时会用 `voice/.venv/bin/python`（不存在则用 `python3`）懒启动 sidecar，并在主服务退出时停止自己创建的子进程。`ARECO_TTS_PYTHON` 可指定解释器，`ARECO_TTS_PORT` 可改独立测试端口。真实语音需要 Kokoro 模型或 edge-tts 网络与相应依赖；单元测试只使用 Fake TTS 和固定 PCM。
