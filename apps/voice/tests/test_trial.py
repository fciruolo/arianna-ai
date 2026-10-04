"""Pure parts of apps/voice: run with the standard library alone, or in the venv (pnpm test:voice)."""

from __future__ import annotations

import base64
import struct
import unittest

from arianna_voice.models import ModelError, ModelRef
from arianna_voice.trial import RequestError, parse_speak, parse_transcribe
from arianna_voice.wav import AudioError, encode_wav

PARAKEET = {"id": "parakeet-tdt-0.6b-v3-mlx", "family": "parakeet"}
WHISPER = {"id": "whisper-large-v3-turbo-mlx", "family": "whisper"}
KOKORO = {"id": "kokoro-82m-bf16-mlx", "family": "kokoro"}
CHATTERBOX = {"id": "chatterbox-multilingual-v3-mlx", "family": "chatterbox"}


def pcm(seconds: float) -> str:
    return base64.b64encode(b"\x00\x00" * int(16_000 * seconds)).decode()


class WavTest(unittest.TestCase):
    def test_header(self) -> None:
        wav = encode_wav(b"\x01\x00\xff\x7f", 24_000)
        self.assertEqual(len(wav), 48)
        self.assertEqual(wav[:4] + wav[8:16], b"RIFFWAVEfmt ")
        self.assertEqual(struct.unpack("<HHII", wav[20:32]), (1, 1, 24_000, 48_000))
        self.assertEqual(wav[36:40], b"data")
        self.assertEqual(struct.unpack("<I", wav[40:44])[0], 4)

    def test_refuses_an_incomplete_frame(self) -> None:
        with self.assertRaises(AudioError):
            encode_wav(b"\x00", 16_000)


class TranscribeRequestTest(unittest.TestCase):
    def test_valid(self) -> None:
        parsed = parse_transcribe({"pcm16": pcm(1), "rate": 16_000, "models": [PARAKEET, WHISPER]})
        self.assertEqual(len(parsed.pcm16), 32_000)
        self.assertEqual([ref.family for ref in parsed.models], ["parakeet", "whisper"])

    def test_invalid(self) -> None:
        bad = [
            None,
            {"pcm16": pcm(1), "rate": 16_000},
            {"pcm16": pcm(1), "rate": 44_100, "models": [PARAKEET]},
            {"pcm16": "not base64!", "rate": 16_000, "models": [PARAKEET]},
            {"pcm16": pcm(0.1), "rate": 16_000, "models": [PARAKEET]},
            {"pcm16": pcm(31), "rate": 16_000, "models": [PARAKEET]},
            {"pcm16": base64.b64encode(b"\x00" * 16_001).decode(), "rate": 16_000, "models": [PARAKEET]},
            {"pcm16": pcm(1), "rate": 16_000, "models": []},
            {"pcm16": pcm(1), "rate": 16_000, "models": [PARAKEET, PARAKEET]},
            {"pcm16": pcm(1), "rate": 16_000, "models": [KOKORO]},
            {"pcm16": pcm(1), "rate": 16_000, "models": [{"id": "../x", "family": "parakeet"}]},
            {"pcm16": pcm(1), "rate": 16_000, "models": [PARAKEET], "extra": 1},
        ]
        for body in bad:
            with self.subTest(body=str(body)[:60]), self.assertRaises(RequestError):
                parse_transcribe(body)


class SpeakRequestTest(unittest.TestCase):
    def test_valid(self) -> None:
        kokoro = parse_speak({"text": " Ciao! ", "model": KOKORO, "voice": "if_sara"})
        self.assertEqual((kokoro.text, kokoro.reference), ("Ciao!", None))
        chatterbox = parse_speak({"text": "Ciao", "model": CHATTERBOX, "voice": "im_nicola", "reference": KOKORO})
        self.assertEqual(chatterbox.reference, ModelRef(KOKORO["id"], "kokoro"))

    def test_invalid(self) -> None:
        bad = [
            {"text": "", "model": KOKORO, "voice": "if_sara"},
            {"text": "x" * 401, "model": KOKORO, "voice": "if_sara"},
            {"text": "a\x00b", "model": KOKORO, "voice": "if_sara"},
            {"text": "Ciao", "model": KOKORO, "voice": "../sara"},
            {"text": "Ciao", "model": PARAKEET, "voice": "if_sara"},
            {"text": "Ciao", "model": CHATTERBOX, "voice": "if_sara"},
            {"text": "Ciao", "model": CHATTERBOX, "voice": "if_sara", "reference": CHATTERBOX},
            {"text": "Ciao", "model": KOKORO, "voice": "if_sara", "reference": KOKORO},
        ]
        for body in bad:
            with self.subTest(body=str(body)[:60]), self.assertRaises(RequestError):
                parse_speak(body)

    def test_model_ref(self) -> None:
        with self.assertRaises(ModelError):
            ModelRef.parse({"id": "x", "family": "kokoro", "path": "/"}, ("kokoro",))


if __name__ == "__main__":
    unittest.main()
