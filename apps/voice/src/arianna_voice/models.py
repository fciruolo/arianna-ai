"""The speech models (D-066), loaded from data/models/<id> on first use.

mlx-audio is imported only here and only when a model is first needed: the
service starts in a second and the tests run without it. Loading and inference
happen on one worker thread, because MLX state is not meant to be shared
across threads; callers await `run`.
"""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .wav import STT_RATE, encode_wav

# Same rule as the catalog ids (packages/config/src/catalog.ts).
MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
VOICE_ID = re.compile(r"^[a-z]{2}_[a-z0-9]{1,32}$")
STT_FAMILIES = ("parakeet", "whisper")
TTS_FAMILIES = ("kokoro", "chatterbox")
LANGUAGE = "it"
# Kokoro's language code for Italian.
KOKORO_ITALIAN = "i"
# What Kokoro says so that Chatterbox, which has no voice of its own, can clone it.
REFERENCE_TEXT = "Ciao, sono Arianna. Questa è la mia voce di riferimento per la prova."


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
    def __init__(self, models_dir: Path, tmp_dir: Path) -> None:
        self._dir = models_dir
        self._tmp = tmp_dir
        self._loaded: dict[str, Any] = {}
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
        self._references: dict[tuple[str, str], Path] = {}

    def path_of(self, ref: ModelRef) -> Path:
        path = self._dir / ref.id
        # The id cannot leave the folder (MODEL_ID has no slash), and a link must not either.
        if not path.is_dir() or path.resolve().parent != self._dir.resolve():
            raise ModelError("missing")
        return path

    async def run(self, function, *args):
        return await asyncio.get_running_loop().run_in_executor(self._worker, function, *args)

    def close(self) -> None:
        self._worker.shutdown(wait=False, cancel_futures=True)
        for path in self._references.values():
            path.unlink(missing_ok=True)

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

    def speak(self, ref: ModelRef, text: str, voice: str, reference: ModelRef | None = None) -> tuple[Speech, float]:
        """The speech and the seconds spent, loading excluded."""
        model = self._load(ref)
        kwargs: dict[str, Any] = {}
        if ref.family == "kokoro":
            kwargs = {"voice": self._voice_file(ref, voice), "lang_code": KOKORO_ITALIAN, "verbose": False}
        else:
            if reference is None:
                raise ModelError("family")
            # verbose=False: the library would print what it says to the log.
            kwargs = {"ref_audio": str(self._reference(reference, voice)), "lang_code": LANGUAGE, "verbose": False}
        started = time.monotonic()
        try:
            pieces, rate = [], 24_000
            for result in model.generate(text=text, **kwargs):
                pieces.append(result.audio)
                rate = int(getattr(result, "sample_rate", rate))
        except Exception as error:  # noqa: BLE001
            raise ModelError("inference") from error
        spent = time.monotonic() - started
        import numpy as np

        samples = np.concatenate([np.asarray(piece, dtype=np.float32).reshape(-1) for piece in pieces]) if pieces else np.zeros(0, np.float32)
        pcm16 = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        return Speech(encode_wav(pcm16, rate), len(samples) / rate, rate), spent

    def _voice_file(self, ref: ModelRef, voice: str) -> str:
        if not VOICE_ID.match(voice):
            raise ModelError("family")
        path = self.path_of(ref) / "voices" / f"{voice}.safetensors"
        if not path.is_file():
            raise ModelError("missing")
        return str(path)

    def _reference(self, kokoro: ModelRef, voice: str) -> Path:
        """A WAV of Kokoro saying REFERENCE_TEXT, written once in the private tmp folder."""
        if kokoro.family != "kokoro":
            raise ModelError("family")
        key = (kokoro.id, voice)
        if key not in self._references:
            speech, _ = self.speak(kokoro, REFERENCE_TEXT, voice)
            handle, name = tempfile.mkstemp(prefix="reference-", suffix=".wav", dir=self._tmp)
            with os.fdopen(handle, "wb") as file:
                file.write(speech.wav)
            self._references[key] = Path(name)
        return self._references[key]


__all__ = ["Models", "ModelError", "ModelRef", "Speech", "STT_FAMILIES", "TTS_FAMILIES", "STT_RATE"]
