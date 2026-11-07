import unittest

from voice.server.sentencer import CODE_PLACEHOLDER, SentenceAssembler


class SentenceAssemblerTest(unittest.TestCase):
    def test_cleans_markdown_and_skips_code(self):
        assembler = SentenceAssembler()
        sentences = assembler.feed("**结论**。[链接](https://example.com)```python\nsecret\n```完")
        sentences += assembler.flush()
        self.assertEqual(sentences, ["结论。", "链接（这里有段代码，略过。", "）完"])

    def test_flush_emits_tail(self):
        assembler = SentenceAssembler()
        self.assertEqual(assembler.feed("没有句号的正文"), [])
        self.assertEqual(assembler.flush(), ["没有句号的正文"])


if __name__ == "__main__":
    unittest.main()
