"""The speech models (D-066), loaded from data/models/<id> on first use and
dropped again when idle outside a call (D-074): they hold GBs the local model
needs the rest of the time.

mlx-audio is imported only here and only when a model is first needed: the
service starts in a second and the tests run without it. Loading and inference
happen on one worker thread, because MLX state is not meant to be shared
across threads; callers await `run`.
"""

from __future__ import annotations

import asyncio
import gc
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .numbers import numbers_in_words
from .wav import STT_RATE, encode_wav

# Same rule as the catalog ids (packages/config/src/catalog.ts).
MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
# A voice of any family: Kokoro "if_sara", Voxtral "it_female", Qwen3-TTS "serena" (D-067).
VOICE_ID = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
STT_FAMILIES = ("parakeet", "whisper")
TTS_FAMILIES = ("kokoro", "qwen3-tts", "qwen3-tts-base", "voxtral-tts")
# Both Qwen3-TTS families: numbers in words, a sentence each, in pieces, with a ceiling.
QWEN3_FAMILIES = ("qwen3-tts", "qwen3-tts-base")
LANGUAGE = "it"
SENTENCE_END = re.compile(r"([.!?;:])\s+")
# Kokoro's language code for Italian.
KOKORO_ITALIAN = "i"
# Qwen3-TTS names the language in full.
QWEN3_ITALIAN = "italian"


