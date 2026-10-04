"""Numbers in Italian words and the ceiling on a sentence (D-067): standard library only."""

from __future__ import annotations

import unittest

from arianna_voice.models import part_limits, speak_parts
from arianna_voice.numbers import integer_words, numbers_in_words


class IntegerWordsTest(unittest.TestCase):
    def test_words(self) -> None:
        cases = {
            0: "zero",
            1: "uno",
            3: "tre",
            16: "sedici",
            21: "ventuno",
            23: "ventitré",
            28: "ventotto",
            40: "quaranta",
            100: "cento",
            101: "centouno",
            999: "novecentonovantanove",
            1000: "mille",
            1427: "millequattrocentoventisette",
            2000: "duemila",
            21000: "ventunomila",
            1_000_000: "un milione",
            1_200_000: "un milione duecentomila",
            3_000_000_005: "tre miliardi cinque",
        }
        for number, words in cases.items():
            with self.subTest(number=number):
                self.assertEqual(integer_words(number), words)

    def test_out_of_range(self) -> None:
        for number in (-1, 10**12):
            with self.assertRaises(ValueError):
                integer_words(number)


class NumbersInWordsTest(unittest.TestCase):
    def test_replaced(self) -> None:
        self.assertEqual(numbers_in_words("la fattura 1427 e"), "la fattura millequattrocentoventisette e")
        self.assertEqual(numbers_in_words("costa 1.250 euro"), "costa milleduecentocinquanta euro")
        self.assertEqual(numbers_in_words("3,5 chili"), "tre virgola cinque chili")
        self.assertEqual(numbers_in_words("2,05 metri"), "due virgola zero cinque metri")
        self.assertEqual(numbers_in_words("alle 9 e 30."), "alle nove e trenta.")
        # A long run of digits or a leading zero is a code: one digit at a time.
        self.assertEqual(numbers_in_words("chiama 0612"), "chiama zero sei uno due")
        self.assertEqual(numbers_in_words("1234567890123"), " ".join("uno due tre quattro cinque sei sette otto nove zero uno due tre".split()))

    def test_left_alone(self) -> None:
        for text in ("Ciao, sono Arianna.", "Qwen3 e mp3", "la stanza B12", ""):
            with self.subTest(text=text):
                self.assertEqual(numbers_in_words(text), text)


class QwenPartsTest(unittest.TestCase):
    def test_numbers_become_words_for_qwen_only(self) -> None:
        self.assertEqual(speak_parts("qwen3-tts", "La fattura 1427. Fatto."), ["La fattura millequattrocentoventisette.", "Fatto."])
        self.assertEqual(speak_parts("voxtral-tts", "La fattura 1427."), ["La fattura 1427."])

    def test_ceiling(self) -> None:
        # 6 characters: 3.2 s at most, 40 tokens of 80 ms.
        self.assertEqual(part_limits("qwen3-tts", "Certo!"), {"max_tokens": 40})
        self.assertEqual(part_limits("qwen3-tts", "x" * 100), {"max_tokens": 275})
        self.assertEqual(part_limits("kokoro", "Certo!"), {})
        self.assertEqual(part_limits("voxtral-tts", "Certo!"), {})


if __name__ == "__main__":
    unittest.main()
