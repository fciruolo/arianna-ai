"""The request that opens a call (D-066), checked without Pipecat so the tests
run with the standard library. Only the core sends it, with the service
token; the call token inside is the one the voice shows the core back."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .models import STT_FAMILIES, TTS_FAMILIES, VOICE_ID, ModelRef
from .trial import RequestError

CALL_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# The core, on this machine only: the voice never calls anywhere else.
CORE_URL = re.compile(r"^http://(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$")
MAX_SDP = 64 * 1024
MAX_SAY = 2000


@dataclass(frozen=True)
class CallTexts:
    greeting: str
    warning: str
    goodbye: str


@dataclass(frozen=True)
class CallRequest:
    call_id: str
    token: str
    core_url: str
    sdp: str
    type: str
    stt: ModelRef
    tts: ModelRef
    voice: str
    # Chatterbox: the Kokoro model whose voice it clones.
    reference: ModelRef | None
    call_seconds: int
    warn_seconds: int
    texts: CallTexts


def _text(value: Any, where: str, limit: int = MAX_SAY) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise RequestError(f"{where}: 1 to {limit} characters")
    return value.strip()


def _ref(value: Any, families: tuple[str, ...], where: str) -> ModelRef:
    try:
        return ModelRef.parse(value, families)
    except Exception as error:  # noqa: BLE001 - ModelError, any shape
        raise RequestError(f"{where}: expected {{id, family}}") from error


def parse_call(body: Any) -> CallRequest:
    fields = {"callId", "token", "coreUrl", "sdp", "type", "stt", "tts", "voice", "limits", "texts"}
    if not isinstance(body, dict) or not fields <= set(body) <= fields | {"reference"}:
        raise RequestError("fields: " + ", ".join(sorted(fields)) + " and, for Chatterbox, reference")
    call_id = body["callId"]
    if not isinstance(call_id, str) or not CALL_ID.match(call_id):
        raise RequestError("callId: a uuid")
    token = body["token"]
    if not isinstance(token, str) or not 32 <= len(token) <= 128:
        raise RequestError("token: 32 to 128 characters")
    core_url = body["coreUrl"]
    if not isinstance(core_url, str) or not CORE_URL.match(core_url):
        raise RequestError("coreUrl: http on 127.0.0.1 or [::1]")
    if body["type"] != "offer":
        raise RequestError("type: offer")
    sdp = body["sdp"]
    if not isinstance(sdp, str) or not sdp.startswith("v=0") or len(sdp) > MAX_SDP:
        raise RequestError("sdp: a WebRTC offer")
    voice = body["voice"]
    if not isinstance(voice, str) or not VOICE_ID.match(voice):
        raise RequestError("voice: a Kokoro voice id")
    limits = body["limits"]
    if not isinstance(limits, dict) or set(limits) != {"callSeconds", "warnSeconds"}:
        raise RequestError("limits: callSeconds and warnSeconds")
    call_seconds, warn_seconds = limits["callSeconds"], limits["warnSeconds"]
    if not isinstance(call_seconds, int) or not 60 <= call_seconds <= 7200 or not isinstance(warn_seconds, int) or not 0 <= warn_seconds < call_seconds:
        raise RequestError("limits: 60 to 7200 seconds, the warning before the end")
    texts = body["texts"]
    if not isinstance(texts, dict) or set(texts) != {"greeting", "warning", "goodbye"}:
        raise RequestError("texts: greeting, warning and goodbye")
    tts = _ref(body["tts"], TTS_FAMILIES, "tts")
    reference = None
    if tts.family == "chatterbox":
        if "reference" not in body:
            raise RequestError("reference: Chatterbox needs the Kokoro model whose voice it clones")
        reference = _ref(body["reference"], ("kokoro",), "reference")
    elif "reference" in body:
        raise RequestError("reference: only for Chatterbox")
    return CallRequest(
        call_id=call_id,
        token=token,
        core_url=core_url,
        sdp=sdp,
        type="offer",
        stt=_ref(body["stt"], STT_FAMILIES, "stt"),
        tts=tts,
        voice=voice,
        reference=reference,
        call_seconds=call_seconds,
        warn_seconds=warn_seconds,
        texts=CallTexts(*(_text(texts[key], f"texts.{key}") for key in ("greeting", "warning", "goodbye"))),
    )


def parse_say(body: Any) -> str:
    if not isinstance(body, dict) or set(body) != {"text"}:
        raise RequestError("fields: text")
    return _text(body["text"], "text")


def schedule(call_seconds: int, warn_seconds: int) -> list[tuple[float, str]]:
    """When the call speaks on its own: (seconds from the start, which text)."""
    marks = [(float(call_seconds), "goodbye")]
    if warn_seconds > 0:
        marks.insert(0, (float(call_seconds - warn_seconds), "warning"))
    return marks


def last_user_words(messages: list[Any]) -> str:
    """The user's words since the last reply, from an LLM context: what the core must hear."""
    words: list[str] = []
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            break
        if role != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            words.append(content)
        elif isinstance(content, list):
            words.append(" ".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"))
    return " ".join(part.strip() for part in reversed(words) if part.strip())