class ModelError(Exception):
    """A closed code: `missing`, `family`, `load`, `inference`. Never a message with text."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ModelRef:
    id: str
    family: str

    @staticmethod
    def parse(value: Any, families: tuple[str, ...]) -> "ModelRef":
        if not isinstance(value, dict) or set(value) != {"id", "family"}:
            raise ModelError("family")
        model_id, family = value["id"], value["family"]
        if not isinstance(model_id, str) or not MODEL_ID.match(model_id) or family not in families:
            raise ModelError("family")
        return ModelRef(model_id, family)


@dataclass(frozen=True)
class Speech:
    wav: bytes
    seconds: float
    rate: int


class Models:
    def __init__(self, models_dir: Path, clones_dir: Path | None = None) -> None:
        self._dir = models_dir
        # Voices copied from a sample (D-069): <id>/reference.wav and reference.txt, L2.
        self._clones = clones_dir
        self._loaded: dict[str, Any] = {}
        self._last_used = time.monotonic()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")

    def path_of(self, ref: ModelRef) -> Path:
        path = self._dir / ref.id
        # The id cannot leave the folder (MODEL_ID has no slash), and a link must not either.
        if not path.is_dir() or path.resolve().parent != self._dir.resolve():
            raise ModelError("missing")
        return path

    async def run(self, function, *args):
        self._last_used = time.monotonic()
        try:
            return await asyncio.get_running_loop().run_in_executor(self._worker, function, *args)
        finally:
            self._last_used = time.monotonic()

    def loaded(self) -> int:
        return len(self._loaded)

    def idle_seconds(self) -> float:
        """Since the last work began or ended. A job longer than the idle limit looks idle while
        it runs: harmless, the unload queues behind it on the single worker."""
        return time.monotonic() - self._last_used

    def close(self) -> None:
        self._worker.shutdown(wait=False, cancel_futures=True)

    # Everything below runs on the worker thread.

    def _load(self, ref: ModelRef) -> Any:
        if ref.id in self._loaded:
            return self._loaded[ref.id]
        path = str(self.path_of(ref))
        try:
            if ref.family in STT_FAMILIES:
                from mlx_audio.stt.utils import load as load_stt

                model = load_stt(path)
            else:
                from mlx_audio.tts.utils import load_model as load_tts

                model = load_tts(path)
        except ModelError:
            raise
        except Exception as error:  # noqa: BLE001 - the library raises anything
            raise ModelError("load") from error
        self._loaded[ref.id] = model
        return model

    def unload_all(self) -> int:
        """Drops every model and gives the memory back to the system; the next use loads again."""
        count = len(self._loaded)
        if count == 0:
            return 0
        self._loaded.clear()
        gc.collect()
        try:
            import mlx.core as mx

            clear = getattr(mx, "clear_cache", None) or mx.metal.clear_cache
            clear()
        except Exception:  # noqa: BLE001 - without MLX (tests) there is nothing to clear
            pass
        return count

    def warm(self, ref: ModelRef) -> None:
        """Loads a model now, so the first words of a call do not wait for it."""
        self._load(ref)

    def transcribe(self, ref: ModelRef, pcm16: bytes) -> tuple[str, float]:
        """Text and seconds spent, loading excluded."""
        model = self._load(ref)
        import mlx.core as mx
        import numpy as np

        audio = mx.array(np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0)
        started = time.monotonic()
        try:
            if ref.family == "whisper":
                result = model.generate(audio, language=LANGUAGE)
            else:
                result = model.generate(audio)
        except Exception as error:  # noqa: BLE001
            raise ModelError("inference") from error
        return str(getattr(result, "text", "")).strip(), time.monotonic() - started

    def speak(self, ref: ModelRef, text: str, voice: str) -> tuple[Speech, float, float]:
        """The speech as WAV, the seconds spent and the seconds to the first audio
        (what a call waits before Arianna speaks), loading excluded."""
        self._load(ref)
        pieces: list[bytes] = []
        rate = 24_000
        first: float | None = None
        started = time.monotonic()

        def collect(pcm16: bytes, piece_rate: int) -> None:
            nonlocal rate, first
            if first is None:
                first = time.monotonic() - started
            pieces.append(pcm16)
            rate = piece_rate

        self.speak_stream(ref, text, voice, collect, threading.Event())
        spent = time.monotonic() - started
        pcm16 = b"".join(pieces)
        return Speech(encode_wav(pcm16, rate), len(pcm16) / 2 / rate, rate), spent, spent if first is None else first

    def speak_stream(self, ref: ModelRef, text: str, voice: str, emit: Callable[[bytes, int], None], stop: threading.Event) -> None:
        """Says `text`, handing 16-bit mono samples and their rate to `emit` as the
        model makes them (D-068); stops between two pieces once `stop` is set."""
        model = self._load(ref)
        # verbose=False everywhere: the libraries would print what they say to the log.
        voice_file = self._voice_file(ref, voice)
        reference_text = self._reference_text(voice) if ref.family == "qwen3-tts-base" else None
        kwargs = {**speak_arguments(ref.family, voice, voice_file, reference_text), **stream_arguments(ref.family)}
        import numpy as np

        try:
            for part in speak_parts(ref.family, text):
                if stop.is_set():
                    return
                for result in model.generate(text=part, **kwargs, **part_limits(ref.family, part)):
                    if stop.is_set():
                        return
                    samples = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                    if samples.size:
                        emit((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes(), int(getattr(result, "sample_rate", 24_000)))
        except Exception as error:  # noqa: BLE001
            raise ModelError("inference") from error

    def _voice_file(self, ref: ModelRef, voice: str) -> str | None:
        """The file of the voice: in the model folder, or the sample of a copied
        voice (D-069); Qwen3-TTS speakers are not files."""
        if not VOICE_ID.match(voice):
            raise ModelError("family")
        if ref.family == "qwen3-tts-base":
            return str(self._clone_file(voice, "reference.wav"))
        folder = VOICE_FOLDERS.get(ref.family)
        if folder is None:
            return None
        path = self.path_of(ref) / folder / f"{voice}.safetensors"
        if not path.is_file():
            raise ModelError("missing")
        return str(path)


    def _clone_file(self, voice: str, name: str) -> Path:
        if self._clones is None or not VOICE_ID.match(voice):
            raise ModelError("missing")
        folder = self._clones / voice
        path = folder / name
        # Neither the folder nor the file may be a link out of the voices folder.
        if folder.is_symlink() or path.is_symlink() or not path.is_file() or path.resolve().parent.parent != self._clones.resolve():
            raise ModelError("missing")
        return path

    def _reference_text(self, voice: str) -> str:
        text = self._clone_file(voice, "reference.txt").read_text(encoding="utf-8").strip()
        if not text:
            raise ModelError("missing")
        return text


# Where each family keeps one file per voice (D-067).
VOICE_FOLDERS = {"kokoro": "voices", "voxtral-tts": "voice_embedding"}


def speak_parts(family: str, text: str) -> list[str]:
    """The text as each family generates it best; pure, for the tests."""
    if family == "kokoro":
        # Kokoro's Italian G2P does not chunk: one sentence per line, or a long text is cut.
        return [SENTENCE_END.sub("\\1\n", text)]
    if family in QWEN3_FAMILIES:
        # CustomVoice generates the whole text at once and drifts on long ones: a sentence
        # each. Digits it reads in English or Chinese, then goes on in that language: words.
        return [part for part in (piece.strip() for piece in SENTENCE_END.sub("\\1\n", numbers_in_words(text)).split("\n")) if part]
    return [text]


# Qwen3-TTS-12Hz makes 12.5 audio tokens a second.
QWEN3_TOKENS_PER_SECOND = 12.5
# Italian speech runs at about 15 characters a second; a sentence gets time for 5, plus 2 s.
SLOWEST_CHARS_PER_SECOND = 5


def stream_arguments(family: str) -> dict[str, Any]:
    """Qwen3-TTS hands its audio over in pieces of 0.64 s (D-068): the first after
    about 0.35 s, and faster than speech, so a call plays it without gaps. Kokoro
    is quick enough sentence by sentence; Voxtral is slower than speech, and
    pieces would leave holes. Pure, for the tests."""
    if family in QWEN3_FAMILIES:
        return {"stream": True, "streaming_interval": QWEN3_STREAM_SECONDS}
    return {}


QWEN3_STREAM_SECONDS = 0.64


def part_limits(family: str, part: str) -> dict[str, Any]:
    """A ceiling on the audio of one sentence: a model that does not stop is cut,
    instead of speaking for minutes in another language. Pure, for the tests."""
    if family not in QWEN3_FAMILIES:
        return {}
    return {"max_tokens": int(QWEN3_TOKENS_PER_SECOND * (len(part) / SLOWEST_CHARS_PER_SECOND + 2))}


def speak_arguments(family: str, voice: str, voice_file: str | None, reference_text: str | None = None) -> dict[str, Any]:
    """What `generate` of each family wants besides the text; pure, for the tests."""
    if family == "kokoro":
        return {"voice": voice_file, "lang_code": KOKORO_ITALIAN, "verbose": False}
    if family == "voxtral-tts":
        # Voxtral finds the voice by name among the files of voice_embedding/,
        # already checked to be there; the name says the language (it_female).
        return {"voice": voice, "verbose": False}
    if family == "qwen3-tts":
        return {"voice": voice, "lang_code": QWEN3_ITALIAN, "verbose": False}
    if family == "qwen3-tts-base":
        # The Base model copies the voice of the sample, told what the sample says.
        if voice_file is None or not reference_text:
            raise ModelError("missing")
        return {"ref_audio": voice_file, "ref_text": reference_text, "lang_code": QWEN3_ITALIAN, "verbose": False}
    raise ModelError("family")


__all__ = ["Models", "ModelError", "ModelRef", "Speech", "STT_FAMILIES", "TTS_FAMILIES", "STT_RATE"]
