"""Speech in pieces (D-068): the pure rules with the standard library, the
streaming itself with a fake model in the environment of data/voice/venv."""

from __future__ import annotations

import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from arianna_voice.models import ModelError, ModelRef, Models, stream_arguments

try:
    import numpy as np
except ImportError:  # the standard library run
    np = None

try:
    from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame

    from arianna_voice.calls import MlxTTS
except ImportError:
    MlxTTS = None

QWEN = ModelRef("qwen-x", "qwen3-tts")


class StreamArgumentsTest(unittest.TestCase):
    def test_only_qwen_streams(self) -> None:
        self.assertEqual(stream_arguments("qwen3-tts"), {"stream": True, "streaming_interval": 0.64})
        self.assertEqual(stream_arguments("kokoro"), {})
        self.assertEqual(stream_arguments("voxtral-tts"), {})


class FakeModel:
    """Three pieces of 0.1 s per sentence; `fail` raises after the first."""

    def __init__(self, fail: bool = False, gate: threading.Event | None = None) -> None:
        self.fail = fail
        # With a gate, the model waits after its first piece until the test opens it.
        self.gate = gate
        self.kwargs: list[dict] = []

    def generate(self, text: str, **kwargs):
        self.kwargs.append(kwargs)
        for index in range(3):
            if self.fail and index == 1:
                raise RuntimeError("broken")
            if self.gate is not None and index == 1:
                self.gate.wait(5)
            yield SimpleNamespace(audio=np.full(2400, 0.5, dtype=np.float32), sample_rate=24_000)


def models_with(model: FakeModel) -> Models:
    folder = tempfile.mkdtemp()
    (Path(folder) / QWEN.id).mkdir()
    models = Models(Path(folder))
    models._loaded[QWEN.id] = model
    return models


@unittest.skipIf(np is None, "needs numpy: pnpm test:voice")
class SpeakStreamTest(unittest.TestCase):
    def test_pieces_in_order_with_the_stream_arguments(self) -> None:
        model = FakeModel()
        models = models_with(model)
        pieces: list[tuple[bytes, int]] = []
        models.speak_stream(QWEN, "Ciao. Fatto.", "serena", lambda pcm, rate: pieces.append((pcm, rate)), threading.Event())
        # Two sentences, three pieces each, 0.1 s of 16-bit samples.
        self.assertEqual(len(pieces), 6)
        self.assertEqual({(len(pcm), rate) for pcm, rate in pieces}, {(4800, 24_000)})
        self.assertTrue(all(kwargs["stream"] is True and kwargs["voice"] == "serena" and "max_tokens" in kwargs for kwargs in model.kwargs))
        models.close()

    def test_stop_ends_between_pieces(self) -> None:
        models = models_with(FakeModel())
        stop = threading.Event()
        pieces: list[bytes] = []

        def emit(pcm: bytes, rate: int) -> None:
            pieces.append(pcm)
            stop.set()

        models.speak_stream(QWEN, "Ciao. Fatto.", "serena", emit, stop)
        self.assertEqual(len(pieces), 1)
        models.close()

    def test_a_broken_model_is_an_inference_error(self) -> None:
        models = models_with(FakeModel(fail=True))
        with self.assertRaises(ModelError) as caught:
            models.speak_stream(QWEN, "Ciao.", "serena", lambda pcm, rate: None, threading.Event())
        self.assertEqual(caught.exception.code, "inference")
        models.close()

    def test_speak_reports_the_first_audio(self) -> None:
        models = models_with(FakeModel())
        speech, spent, first = models.speak(QWEN, "Ciao. Fatto.", "serena")
        self.assertAlmostEqual(speech.seconds, 0.6)
        self.assertEqual(speech.wav[:4], b"RIFF")
        self.assertLessEqual(first, spent)
        models.close()


@unittest.skipIf(MlxTTS is None, "needs pipecat: pnpm test:voice")
class RunTtsTest(unittest.IsolatedAsyncioTestCase):
    async def frames(self, model: FakeModel) -> list:
        models = models_with(model)
        tts = MlxTTS(models, QWEN, "serena")
        try:
            return [frame async for frame in tts.run_tts("Ciao.", "ctx")]
        finally:
            models.close()

    async def test_audio_goes_out_piece_by_piece(self) -> None:
        frames = await self.frames(FakeModel())
        self.assertEqual(len(frames), 3)
        self.assertTrue(all(isinstance(frame, TTSAudioRawFrame) and frame.sample_rate == 24_000 for frame in frames))

    async def test_an_error_after_some_audio_is_an_error_frame(self) -> None:
        frames = await self.frames(FakeModel(fail=True))
        self.assertIsInstance(frames[0], TTSAudioRawFrame)
        self.assertIsInstance(frames[-1], ErrorFrame)
        self.assertEqual(frames[-1].error, "tts inference")

    async def stopped_after_first_piece(self, stop) -> list[dict]:
        """`stop` ends the consumer after the first frame; then the model may go on."""
        gate = threading.Event()
        model = FakeModel(gate=gate)
        models = models_with(model)
        tts = MlxTTS(models, QWEN, "serena")
        await stop(tts.run_tts("Ciao. Fatto. Bene.", "ctx"))
        gate.set()
        # The single MLX thread runs jobs in order: this one waits for the speech job to end.
        await models.run(lambda: None)
        models.close()
        return model.kwargs

    async def test_closing_early_stops_the_model(self) -> None:
        async def close(stream) -> None:
            await anext(stream)
            await stream.aclose()

        # The job ends at its next piece instead of saying the other sentences.
        self.assertEqual(len(await self.stopped_after_first_piece(close)), 1)

    async def test_an_interruption_stops_the_model(self) -> None:
        # Pipecat interrupts by cancelling the task that reads run_tts.
        async def cancel(stream) -> None:
            first = asyncio.Event()

            async def read() -> None:
                async for _ in stream:
                    first.set()

            task = asyncio.create_task(read())
            await first.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(len(await self.stopped_after_first_piece(cancel)), 1)

    async def test_a_cancelled_job_is_an_error_frame_not_a_cancellation(self) -> None:
        gate = threading.Event()
        models = models_with(FakeModel(gate=gate))
        tts = MlxTTS(models, QWEN, "serena")
        # A job queued behind a busy thread, then cancelled by close (shutdown).
        blocker = asyncio.ensure_future(models.run(gate.wait, 5))
        await asyncio.sleep(0.05)
        stream = tts.run_tts("Ciao.", "ctx")
        pending = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.05)
        models.close()
        gate.set()
        frame = await pending
        self.assertIsInstance(frame, ErrorFrame)
        self.assertEqual(frame.error, "tts cancelled")
        await blocker


if __name__ == "__main__":
    unittest.main()
