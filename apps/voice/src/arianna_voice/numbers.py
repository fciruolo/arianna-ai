"""Numbers as Italian words, for the speech models that read digits in another
language (D-067: Qwen3-TTS says "1427" in English or Chinese and goes on in
that language). Pure, standard library only."""

from __future__ import annotations

import re

UNITS = (
    "zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici "
    "quattordici quindici sedici diciassette diciotto diciannove"
).split()
TENS = "_ _ venti trenta quaranta cinquanta sessanta settanta ottanta novanta".split()
# Longer runs of digits are codes or phone numbers: one digit at a time.
MAX_DIGITS = 12
# An integer with Italian thousand dots (1.427.000) or plain, optionally a decimal comma.
NUMBER = re.compile(r"(?<![\w.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?![\w])")


def _below_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    head = "" if hundreds == 0 else "cento" if hundreds == 1 else UNITS[hundreds] + "cento"
    if rest == 0:
        return head
    if rest < 20:
        tail = UNITS[rest]
    else:
        tens, unit = divmod(rest, 10)
        word = TENS[tens]
        if unit in (1, 8):
            # ventuno, trentotto: the tens drop their last vowel.
            word = word[:-1]
        tail = word + ("" if unit == 0 else "tré" if unit == 3 else UNITS[unit])
    return head + tail


def integer_words(n: int) -> str:
    """0 to 999 999 999 999 in words: 1427 → millequattrocentoventisette."""
    if n < 0 or n >= 10**12:
        raise ValueError("out of range")
    if n == 0:
        return "zero"
    parts = []
    for size, one, many in ((10**9, "un miliardo", "miliardi"), (10**6, "un milione", "milioni")):
        count, n = divmod(n, size)
        if count == 1:
            parts.append(one)
        elif count > 1:
            parts.append(f"{integer_words(count)} {many}")
    thousands, n = divmod(n, 1000)
    words = "" if thousands == 0 else "mille" if thousands == 1 else _below_thousand(thousands) + "mila"
    words += _below_thousand(n) if n else ""
    if words:
        parts.append(words)
    return " ".join(parts)


def _digits(text: str) -> str:
    return " ".join(UNITS[int(char)] for char in text)


def _replace(match: re.Match[str]) -> str:
    whole, decimals = match.group(1), match.group(2)
    plain = whole.replace(".", "")
    if len(plain) > MAX_DIGITS or (len(plain) > 1 and plain.startswith("0") and "." not in whole):
        words = _digits(plain)
    else:
        words = integer_words(int(plain))
    if decimals is not None:
        words += " virgola " + (_digits(decimals) if decimals.startswith("0") or len(decimals) > 3 else integer_words(int(decimals)))
    return words


def numbers_in_words(text: str) -> str:
    """Every number of the text as Italian words; everything else unchanged."""
    return NUMBER.sub(_replace, text)


__all__ = ["integer_words", "numbers_in_words"]
