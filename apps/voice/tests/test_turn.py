"""The end of the user's turn (D-073): a transcript is final, so the turn
waits only for the silence, not for the safety net of the stt."""

from __future__ import annotations

import unittest
from typing import Any

try:
    from pipecat.frames.frames import TranscriptionFrame

    from arianna_voice.calls import STT_P99_SECONDS, TURN_SILENCE, MlxSTT, watch_turns
    from arianna_voice.models import ModelRef
except ImportError:
    MlxSTT = None


class FakeModels:
    def __init__(self, text: str) -> None:
        self.text = text

    def transcribe(self, *_: Any) -> None:
        raise AssertionError("called through run")

    async def run(self, _fn: Any, _ref: Any, _audio: bytes) -> tuple[str, None]:
        return self.text, None


@unittest.skipIf(MlxSTT is None, "needs pipecat: pnpm test:voice")
class TranscriptTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_transcript_is_final(self) -> None:
        stt = MlxSTT(FakeModels("ciao Arianna"), ModelRef("parakeet-x", "parakeet"))
        frames = [frame async for frame in stt.run_stt(b"\x00\x00" * 160)]
        self.assertEqual(len(frames), 1)
        frame = frames[0]
        assert isinstance(frame, TranscriptionFrame)
        self.assertEqual(frame.text, "ciao Arianna")
        self.assertTrue(frame.finalized)

    async def test_silence_gives_nothing(self) -> None:
        stt = MlxSTT(FakeModels(""), ModelRef("parakeet-x", "parakeet"))
        self.assertEqual([frame async for frame in stt.run_stt(b"\x00\x00" * 160)], [])

    async def test_the_log_says_how_long_and_whether_written_never_the_words(self) -> None:
        # D-259: a «sì» lost on the way is told apart from one the model did not write.
        for text, outcome in (("Sì, grazie.", "text"), ("", "empty")):
            stt = MlxSTT(FakeModels(text), ModelRef("parakeet-x", "parakeet"))
            with self.assertLogs("arianna_voice", level="INFO") as logs:
                [frame async for frame in stt.run_stt(b"\x00\x00" * 16_000)]
            self.assertEqual(logs.output, [f"INFO:arianna_voice:stt: 1.0 s, {outcome}"])

    def test_the_turns_of_the_user_are_logged_by_event_only(self) -> None:
        class Aggregator:
            def __init__(self) -> None:
                self.handlers: dict[str, Any] = {}

            def add_event_handler(self, name: str, handler: Any) -> None:
                self.handlers[name] = handler

        aggregator = Aggregator()
        watch_turns(aggregator)
        self.assertEqual(sorted(aggregator.handlers), ["on_user_turn_started", "on_user_turn_stop_timeout", "on_user_turn_stopped"])
        with self.assertLogs("arianna_voice", level="INFO") as logs:
            aggregator.handlers["on_user_turn_started"](aggregator, "strategy")
            aggregator.handlers["on_user_turn_stopped"](aggregator, "strategy", {"role": "user", "content": "parole finte"})
        self.assertEqual(logs.output, ["INFO:arianna_voice:user turn: started", "INFO:arianna_voice:user turn: stopped"])
        self.assertNotIn("parole finte", " ".join(logs.output))

    def test_the_silence_is_shorter_than_the_safety_net(self) -> None:
        # Pipecat waits for the later of the two: with a final transcript only the silence counts.
        self.assertLess(TURN_SILENCE, STT_P99_SECONDS)
        self.assertGreaterEqual(TURN_SILENCE, 0.4)


if __name__ == "__main__":
    unittest.main()
