"""WAV helpers, standard library only, so the tests run without the models."""

from __future__ import annotations

import struct

# The rate the speech-to-text models expect (Parakeet and Whisper).
STT_RATE = 16_000


class AudioError(ValueError):
    """Audio that cannot be used: the message names the rule, never the content."""


def encode_wav(pcm16: bytes, rate: int, channels: int = 1) -> bytes:
    """A canonical 44-byte header WAV, PCM 16-bit."""
    if len(pcm16) % (2 * channels) != 0:
        raise AudioError("wav: incomplete frame")
    block = 2 * channels
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm16),
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        rate,
        rate * block,
        block,
        16,
        b"data",
        len(pcm16),
    )
    return header + pcm16
