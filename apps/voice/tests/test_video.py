"""Pure parts of the video steps (D-273): run with the standard library alone, or in the venv (pnpm test:voice)."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from arianna_voice import video
from arianna_voice.video import StepError, clean_meta, error_code, ffmpeg_argv, segments_of, ytdlp_argv

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
PROXY = "http://arianna:" + "a" * 24 + "@127.0.0.1:5555"
FOLDER = Path("/tmp/arianna-video-test")


class ArgvTest(unittest.TestCase):
    def test_every_step_is_closed(self) -> None:
        for step, extra in (("meta", {}), ("subs", {"lang": "en", "auto": True}), ("audio", {"max_audio": 300})):
            argv = ytdlp_argv(step, URL, PROXY, FOLDER, "/opt/homebrew/bin/deno", **extra)
            for option in ("--ignore-config", "--no-cache-dir", "--no-playlist", "--no-cookies", "--no-cookies-from-browser", "--no-remote-components", "--no-js-runtimes"):
                self.assertIn(option, argv, step)
            self.assertEqual(argv[argv.index("--use-extractors") + 1], "youtube")
            self.assertEqual(argv[argv.index("--proxy") + 1], PROXY)
            self.assertEqual(argv[argv.index("--js-runtimes") + 1], "deno:/opt/homebrew/bin/deno")
            # The address comes last, after "--": nothing in it is read as an option.
            self.assertEqual(argv[-2:], ["--", URL])

    def test_subtitles_and_audio(self) -> None:
        subs = ytdlp_argv("subs", URL, PROXY, FOLDER, None, lang="it", auto=False)
        self.assertIn("--write-subs", subs)
        self.assertNotIn("--write-auto-subs", subs)
        self.assertNotIn("--js-runtimes", subs)
        self.assertEqual(subs[subs.index("--sub-format") + 1], "vtt")
        audio = ytdlp_argv("audio", URL, PROXY, FOLDER, None, max_audio=1234)
        self.assertEqual(audio[audio.index("--max-filesize") + 1], "1234")
        self.assertNotIn("--skip-download", audio)

    def test_refused(self) -> None:
        bad = [
            ("meta", "https://youtu.be/dQw4w9WgXcQ", PROXY, FOLDER, None, {}),
            ("meta", URL + "&t=1", PROXY, FOLDER, None, {}),
            ("meta", URL, "http://127.0.0.1:5555", FOLDER, None, {}),
            ("meta", URL, "http://arianna:" + "a" * 24 + "@10.0.0.1:5555", FOLDER, None, {}),
            ("meta", URL, PROXY, Path("relative"), None, {}),
            ("meta", URL, PROXY, FOLDER, "deno", {}),
            ("subs", URL, PROXY, FOLDER, None, {"lang": "en;rm"}),
            ("subs", URL, PROXY, FOLDER, None, {}),
            ("audio", URL, PROXY, FOLDER, None, {}),
            ("transcribe", URL, PROXY, FOLDER, None, {}),
        ]
        for step, url, proxy, folder, deno, extra in bad:
            with self.assertRaises(StepError):
                ytdlp_argv(step, url, proxy, folder, deno, **extra)

    def test_ffmpeg_reads_files_only(self) -> None:
        argv = ffmpeg_argv("/opt/homebrew/bin/ffmpeg", FOLDER / "audio.m4a", FOLDER / "audio.pcm", 7200)
        self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
        self.assertEqual(argv[argv.index("-t") + 1], "7200")
        self.assertEqual(argv[argv.index("-ar") + 1], "16000")
        with self.assertRaises(StepError):
            ffmpeg_argv("ffmpeg", FOLDER / "a", FOLDER / "b", 10)
        with self.assertRaises(StepError):
            ffmpeg_argv("/x/ffmpeg", FOLDER / "a", FOLDER / "b", 0)


class MetaTest(unittest.TestCase):
    def test_keeps_only_what_the_core_needs(self) -> None:
        meta = clean_meta(
            {
                "id": "dQw4w9WgXcQ",
                "title": "  Un   video\ninventato ",
                "channel": "Canale finto",
                "duration": 754,
                "language": "it",
                "description": "testo lungo che non serve",
                "chapters": [{"start_time": 0, "title": "Inizio"}, {"start_time": 60.5, "title": "Parte due"}, {"title": "senza inizio"}],
                "subtitles": {"it": [{"ext": "vtt"}, {"ext": "srv3"}], "en": [{"ext": "json3"}], "bad lang": [{"ext": "vtt"}]},
                "automatic_captions": {"it-orig": [{"ext": "vtt"}], "en": [{"ext": "vtt"}]},
                "live_status": "was_live",
            }
        )
        self.assertEqual(meta["title"], "Un video inventato")
        self.assertEqual(meta["duration"], 754.0)
        self.assertFalse(meta["live"])
        self.assertEqual(meta["chapters"], [{"start": 0.0, "title": "Inizio"}, {"start": 60.5, "title": "Parte due"}])
        self.assertEqual(meta["subtitles"], ["it"])
        self.assertEqual(meta["automatic"], ["it-orig", "en"])
        self.assertNotIn("description", meta)

    def test_live_and_not_a_video(self) -> None:
        self.assertTrue(clean_meta({"id": "x", "is_live": True})["live"])
        self.assertTrue(clean_meta({"id": "x", "live_status": "is_upcoming"})["live"])
        self.assertIsNone(clean_meta({"id": "x"})["duration"])
        with self.assertRaises(StepError):
            clean_meta({"_type": "playlist"})
        with self.assertRaises(StepError):
            clean_meta(None)

    def test_error_codes(self) -> None:
        self.assertEqual(error_code("ERROR: [youtube] x: Private video. Sign in"), "unavailable")
        self.assertEqual(error_code("ERROR: Video unavailable"), "unavailable")
        self.assertEqual(error_code("Sign in to confirm you’re not a bot"), "bot-check")
        self.assertEqual(error_code("Unable to connect to proxy"), "network")
        self.assertEqual(error_code("nsig extraction failed"), "download-failed")


class SegmentsTest(unittest.TestCase):
    def test_sentences_of_parakeet(self) -> None:
        sentences = [
            SimpleNamespace(start=0.4, text=" Buongiorno  a tutti. "),
            SimpleNamespace(start=-1, text="Prima dell'inizio."),
            SimpleNamespace(start=12.345, text="   "),
            SimpleNamespace(start="x", text="Senza tempo."),
            SimpleNamespace(start=61.0, text="Oggi parliamo di Laravel."),
        ]
        self.assertEqual(
            segments_of(sentences),
            [{"start": 0.4, "text": "Buongiorno a tutti."}, {"start": 0.0, "text": "Prima dell'inizio."}, {"start": 61.0, "text": "Oggi parliamo di Laravel."}],
        )
        self.assertEqual(segments_of(None), [])


class MainTest(unittest.TestCase):
    def answer(self, argv: list[str], env: dict[str, str]) -> dict:
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["video", *argv]), mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "stdout", out):
            video.main()
        return json.loads(out.getvalue())

    def test_only_a_code_comes_out(self) -> None:
        self.assertEqual(self.answer(["nothing"], {}), {"ok": False, "error": "bad-request"})
        self.assertEqual(self.answer(["meta"], {}), {"ok": False, "error": "bad-request"})
        with tempfile.TemporaryDirectory() as folder:
            env = {"ARIANNA_VIDEO_DIR": folder, "ARIANNA_VIDEO_URL": URL, "ARIANNA_VIDEO_PROXY": PROXY}
            with mock.patch.object(video, "_ytdlp", side_effect=StepError("unavailable")):
                self.assertEqual(self.answer(["meta"], env), {"ok": False, "error": "unavailable"})
            with mock.patch.object(video, "_ytdlp", side_effect=RuntimeError("Titolo segreto del video")):
                answer = self.answer(["meta"], env)
            self.assertEqual(answer, {"ok": False, "error": "download-failed"})

    def test_subtitles_file_and_audio_limit(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            env = {"ARIANNA_VIDEO_DIR": folder, "ARIANNA_VIDEO_URL": URL, "ARIANNA_VIDEO_PROXY": PROXY, "ARIANNA_VIDEO_SUB_LANG": "it", "ARIANNA_VIDEO_MAX_AUDIO": "10"}
            with mock.patch.object(video, "_ytdlp", return_value={}):
                self.assertEqual(self.answer(["subs"], env), {"ok": False, "error": "no-subtitles"})
                Path(folder, "subs.it.vtt").write_text("WEBVTT\n")
                self.assertEqual(self.answer(["subs"], env), {"ok": True, "file": "subs.it.vtt"})
                self.assertEqual(self.answer(["audio"], env), {"ok": False, "error": "too-large"})
                Path(folder, "audio.m4a").write_bytes(b"x" * 11)
                self.assertEqual(self.answer(["audio"], env), {"ok": False, "error": "too-large"})
                self.assertFalse(Path(folder, "audio.m4a").exists())
                Path(folder, "audio.m4a").write_bytes(b"x" * 5)
                self.assertEqual(self.answer(["audio"], env), {"ok": True, "file": "audio.m4a", "bytes": 5})


if __name__ == "__main__":
    unittest.main()
