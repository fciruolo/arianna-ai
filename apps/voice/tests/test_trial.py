"""Pure parts of apps/voice: run with the standard library alone, or in the venv (pnpm test:voice)."""

from __future__ import annotations

import base64
import struct
import tempfile
import unittest
from pathlib import Path

from arianna_voice.models import ModelError, ModelRef, Models, speak_arguments, speak_parts
from arianna_voice.trial import RequestError, parse_speak, parse_transcribe
from arianna_voice.wav import AudioError, encode_wav

PARAKEET = {"id": "parakeet-tdt-0.6b-v3-mlx", "family": "parakeet"}
WHISPER = {"id": "whisper-large-v3-turbo-mlx", "family": "whisper"}
KOKORO = {"id": "kokoro-82m-bf16-mlx", "family": "kokoro"}
QWEN3 = {"id": "qwen3-tts-1.7b-customvoice-bf16-mlx", "family": "qwen3-tts"}
VOXTRAL = {"id": "voxtral-4b-tts-bf16-mlx", "family": "voxtral-tts"}


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
        self.assertEqual((kokoro.text, kokoro.voice), ("Ciao!", "if_sara"))
        self.assertEqual(parse_speak({"text": "Ciao", "model": QWEN3, "voice": "serena"}).model, ModelRef(QWEN3["id"], "qwen3-tts"))
        self.assertEqual(parse_speak({"text": "Ciao", "model": VOXTRAL, "voice": "it_female"}).voice, "it_female")

    def test_invalid(self) -> None:
        bad = [
            {"text": "", "model": KOKORO, "voice": "if_sara"},
            {"text": "x" * 401, "model": KOKORO, "voice": "if_sara"},
            {"text": "a\x00b", "model": KOKORO, "voice": "if_sara"},
            {"text": "Ciao", "model": KOKORO, "voice": "../sara"},
            {"text": "Ciao", "model": PARAKEET, "voice": "if_sara"},
            {"text": "Ciao", "model": KOKORO, "voice": "Serena"},
            {"text": "Ciao", "model": KOKORO, "voice": "x"},
            {"text": "Ciao", "model": {"id": "chatterbox-multilingual-v3-mlx", "family": "chatterbox"}, "voice": "if_sara"},
            {"text": "Ciao", "model": KOKORO, "voice": "if_sara", "reference": KOKORO},
        ]
        for body in bad:
            with self.subTest(body=str(body)[:60]), self.assertRaises(RequestError):
                parse_speak(body)

    def test_speak_arguments(self) -> None:
        self.assertEqual(speak_arguments("kokoro", "if_sara", "/m/voices/if_sara.safetensors")["voice"], "/m/voices/if_sara.safetensors")
        self.assertEqual(speak_arguments("kokoro", "if_sara", "/f")["lang_code"], "i")
        self.assertEqual(speak_arguments("qwen3-tts", "serena", None), {"voice": "serena", "lang_code": "italian", "verbose": False})
        self.assertEqual(speak_arguments("voxtral-tts", "it_female", "/f"), {"voice": "it_female", "verbose": False})
        with self.assertRaises(ModelError):
            speak_arguments("chatterbox", "if_sara", None)

    def test_speak_parts(self) -> None:
        text = "Certo! Ti ho segnato la riunione. Vuoi che chiami io?"
        self.assertEqual(speak_parts("kokoro", text), ["Certo!\nTi ho segnato la riunione.\nVuoi che chiami io?"])
        self.assertEqual(speak_parts("qwen3-tts", text), ["Certo!", "Ti ho segnato la riunione.", "Vuoi che chiami io?"])
        self.assertEqual(speak_parts("qwen3-tts", "Una frase sola"), ["Una frase sola"])
        self.assertEqual(speak_parts("voxtral-tts", text), [text])

    def test_voice_file(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for family_dir, name in (("kokoro-x/voices", "if_sara"), ("voxtral-x/voice_embedding", "it_female"), ("voxtral-x/voices", "it_male")):
                (root / family_dir).mkdir(parents=True, exist_ok=True)
                (root / family_dir / f"{name}.safetensors").write_bytes(b"")
            (root / "qwen-x").mkdir()
            models = Models(root)
            kokoro, voxtral, qwen = ModelRef("kokoro-x", "kokoro"), ModelRef("voxtral-x", "voxtral-tts"), ModelRef("qwen-x", "qwen3-tts")
            self.assertTrue(models._voice_file(kokoro, "if_sara").endswith("kokoro-x/voices/if_sara.safetensors"))
            self.assertTrue(models._voice_file(voxtral, "it_female").endswith("voxtral-x/voice_embedding/it_female.safetensors"))
            # Qwen3-TTS speakers are in the weights, not files.
            self.assertIsNone(models._voice_file(qwen, "serena"))
            # Each family reads its own folder only; a missing voice and a bad name are refused.
            for ref, voice, code in ((voxtral, "it_male", "missing"), (kokoro, "im_nicola", "missing"), (kokoro, "../if_sara", "family"), (qwen, "Serena", "family")):
                with self.subTest(ref=ref.family, voice=voice), self.assertRaises(ModelError) as caught:
                    models._voice_file(ref, voice)
                self.assertEqual(caught.exception.code, code)
            models.close()

    def test_copied_voice(self) -> None:
        # D-069: Qwen3-TTS Base reads the sample and its text from the voices folder.
        self.assertEqual(
            speak_arguments("qwen3-tts-base", "moglie", "/v/moglie/reference.wav", "Ciao."),
            {"ref_audio": "/v/moglie/reference.wav", "ref_text": "Ciao.", "lang_code": "italian", "verbose": False},
        )
        with self.assertRaises(ModelError):
            speak_arguments("qwen3-tts-base", "moglie", "/v/moglie/reference.wav", None)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            clones = root / "voices"
            (clones / "moglie").mkdir(parents=True)
            (clones / "moglie" / "reference.wav").write_bytes(b"RIFF")
            (clones / "moglie" / "reference.txt").write_text("Ciao, sono io.\n", encoding="utf-8")
            (root / "fuori").mkdir()
            (root / "fuori" / "reference.wav").write_bytes(b"RIFF")
            (clones / "collegata").symlink_to(root / "fuori")
            (root / "base-x").mkdir()
            models = Models(root, clones)
            base = ModelRef("base-x", "qwen3-tts-base")
            self.assertTrue(models._voice_file(base, "moglie").endswith("voices/moglie/reference.wav"))
            self.assertEqual(models._reference_text("moglie"), "Ciao, sono io.")
            for voice in ("collegata", "assente"):
                with self.subTest(voice=voice), self.assertRaises(ModelError) as caught:
                    models._voice_file(base, voice)
                self.assertEqual(caught.exception.code, "missing")
            # Without a voices folder there are no copied voices.
            with self.assertRaises(ModelError):
                Models(root)._voice_file(base, "moglie")
            models.close()

    def test_model_ref(self) -> None:
        with self.assertRaises(ModelError):
            ModelRef.parse({"id": "x", "family": "kokoro", "path": "/"}, ("kokoro",))


if __name__ == "__main__":
    unittest.main()
