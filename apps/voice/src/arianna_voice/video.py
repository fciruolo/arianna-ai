"""One step of the summary of a YouTube video (D-273, tappa A), started by the core.

    python -m arianna_voice.video meta | subs | audio | transcribe

Everything comes from the environment the core builds, never from the
arguments (they are visible to every process of the machine):

- `ARIANNA_VIDEO_DIR`: the private folder of the job (data/voice/tmp/video/<job>,
  0700), where files go; the core removes it when the job ends.
- `meta`, `subs`, `audio`: `ARIANNA_VIDEO_URL` (the one normalized address that
  left through the gateway), `ARIANNA_VIDEO_PROXY` (the proxy of the core, with
  its token), `ARIANNA_DENO` (the path of Deno, optional); `subs` also
  `ARIANNA_VIDEO_SUB_LANG` and `ARIANNA_VIDEO_SUB_AUTO` (`1` for the automatic
  ones); `audio` also `ARIANNA_VIDEO_MAX_AUDIO` (bytes).
- `transcribe`, in a process without network: `ARIANNA_VIDEO_AUDIO` (a file name
  in the folder), `ARIANNA_FFMPEG`, `ARIANNA_STT_MODEL` (the folder of Parakeet)
  and `ARIANNA_VIDEO_MAX_SECONDS`.

yt-dlp runs with the same options as its command line `--ignore-config
--no-cache-dir --use-extractors youtube --no-playlist --proxy … --no-cookies
--no-cookies-from-browser --no-remote-components --no-js-runtimes [--js-runtimes
deno:<path>]`, read by its own parser, with a HOME of the job and no cookie. Its
messages are never printed: they may hold the title or the address. The answer
is one JSON line on stdout, `{"ok": true, …}` or `{"ok": false, "error": <code>}`
with a code of a closed list.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

VIDEO_URL = re.compile(r"^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$")
PROXY_URL = re.compile(r"^http://arianna:[A-Za-z0-9_-]{20,64}@127\.0\.0\.1:\d{1,5}$")
LANG = re.compile(r"^[A-Za-z0-9-]{1,20}$")
STEPS = ("meta", "subs", "audio", "transcribe")
ERRORS = (
    "bad-request",
    "not-installed",
    "unavailable",
    "bot-check",
    "network",
    "too-large",
    "no-subtitles",
    "download-failed",
    "no-ffmpeg",
    "transcribe-failed",
    "empty",
)
MAX_CHAPTERS = 100
MAX_LANGS = 400
MAX_TITLE = 300
STT_RATE = 16_000
SOCKET_TIMEOUT = "30"


class StepError(Exception):
    """A closed code of ERRORS: never a message with text of the video."""

    def __init__(self, code: str) -> None:
        if code not in ERRORS:
            code = "download-failed"
        super().__init__(code)
        self.code = code


def ytdlp_argv(step: str, url: str, proxy: str, folder: Path, deno: str | None, lang: str | None = None, auto: bool = False, max_audio: int | None = None) -> list[str]:
    """The command line of yt-dlp for one step; pure, for the tests."""
    if step not in ("meta", "subs", "audio") or not VIDEO_URL.match(url) or not PROXY_URL.match(proxy) or not folder.is_absolute():
        raise StepError("bad-request")
    argv = [
        "--ignore-config",
        "--no-cache-dir",
        "--use-extractors",
        "youtube",
        "--no-playlist",
        "--proxy",
        proxy,
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-remote-components",
        "--no-js-runtimes",
        "--socket-timeout",
        SOCKET_TIMEOUT,
        "--no-mtime",
        "--no-write-info-json",
        "--no-write-comments",
        "--no-write-thumbnail",
        "--paths",
        str(folder),
    ]
    if deno is not None:
        if not os.path.isabs(deno):
            raise StepError("bad-request")
        argv += ["--js-runtimes", f"deno:{deno}"]
    if step == "meta":
        argv += ["--skip-download"]
    elif step == "subs":
        if lang is None or not LANG.match(lang):
            raise StepError("bad-request")
        argv += ["--skip-download", "--write-auto-subs" if auto else "--write-subs", "--sub-langs", lang, "--sub-format", "vtt", "--output", "subs.%(ext)s"]
    else:
        if max_audio is None or max_audio <= 0:
            raise StepError("bad-request")
        argv += ["--format", "bestaudio[ext=m4a]/bestaudio", "--max-filesize", str(max_audio), "--output", "audio.%(ext)s"]
    return argv + ["--", url]


def _langs(tracks: Any) -> list[str]:
    """The languages with a vtt track, at most MAX_LANGS."""
    if not isinstance(tracks, dict):
        return []
    found: list[str] = []
    for lang, formats in tracks.items():
        if not isinstance(lang, str) or not LANG.match(lang) or not isinstance(formats, list):
            continue
        if any(isinstance(item, dict) and item.get("ext") == "vtt" for item in formats):
            found.append(lang)
        if len(found) >= MAX_LANGS:
            break
    return found


def _text(value: Any, limit: int = MAX_TITLE) -> str | None:
    if not isinstance(value, str):
        return None
    clean = " ".join(value.split())
    return clean[:limit] if clean else None


def clean_meta(info: Any) -> dict[str, Any]:
    """What the core needs of the metadata, nothing else; pure, for the tests."""
    if not isinstance(info, dict) or info.get("_type", "video") != "video":
        raise StepError("unavailable")
    duration = info.get("duration")
    chapters = []
    for chapter in info.get("chapters") or []:
        if not isinstance(chapter, dict):
            continue
        start = chapter.get("start_time")
        title = _text(chapter.get("title"), 200)
        if isinstance(start, (int, float)) and start >= 0 and title is not None:
            chapters.append({"start": float(start), "title": title})
        if len(chapters) >= MAX_CHAPTERS:
            break
    live = info.get("live_status")
    return {
        "id": info.get("id") if isinstance(info.get("id"), str) else None,
        "title": _text(info.get("title")),
        "channel": _text(info.get("channel")) or _text(info.get("uploader")),
        "duration": float(duration) if isinstance(duration, (int, float)) and duration >= 0 else None,
        "live": info.get("is_live") is True or live in ("is_live", "is_upcoming"),
        "language": info.get("language") if isinstance(info.get("language"), str) and LANG.match(info["language"]) else None,
        "chapters": chapters,
        "subtitles": _langs(info.get("subtitles")),
        "automatic": _langs(info.get("automatic_captions")),
    }


def error_code(message: str) -> str:
    """The code of an error of yt-dlp from its message, which is never printed."""
    text = message.lower()
    if "not a bot" in text or ("confirm you" in text and "bot" in text):
        return "bot-check"
    if any(part in text for part in ("private video", "video unavailable", "video is not available", "video is unavailable", "has been removed", "members-only", "members only", "join this channel", "confirm your age", "age-restricted", "premieres in", "this live event")):
        return "unavailable"
    if any(part in text for part in ("proxy", "timed out", "connection refused", "connection reset", "network is unreachable", "name resolution", "ssl")):
        return "network"
    return "download-failed"


class _Silent:
    """The logger of yt-dlp: nothing it says reaches a log or the core."""

    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, _message: str) -> None:
        pass


def _ytdlp(argv: list[str], download: bool) -> dict[str, Any]:
    try:
        import yt_dlp
    except ImportError as error:
        raise StepError("not-installed") from error
    try:
        parsed = yt_dlp.parse_options(argv)
    except SystemExit as error:
        raise StepError("bad-request") from error
    options = dict(parsed.ydl_opts)
    # The command line ignores download errors by default ("only_download"): here every error is an answer.
    options.update({"logger": _Silent(), "quiet": True, "no_warnings": True, "noprogress": True, "consoletitle": False, "ignoreerrors": False})
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(parsed.urls[0], download=download)
            if info is None:
                raise StepError("download-failed")
            return ydl.sanitize_info(info)
    except StepError:
        raise
    except Exception as error:  # noqa: BLE001 - yt-dlp raises many kinds; only the code goes out
        raise StepError(error_code(str(error))) from None


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if value == "":
        raise StepError("bad-request")
    return value


def _folder() -> Path:
    folder = Path(_env("ARIANNA_VIDEO_DIR"))
    if not folder.is_absolute() or not folder.is_dir():
        raise StepError("bad-request")
    return folder


def _deno() -> str | None:
    return os.environ.get("ARIANNA_DENO") or None


def _only_file(folder: Path, prefix: str) -> Path | None:
    files = sorted(path for path in folder.iterdir() if path.is_file() and path.name.startswith(prefix) and not path.name.endswith(".part"))
    return files[0] if len(files) == 1 else None


def step_meta() -> dict[str, Any]:
    folder = _folder()
    argv = ytdlp_argv("meta", _env("ARIANNA_VIDEO_URL"), _env("ARIANNA_VIDEO_PROXY"), folder, _deno())
    return {"ok": True, "meta": clean_meta(_ytdlp(argv, download=False))}


def step_subs() -> dict[str, Any]:
    folder = _folder()
    auto = os.environ.get("ARIANNA_VIDEO_SUB_AUTO") == "1"
    argv = ytdlp_argv("subs", _env("ARIANNA_VIDEO_URL"), _env("ARIANNA_VIDEO_PROXY"), folder, _deno(), _env("ARIANNA_VIDEO_SUB_LANG"), auto)
    _ytdlp(argv, download=True)
    found = _only_file(folder, "subs.")
    if found is None or found.suffix != ".vtt":
        raise StepError("no-subtitles")
    return {"ok": True, "file": found.name}


def step_audio() -> dict[str, Any]:
    folder = _folder()
    max_audio = int(_env("ARIANNA_VIDEO_MAX_AUDIO"))
    argv = ytdlp_argv("audio", _env("ARIANNA_VIDEO_URL"), _env("ARIANNA_VIDEO_PROXY"), folder, _deno(), max_audio=max_audio)
    _ytdlp(argv, download=True)
    found = _only_file(folder, "audio.")
    # Larger than the limit: yt-dlp skips it without an error.
    if found is None:
        raise StepError("too-large")
    size = found.stat().st_size
    if size > max_audio:
        found.unlink(missing_ok=True)
        raise StepError("too-large")
    return {"ok": True, "file": found.name, "bytes": size}


def ffmpeg_argv(ffmpeg: str, source: Path, target: Path, max_seconds: int) -> list[str]:
    """ffmpeg to raw PCM 16 kHz mono, files only (no protocol of the network); pure, for the tests."""
    if not os.path.isabs(ffmpeg) or not source.is_absolute() or not target.is_absolute() or max_seconds <= 0:
        raise StepError("bad-request")
    return [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-i",
        str(source),
        "-t",
        str(max_seconds),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(STT_RATE),
        "-f",
        "s16le",
        "-y",
        str(target),
    ]


def segments_of(sentences: Any) -> list[dict[str, Any]]:
    """The sentences of Parakeet as `{start, text}`, in order, empty ones out; pure, for the tests."""
    out: list[dict[str, Any]] = []
    for sentence in sentences or []:
        start = getattr(sentence, "start", None)
        text = getattr(sentence, "text", None)
        if not isinstance(start, (int, float)) or not isinstance(text, str):
            continue
        clean = " ".join(text.split())
        if clean:
            out.append({"start": round(max(0.0, float(start)), 2), "text": clean})
    return out


def step_transcribe() -> dict[str, Any]:
    folder = _folder()
    name = _env("ARIANNA_VIDEO_AUDIO")
    if "/" in name or name.startswith("."):
        raise StepError("bad-request")
    source = folder / name
    if not source.is_file():
        raise StepError("bad-request")
    ffmpeg = _env("ARIANNA_FFMPEG")
    if not os.path.isfile(ffmpeg):
        raise StepError("no-ffmpeg")
    target = folder / "audio.pcm"
    max_seconds = int(_env("ARIANNA_VIDEO_MAX_SECONDS"))
    try:
        done = subprocess.run(ffmpeg_argv(ffmpeg, source, target, max_seconds), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except OSError as error:
        raise StepError("no-ffmpeg") from error
    if done.returncode != 0 or not target.is_file():
        raise StepError("transcribe-failed")
    try:
        import mlx.core as mx
        import numpy as np
        from mlx_audio.stt.utils import load as load_stt
    except ImportError as error:
        raise StepError("not-installed") from error
    try:
        samples = np.fromfile(target, dtype="<i2").astype(np.float32) / 32768.0
        target.unlink(missing_ok=True)
        if samples.size == 0:
            raise StepError("empty")
        model = load_stt(_env("ARIANNA_STT_MODEL"))
        result = model.generate(mx.array(samples), chunk_duration=60.0, overlap_duration=5.0)
    except StepError:
        raise
    except Exception as error:  # noqa: BLE001 - the library raises anything
        raise StepError("transcribe-failed") from error
    segments = segments_of(getattr(result, "sentences", None))
    if not segments:
        raise StepError("empty")
    return {"ok": True, "segments": segments, "seconds": round(samples.size / STT_RATE, 1)}


def run(step: str) -> dict[str, Any]:
    if step == "meta":
        return step_meta()
    if step == "subs":
        return step_subs()
    if step == "audio":
        return step_audio()
    if step == "transcribe":
        return step_transcribe()
    raise StepError("bad-request")


def main() -> None:
    step = sys.argv[1] if len(sys.argv) == 2 else ""
    # Whatever a library prints goes to stderr; stdout holds only the answer.
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        answer = run(step) if step in STEPS else {"ok": False, "error": "bad-request"}
    except StepError as error:
        answer = {"ok": False, "error": error.code}
    except Exception:  # noqa: BLE001 - never a message: it may hold the title
        answer = {"ok": False, "error": "download-failed" if step != "transcribe" else "transcribe-failed"}
    out.write(json.dumps(answer, ensure_ascii=False) + "\n")
    out.flush()


if __name__ == "__main__":
    main()
