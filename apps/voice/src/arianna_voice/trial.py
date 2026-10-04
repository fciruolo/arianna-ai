"""The voice trial page (D-066): the user reads a phrase, two STT models write
it; one reply is spoken by two TTS models. Validation is pure and tested
without the models; the core already checked the request and passes the
model ids from the catalog."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any

from .models import STT_FAMILIES, TTS_FAMILIES, VOICE_ID, ModelError, ModelRef
from .wav import STT_RATE

MIN_SECONDS = 0.3
MAX_SECONDS = 30
MAX_TEXT = 400


class RequestError(ValueError):
    """A request that breaks a rule: the message names the rule, never the content."""


@dataclass(frozen=True)
class TranscribeRequest:
    pcm16: bytes
    models: list[ModelRef]


@dataclass(frozen=True)
class SpeakRequest:
    text: str
    model: ModelRef
    voice: str


def _only(body: Any, allowed: set[str], required: set[str]) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise RequestError("body must be an object")
    unknown = set(body) - allowed
    if unknown:
        raise RequestError("unknown field(s): " + ", ".join(sorted(unknown)))
    missing = required - set(body)
    if missing:
        raise RequestError("missing field(s): " + ", ".join(sorted(missing)))
    return body


def _ref(value: Any, families: tuple[str, ...], where: str) -> ModelRef:
    try:
        return ModelRef.parse(value, families)
    except ModelError as error:
        raise RequestError(f"{where}: expected {{id, family}} with family in {', '.join(families)}") from error


def parse_transcribe(body: Any) -> TranscribeRequest:
    body = _only(body, {"pcm16", "rate", "models"}, {"pcm16", "rate", "models"})
    if body["rate"] != STT_RATE:
        raise RequestError(f"rate: must be {STT_RATE}")
    if not isinstance(body["pcm16"], str):
        raise RequestError("pcm16: base64 of 16-bit little-endian mono samples")
    try:
        pcm16 = base64.b64decode(body["pcm16"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise RequestError("pcm16: not base64") from error
    if len(pcm16) % 2 != 0:
        raise RequestError("pcm16: odd number of bytes")
    seconds = len(pcm16) / 2 / STT_RATE
    if seconds < MIN_SECONDS or seconds > MAX_SECONDS:
        raise RequestError(f"pcm16: between {MIN_SECONDS} and {MAX_SECONDS} seconds")
    models = body["models"]
    if not isinstance(models, list) or not 1 <= len(models) <= 4:
        raise RequestError("models: 1 to 4 speech-to-text models")
    refs = [_ref(item, STT_FAMILIES, f"models[{index}]") for index, item in enumerate(models)]
    if len({ref.id for ref in refs}) != len(refs):
        raise RequestError("models: a model is listed twice")
    return TranscribeRequest(pcm16, refs)


def parse_speak(body: Any) -> SpeakRequest:
    body = _only(body, {"text", "model", "voice"}, {"text", "model", "voice"})
    text = body["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise RequestError(f"text: 1 to {MAX_TEXT} characters")
    if any(ord(char) < 32 and char not in "\n\t" for char in text):
        raise RequestError("text: control characters are not allowed")
    voice = body["voice"]
    if not isinstance(voice, str) or not VOICE_ID.match(voice):
        raise RequestError("voice: a voice of the model, e.g. if_sara")
    return SpeakRequest(text.strip(), _ref(body["model"], TTS_FAMILIES, "model"), voice)
