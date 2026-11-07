import struct
import unittest

from aiohttp.test_utils import AioHTTPTestCase

from voice.server.config import Config
from voice.server.main import MAX_TEXT_LENGTH, create_app


class FakeTTS:
    def __init__(self):
        self.sentences = []

    async def synth_stream(self, text):
        self.sentences.append(text)
        yield struct.pack("<hhh", 0, 1000, -1000)
        yield struct.pack("<h", 32767)


class SidecarTest(AioHTTPTestCase):
    async def get_application(self):
        self.engine = FakeTTS()
        return create_app(self.engine, Config())

    async def test_health(self):
        response = await self.client.get("/healthz")
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["service"], "areco-tts")

    async def test_fixed_pcm_stream(self):
        response = await self.client.post("/synthesize", json={"text": "第一句。第二句"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["X-Audio-Sample-Rate"], "24000")
        self.assertEqual(response.headers["X-Audio-Format"], "pcm16le")
        body = await response.read()
        self.assertEqual(body, struct.pack("<hhhh", 0, 1000, -1000, 32767) * 2)
        self.assertEqual(self.engine.sentences, ["第一句。", "第二句"])

    async def test_rejects_empty_and_overlong_text(self):
        empty = await self.client.post("/synthesize", json={"text": "  "})
        self.assertEqual(empty.status, 400)
        long = await self.client.post("/synthesize", json={"text": "x" * (MAX_TEXT_LENGTH + 1)})
        self.assertEqual(long.status, 400)


if __name__ == "__main__":
    unittest.main()
