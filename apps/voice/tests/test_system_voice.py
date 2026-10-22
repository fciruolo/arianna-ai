"""The voices of macOS (D-290) with a fake `say`: no audio, no macOS needed."""

from __future__ import annotations

import json
import os
import stat
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from arianna_voice.call_request import parse_call
from arianna_voice.models import SAY_PIECE_CHARS, SYSTEM_FAMILY, ModelError, ModelRef, Models, short_pieces, speak_parts
from arianna_voice.system_voice import SystemVoice, SystemVoiceError, parse_voice_list, wav_pcm16
from arianna_voice.trial import RequestError, parse_speak
from arianna_voice.wav import AudioError

LISTING = """Alice               it_IT    # Ciao! Mi chiamo Alice.
Eddy (Italiano (Italia)) it_IT    # Ciao! Mi chiamo Eddy.
Federica (Premium)  it_IT    # Ciao! Mi chiamo Federica.
Samantha            en_US    # Hello! My name is Samantha.
"""

# A `say` that lists LISTING, writes a WAV like the real one (a FLLR chunk before
# the data, two samples per character read) and records its arguments and input.
FAKE_SAY = """#!{python}
import json, struct, sys
args = sys.argv[1:]
log = {log!r}
if args == ["-v", "?"]:
    sys.stdout.write({listing!r})
    sys.exit(0)
text = sys.stdin.buffer.read().decode("utf-8")
with open(log, "a", encoding="utf-8") as out:
    out.write(json.dumps({{"args": args, "stdin": text}}) + "\\n")
if "fail" in text:
    sys.exit(1)
path = args[args.index("-o") + 1]
pcm = b"\\x01\\x00" * (2 * len(text))
fllr = b"FLLR" + struct.pack("<I", 6) + b"\\x00" * 6
fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 24000, 48000, 2, 16)
data = b"data" + struct.pack("<I", len(pcm)) + pcm
body = b"WAVE" + fmt + fllr + data
with open(path, "wb") as out:
    out.write(b"RIFF" + struct.pack("<I", len(body)) + body)
"""


def wav(rate: int = 24_000, channels: int = 1, bits: int = 16, pcm: bytes = b"\x01\x00\x02\x00", extra: bytes = b"") -> bytes:
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * channels * bits // 8, channels * bits // 8, bits)
    body = b"WAVE" + fmt + extra + b"data" + struct.pack("<I", len(pcm)) + pcm
    return b"RIFF" + struct.pack("<I", len(body)) + body


