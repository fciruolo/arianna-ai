"""The request that opens a call and the timing of the call: standard library only."""

from __future__ import annotations

import copy
import unittest

from arianna_voice.call_request import last_user_words, parse_call, parse_say, schedule
from arianna_voice.trial import RequestError

KOKORO = {"id": "kokoro-82m-bf16-mlx", "family": "kokoro"}
VALID = {
    "callId": "0b1f0c2e-5f3a-4c4e-9a59-6d1f5e3b2a10",
    "token": "t" * 43,
    "coreUrl": "http://127.0.0.1:7420",
    "sdp": "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n",
    "type": "offer",
    "stt": {"id": "parakeet-tdt-0.6b-v3-mlx", "family": "parakeet"},
    "tts": KOKORO,
    "voice": "if_sara",
    "limits": {"callSeconds": 900, "warnSeconds": 60},
    "texts": {"greeting": "Ciao", "warning": "Manca un minuto", "goodbye": "Ciao ciao"},
}


def changed(**fields):
    body = copy.deepcopy(VALID)
    for key, value in fields.items():
        if value is None:
            body.pop(key)
        else:
            body[key] = value
    return body


class CallRequestTest(unittest.TestCase):
    def test_valid(self) -> None:
        request = parse_call(VALID)
        self.assertEqual((request.call_seconds, request.warn_seconds, request.voice), (900, 60, "if_sara"))
        voxtral = parse_call(changed(tts={"id": "voxtral-4b-tts-bf16-mlx", "family": "voxtral-tts"}, voice="it_female"))
        self.assertEqual((voxtral.tts.family, voxtral.voice), ("voxtral-tts", "it_female"))
        self.assertEqual(parse_call(changed(tts={"id": "qwen3-tts-1.7b-customvoice-bf16-mlx", "family": "qwen3-tts"}, voice="serena")).voice, "serena")
        self.assertEqual(parse_call(changed(coreUrl="http://[::1]:7420")).core_url, "http://[::1]:7420")

    def test_invalid(self) -> None:
        bad = [
            changed(callId="x"),
            changed(token="short"),
            changed(coreUrl="http://example.org:7420"),
            changed(coreUrl="https://127.0.0.1:7420"),
            changed(coreUrl="http://127.0.0.1:7420/api"),
            changed(type="answer"),
            changed(sdp="hello"),
            changed(voice="Sara"),
            changed(stt=KOKORO),
            changed(limits={"callSeconds": 10, "warnSeconds": 0}),
            changed(limits={"callSeconds": 900, "warnSeconds": 900}),
            changed(texts={"greeting": "", "warning": "a", "goodbye": "b"}),
            changed(tts={"id": "chatterbox-multilingual-v3-mlx", "family": "chatterbox"}),
            changed(reference=KOKORO),
            changed(texts=None),
            changed(extra=1),
        ]
        for body in bad:
            with self.subTest(body=str(body)[:80]), self.assertRaises(RequestError):
                parse_call(body)

    def test_say(self) -> None:
        self.assertEqual(parse_say({"text": " Fatto. "}), "Fatto.")
        for body in ({}, {"text": ""}, {"text": "x" * 2001}, {"text": "a", "more": 1}):
            with self.assertRaises(RequestError):
                parse_say(body)


class TimingTest(unittest.TestCase):
    def test_schedule(self) -> None:
        self.assertEqual(schedule(900, 60), [(840.0, "warning"), (900.0, "goodbye")])
        self.assertEqual(schedule(900, 0), [(900.0, "goodbye")])

    def test_last_user_words(self) -> None:
        messages = [
            {"role": "user", "content": "prima"},
            {"role": "assistant", "content": "risposta"},
            {"role": "user", "content": "ciao"},
            {"role": "user", "content": [{"type": "text", "text": "come stai"}, {"type": "image"}]},
        ]
        self.assertEqual(last_user_words(messages), "ciao come stai")
        self.assertEqual(last_user_words([{"role": "assistant", "content": "x"}]), "")
        self.assertEqual(last_user_words(["junk", {"role": "system", "content": "s"}, {"role": "user", "content": " sì "}]), "sì")


if __name__ == "__main__":
    unittest.main()
