"""A voice of macOS (D-290): `say` speaks, no model is loaded here.

The text goes to `say` on its standard input, never among the arguments
(visible with `ps`), and the audio comes back in a file of the private tmp
folder of the voice (data/voice/tmp), deleted as soon as it is read. `say`
writes WAV, 16-bit mono at the rate of the calls, so nothing is converted.
`say` falls back to the default voice without an error when the voice is not
installed: the voice is checked in `say -v '?'` before it speaks.

Standard library only: the tests run with a fake `say`.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .wav import AudioError

SAY = Path("/usr/bin/say")
RATE = 24_000
# A system voice as `say -v '?'` lists it; the same rule as SYSTEM_VOICE of packages/config.
SYSTEM_VOICE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ()._'-]{0,63}$")
LIST_LINE = re.compile(r"^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]{2,4}\s+#")
# Seconds a sentence may take: Federica writes 7.7 s of speech in 0.9 s.
SENTENCE_TIMEOUT = 30.0
LIST_TIMEOUT = 10.0
# The list of voices is read again after this long: a voice installed meanwhile is found.
LIST_MAX_AGE = 60.0


class SystemVoiceError(Exception):
    """A closed code: `unavailable` (no `say`), `missing` (voice not installed), `inference`."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_voice_list(text: str) -> list[str]:
    names = []
    for line in text.splitlines():
        match = LIST_LINE.match(line)
        if match and match.group(1).strip():
            names.append(match.group(1).strip())
    return names


def wav_pcm16(data: bytes, rate: int = RATE) -> bytes:
    """The samples of a WAV of `say`: PCM 16-bit mono at `rate`. `say` adds a
    FLLR chunk before the data, so the chunks are walked, not a fixed header."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioError("wav: not a RIFF WAVE file")
    offset = 12
    fmt = None
    while offset + 8 <= len(data):
        kind = data[offset : offset + 4]
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        body = data[offset + 8 : offset + 8 + size]
        if kind == b"fmt ":
            fmt = body
        elif kind == b"data":
            if fmt is None or len(fmt) < 16:
                raise AudioError("wav: data before the format")
            audio_format = int.from_bytes(fmt[0:2], "little")
            channels = int.from_bytes(fmt[2:4], "little")
            sample_rate = int.from_bytes(fmt[4:8], "little")
            bits = int.from_bytes(fmt[14:16], "little")
            if audio_format != 1 or channels != 1 or sample_rate != rate or bits != 16:
                raise AudioError("wav: not 16-bit mono PCM at the rate of the calls")
            return body[: len(body) - len(body) % 2]
        # Chunks are padded to an even size.
        offset += 8 + size + (size % 2)
    raise AudioError("wav: no data")


Runner = Callable[..., subprocess.CompletedProcess]


class SystemVoice:
    def __init__(self, tmp_dir: Path | None, say: Path = SAY, run: Runner = subprocess.run, clock: Callable[[], float] = time.monotonic) -> None:
        self._tmp = tmp_dir
        self._say = say
        self._run = run
        self._clock = clock
        self._names: list[str] | None = None
        self._read_at = 0.0
        self._lock = threading.Lock()

    def _env(self) -> dict[str, str]:
        # `say` needs nothing of ours; HOME and the user keep the system voices it finds.
        return {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "TMPDIR") if key in os.environ}

    def voices(self, fresh: bool = False) -> list[str]:
        if not self._say.is_file():
            raise SystemVoiceError("unavailable")
        with self._lock:
            if fresh or self._names is None or self._clock() - self._read_at >= LIST_MAX_AGE:
                try:
                    done = self._run([str(self._say), "-v", "?"], capture_output=True, timeout=LIST_TIMEOUT, env=self._env(), check=False)
                except (OSError, subprocess.SubprocessError) as error:
                    raise SystemVoiceError("unavailable") from error
                if done.returncode != 0:
                    raise SystemVoiceError("unavailable")
                self._names = parse_voice_list(done.stdout.decode("utf-8", "replace"))
                self._read_at = self._clock()
            return list(self._names)

    def check(self, name: str) -> None:
        """Raises unless `say` is here and the voice is installed (read again once before giving up)."""
        if not SYSTEM_VOICE.fullmatch(name):
            raise SystemVoiceError("missing")
        if name in self.voices():
            return
        if name not in self.voices(fresh=True):
            raise SystemVoiceError("missing")

    def speak(self, name: str, text: str) -> bytes:
        """One piece of text as 16-bit mono samples at RATE."""
        self.check(name)
        if self._tmp is None:
            raise SystemVoiceError("unavailable")
        self._tmp.mkdir(mode=0o700, parents=True, exist_ok=True)
        handle, path = tempfile.mkstemp(prefix="say-", suffix=".wav", dir=self._tmp)
        os.close(handle)
        try:
            arguments = [str(self._say), "-v", name, "--file-format=WAVE", f"--data-format=LEI16@{RATE}", "-o", path]
            try:
                done = self._run(arguments, input=text.encode("utf-8"), capture_output=True, timeout=SENTENCE_TIMEOUT, env=self._env(), check=False)
            except (OSError, subprocess.SubprocessError) as error:
                raise SystemVoiceError("inference") from error
            if done.returncode != 0:
                raise SystemVoiceError("inference")
            try:
                return wav_pcm16(Path(path).read_bytes())
            except (OSError, AudioError) as error:
                raise SystemVoiceError("inference") from error
        finally:
            # The audio of a sentence may say private things: never left behind.
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