class FakeSay:
    def __init__(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.folder = Path(self._dir.name)
        self.log = self.folder / "calls.jsonl"
        self.path = self.folder / "say"
        self.path.write_text(FAKE_SAY.format(python=sys.executable, log=str(self.log), listing=LISTING), encoding="utf-8")
        self.path.chmod(self.path.stat().st_mode | stat.S_IXUSR)
        self.tmp = self.folder / "tmp" / "say"

    def calls(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]


class PureTest(unittest.TestCase):
    def test_the_listing_gives_the_names(self) -> None:
        self.assertEqual(parse_voice_list(LISTING), ["Alice", "Eddy (Italiano (Italia))", "Federica (Premium)", "Samantha"])
        self.assertEqual(parse_voice_list("\nnot a voice\n"), [])

    def test_wav_chunks_are_walked(self) -> None:
        self.assertEqual(wav_pcm16(wav(extra=b"FLLR" + struct.pack("<I", 3) + b"abc\x00")), b"\x01\x00\x02\x00")
        self.assertEqual(wav_pcm16(wav()), b"\x01\x00\x02\x00")

    def test_wav_of_another_shape_is_refused(self) -> None:
        for bad in (b"", b"RIFF0000AIFF", wav(rate=22_050), wav(channels=2, pcm=b"\x00" * 8), wav(bits=8)):
            with self.assertRaises(AudioError):
                wav_pcm16(bad)

    def test_one_sentence_at_a_time(self) -> None:
        self.assertEqual(speak_parts(SYSTEM_FAMILY, "Ciao! Ho 3 cose da dirti.  Va bene?"), ["Ciao!", "Ho 3 cose da dirti.", "Va bene?"])

    def test_a_long_sentence_without_stops_goes_in_short_pieces(self) -> None:
        # One piece is written by `say` without a pause: an interruption waits at most one piece.
        words = " ".join(f"parola{index}" for index in range(80))
        parts = speak_parts(SYSTEM_FAMILY, words + ".")
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(0 < len(part) <= SAY_PIECE_CHARS for part in parts))
        self.assertEqual(" ".join(parts), words + ".")
        # At the last comma when there is one, never inside a word.
        commas = "uno, " + "a" * 20 + " " + ("bb " * 30) + "fine, " + ("cc " * 40)
        first = speak_parts(SYSTEM_FAMILY, commas)[0]
        self.assertTrue(first.endswith("fine,"), first)
        self.assertEqual(short_pieces("x" * 400), ["x" * 160, "x" * 160, "x" * 80])
        self.assertEqual(short_pieces("Breve."), ["Breve."])
        self.assertTrue(all(piece.startswith("parola") for piece in short_pieces("\u00a0".join(["parola"] * 40))))

    def test_embedded_speech_commands_are_taken_out(self) -> None:
        # A reply quoting a mail with [[slnc 60000]] must not silence or bend the voice.
        self.assertEqual(speak_parts(SYSTEM_FAMILY, "Ecco la mail: [[slnc 60000]] ciao [[volm 0]]."), ["Ecco la mail:", "slnc 60000  ciao  volm 0 ."])
        self.assertEqual(speak_parts(SYSTEM_FAMILY, "Un [solo] segno resta."), ["Un [solo] segno resta."])
        self.assertTrue(all("[[" not in part and "]]" not in part for part in speak_parts(SYSTEM_FAMILY, "[[[inpt PHON]]]")))

    def test_the_ref_carries_the_system_voice_only_for_its_family(self) -> None:
        ref = ModelRef.parse({"id": "macos-federica", "family": SYSTEM_FAMILY, "systemVoice": "Federica (Premium)"}, (SYSTEM_FAMILY,))
        self.assertEqual(ref.system_voice, "Federica (Premium)")
        for bad in (
            {"id": "macos-federica", "family": SYSTEM_FAMILY},
            {"id": "macos-federica", "family": SYSTEM_FAMILY, "systemVoice": "-o /tmp/x"},
            {"id": "macos-federica", "family": SYSTEM_FAMILY, "systemVoice": "Federica (Premium)\n"},
            {"id": "macos-federica", "family": SYSTEM_FAMILY, "systemVoice": 3},
            {"id": "kokoro", "family": "kokoro", "systemVoice": "Federica (Premium)"},
        ):
            with self.assertRaises(ModelError):
                ModelRef.parse(bad, (SYSTEM_FAMILY, "kokoro"))

    def test_trial_and_call_requests_take_a_system_voice(self) -> None:
        model = {"id": "macos-federica", "family": SYSTEM_FAMILY, "systemVoice": "Federica (Premium)"}
        self.assertEqual(parse_speak({"text": "Ciao", "model": model, "voice": "federica_premium"}).model.system_voice, "Federica (Premium)")
        with self.assertRaises(RequestError):
            parse_speak({"text": "Ciao", "model": {"id": "macos-federica", "family": SYSTEM_FAMILY}, "voice": "federica_premium"})
        call = parse_call(
            {
                "callId": "00000000-0000-4000-8000-000000000000",
                "token": "t" * 40,
                "coreUrl": "http://127.0.0.1:7420",
                "sdp": "v=0",
                "type": "offer",
                "stt": {"id": "parakeet", "family": "parakeet"},
                "tts": model,
                "voice": "federica_premium",
                "limits": {"callSeconds": 600, "warnSeconds": 60},
                "texts": {"greeting": "Ciao", "warning": "Manca poco", "goodbye": "Ciao ciao"},
            }
        )
        self.assertEqual(call.tts.system_voice, "Federica (Premium)")


class FakeSayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.say = FakeSay()
        self.voice = SystemVoice(self.say.tmp, say=self.say.path)
        self.models = Models(self.say.folder / "models", None, self.voice)
        self.ref = ModelRef("macos-federica", SYSTEM_FAMILY, "Federica (Premium)")

    def tearDown(self) -> None:
        self.models.close()
        self.say._dir.cleanup()  # noqa: SLF001 - the fake's own folder

    def test_the_text_goes_on_stdin_never_among_the_arguments(self) -> None:
        pcm = self.voice.speak("Federica (Premium)", "Il segreto di Giulia")
        self.assertEqual(len(pcm), 4 * len("Il segreto di Giulia"))
        [call] = self.say.calls()
        self.assertEqual(call["stdin"], "Il segreto di Giulia")
        self.assertNotIn("segreto", " ".join(call["args"]))
        self.assertEqual(call["args"][:4], ["-v", "Federica (Premium)", "--file-format=WAVE", "--data-format=LEI16@24000"])
        # The audio file is gone, in a folder only the user can read.
        self.assertEqual(os.listdir(self.say.tmp), [])
        self.assertEqual(stat.S_IMODE(self.say.tmp.stat().st_mode), 0o700)

    def test_a_voice_not_installed_is_refused_before_say_speaks(self) -> None:
        # The real `say` would speak with the default voice instead: never asked.
        with self.assertRaises(SystemVoiceError):
            self.voice.check("Federica (Premium)\n")
        with self.assertRaises(SystemVoiceError) as caught:
            self.voice.speak("Nessuna (Premium)", "Ciao")
        self.assertEqual(caught.exception.code, "missing")
        self.assertEqual(self.say.calls(), [])
        with self.assertRaises(ModelError) as model_error:
            self.models.warm(ModelRef("macos-nessuna", SYSTEM_FAMILY, "Nessuna (Premium)"))
        self.assertEqual(model_error.exception.code, "missing")

    def test_without_say_the_voice_is_unavailable(self) -> None:
        voice = SystemVoice(self.say.tmp, say=self.say.folder / "missing-say")
        with self.assertRaises(SystemVoiceError) as caught:
            voice.check("Federica (Premium)")
        self.assertEqual(caught.exception.code, "unavailable")
        models = Models(self.say.folder / "models", None, voice)
        try:
            with self.assertRaises(ModelError) as model_error:
                models.warm(self.ref)
            self.assertEqual(model_error.exception.code, "missing")
        finally:
            models.close()

    def test_a_failing_say_is_an_inference_error_and_leaves_no_file(self) -> None:
        with self.assertRaises(ModelError) as caught:
            self.models.speak_stream(self.ref, "Questa fail.", "federica_premium", lambda *_: None, threading.Event())
        self.assertEqual(caught.exception.code, "inference")
        self.assertEqual(os.listdir(self.say.tmp), [])

    def test_warm_loads_nothing(self) -> None:
        self.models.warm(self.ref)
        self.assertEqual(self.models.loaded(), 0)
        self.assertEqual(self.models.unload_all(), 0)

    def test_a_sentence_at_a_time_and_stop_between_two(self) -> None:
        pieces: list[tuple[int, int]] = []
        self.models.speak_stream(self.ref, "Ciao. Come stai?", "federica_premium", lambda pcm, rate: pieces.append((len(pcm), rate)), threading.Event())
        self.assertEqual(pieces, [(4 * len("Ciao."), 24_000), (4 * len("Come stai?"), 24_000)])
        self.assertEqual([call["stdin"] for call in self.say.calls()], ["Ciao.", "Come stai?"])
        stop = threading.Event()

        def first_only(_pcm: bytes, _rate: int) -> None:
            stop.set()

        self.models.speak_stream(self.ref, "Uno. Due. Tre.", "federica_premium", first_only, stop)
        self.assertEqual([call["stdin"] for call in self.say.calls()][2:], ["Uno."])

    def test_the_trial_speaks_a_wav(self) -> None:
        speech, _spent, _first = self.models.speak(self.ref, "Ciao.", "federica_premium")
        self.assertEqual(speech.rate, 24_000)
        self.assertEqual(speech.wav[:4], b"RIFF")
        self.assertAlmostEqual(speech.seconds, 2 * len("Ciao.") / 24_000)


if __name__ == "__main__":
    unittest.main()
