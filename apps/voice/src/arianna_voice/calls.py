"""A call (D-066): Pipecat with SmallWebRTCTransport, straight between the
browser and this process (no relay, no STUN), Silero for the turns, the
speech models of models.py for hearing and speaking, and the core for what to
say. Imported only when the first call opens: Pipecat is large.

Pipeline: browser audio → Silero VAD (in the user aggregator) → speech to
text → the core (/api/calls/<id>/turn, with the call token) → text to speech
→ browser audio.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from typing import Any

import aiohttp
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    EndFrame,
    ErrorFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.utils.time import time_now_iso8601
from pipecat.workers.runner import WorkerRunner

from .call_request import CallRequest, last_user_words, schedule
from .models import ModelError, ModelRef, Models
from .wav import STT_RATE

log = logging.getLogger("arianna_voice")
TTS_RATE = 24_000
# Speech goes out in pieces of this length, so an interruption cuts it quickly.
CHUNK_SECONDS = 0.4
TURN_TIMEOUT = aiohttp.ClientTimeout(total=45)


class MlxSTT(SegmentedSTTService):
    """One segment per user turn, written by the model of the stt role."""

    def __init__(self, models: Models, ref: ModelRef, **kwargs: Any) -> None:
        super().__init__(sample_rate=STT_RATE, settings=STTSettings(model=ref.id, language=Language.IT), **kwargs)
        self._models = models
        self._ref = ref

    @property
    def wants_wav_segments(self) -> bool:
        return False

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        if audio[:4] == b"RIFF":
            audio = audio[44:]
        try:
            text, _ = await self._models.run(self._models.transcribe, self._ref, audio)
        except ModelError as error:
            yield ErrorFrame(error=f"stt {error.code}")
            return
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.IT)


class MlxTTS(TTSService):
    """The model of the tts role, with its voice."""

    def __init__(self, models: Models, ref: ModelRef, voice: str, **kwargs: Any) -> None:
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=TTS_RATE,
            settings=TTSSettings(model=ref.id, voice=voice, language=Language.IT),
            **kwargs,
        )
        self._models = models
        self._ref = ref
        self._voice = voice

    def can_generate_metrics(self) -> bool:
        return False

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        try:
            pcm16, rate, _ = await self._models.run(self._models.speak_pcm, self._ref, text, self._voice)
        except ModelError as error:
            yield ErrorFrame(error=f"tts {error.code}")
            return
        step = int(rate * CHUNK_SECONDS) * 2
        for offset in range(0, len(pcm16), step):
            yield TTSAudioRawFrame(audio=pcm16[offset : offset + step], sample_rate=rate, num_channels=1, context_id=context_id)


class CoreBrain(FrameProcessor):
    """In place of an LLM: the core decides what to say (D-066, the voice never calls oMLX)."""

    def __init__(self, request: CallRequest, session: aiohttp.ClientSession) -> None:
        super().__init__()
        self._request = request
        self._session = session
        self._turn: asyncio.Task[None] | None = None
        # How much of Pipecat's context was already sent: only new words go to the core.
        self._seen = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            messages = context_messages(frame.context)
            words = last_user_words(messages[self._seen :])
            self._seen = len(messages)
            if words:
                if self._turn is not None and not self._turn.done():
                    self._turn.cancel()
                self._turn = asyncio.create_task(self._answer(words))
            return
        if isinstance(frame, InterruptionFrame) and self._turn is not None and not self._turn.done():
            self._turn.cancel()
        await self.push_frame(frame, direction)

    async def _answer(self, words: str) -> None:
        url = f"{self._request.core_url}/api/calls/{self._request.call_id}/turn"
        headers = {"Authorization": f"Bearer {self._request.token}", "Content-Type": "application/json"}
        try:
            async with self._session.post(url, json={"text": words}, headers=headers, timeout=TURN_TIMEOUT) as response:
                body = await response.json(content_type=None)
                say = body.get("say") if response.status == 200 and isinstance(body, dict) else None
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - logged by class only
            log.warning("turn failed: %s", type(error).__name__)
            say = None
        if say == "":
            # The core dropped this turn: newer words are already on their way.
            return
        if not isinstance(say, str):
            say = "Scusa, ho perso il filo. Puoi ripetere?"
        await self.push_frame(LLMFullResponseStartFrame())
        await self.push_frame(LLMTextFrame(say))
        await self.push_frame(LLMFullResponseEndFrame())


def context_messages(context: Any) -> list[Any]:
    getter = getattr(context, "get_messages", None)
    messages = getter() if callable(getter) else getattr(context, "messages", [])
    return list(messages or [])


class Call:
    def __init__(self, request: CallRequest, models: Models) -> None:
        self.request = request
        self._models = models
        self._worker: PipelineWorker | None = None
        self._task: asyncio.Task[None] | None = None
        self._session: aiohttp.ClientSession | None = None
        self._ended = False
        self._clock_task: asyncio.Task[None] | None = None
        self._end_task: asyncio.Task[None] | None = None
        self.started = time.monotonic()

    async def open(self) -> dict[str, str]:
        """Answers the offer; the pipeline runs in the background until the end."""
        request = self.request
        # Loaded before the answer: a first sentence that waits for a model times out in Pipecat.
        for ref in (request.stt, request.tts):
            await self._models.run(self._models.warm, ref)
        if self._ended:
            # The core gave up waiting and closed the call meanwhile.
            raise RuntimeError("closed while loading")
        # No ICE server: the browser is on this machine (or on the VPN later).
        connection = SmallWebRTCConnection(ice_servers=[])
        try:
            await connection.initialize(sdp=request.sdp, type=request.type)
            answer = connection.get_answer()
            if not answer:
                raise RuntimeError("no answer")
        except Exception:
            await connection.disconnect()
            raise
        transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(audio_in_enabled=True, audio_out_enabled=True, audio_in_sample_rate=STT_RATE, audio_out_sample_rate=TTS_RATE),
        )
        # trust_env=False: the proxy of the environment is closed on purpose, the core is on loopback.
        self._session = aiohttp.ClientSession(trust_env=False)
        stt = MlxSTT(self._models, request.stt)
        tts = MlxTTS(self._models, request.tts, request.voice)
        brain = CoreBrain(request, self._session)
        context = LLMContext()
        user, assistant = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()))
        pipeline = Pipeline([transport.input(), stt, user, brain, tts, transport.output(), assistant])
        worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=False, enable_usage_metrics=False))
        self._worker = worker

        @transport.event_handler("on_client_connected")
        async def on_connected(_transport: Any, _client: Any) -> None:
            self.started = time.monotonic()
            await worker.queue_frames([TTSSpeakFrame(request.texts.greeting)])
            self._clock_task = asyncio.create_task(self._clock())

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_transport: Any, _client: Any) -> None:
            # Not awaited here: ending waits for the pipeline this handler runs in.
            self._end_task = asyncio.create_task(self.end("disconnected"))

        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        self._task = asyncio.create_task(runner.run())
        return {"sdp": answer["sdp"], "type": answer["type"]}

    async def say(self, text: str) -> None:
        if self._worker is not None and not self._ended:
            await self._worker.queue_frames([TTSSpeakFrame(text)])

    async def _clock(self) -> None:
        texts = {"warning": self.request.texts.warning, "goodbye": self.request.texts.goodbye}
        for at, which in schedule(self.request.call_seconds, self.request.warn_seconds):
            await asyncio.sleep(max(0.0, at - (time.monotonic() - self.started)))
            if self._ended:
                return
            await self.say(texts[which])
        # Time to say goodbye, then hang up.
        await asyncio.sleep(6)
        await self.end("time-limit")

    async def end(self, reason: str, notify: bool = True) -> None:
        if self._ended:
            return
        self._ended = True
        if self._clock_task is not None and self._clock_task is not asyncio.current_task():
            self._clock_task.cancel()
        if notify and self._session is not None:
            url = f"{self.request.core_url}/api/calls/{self.request.call_id}/ended"
            headers = {"Authorization": f"Bearer {self.request.token}", "Content-Type": "application/json"}
            try:
                async with self._session.post(url, json={"reason": reason}, headers=headers, timeout=aiohttp.ClientTimeout(total=10)):
                    pass
            except Exception as error:  # noqa: BLE001
                log.warning("end report failed: %s", type(error).__name__)
        if self._worker is not None:
            await self._worker.queue_frames([EndFrame()])
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=10)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                self._task.cancel()
        if self._session is not None:
            await self._session.close()


class Calls:
    """At most one call at a time, as the core enforces too."""

    def __init__(self, models: Models) -> None:
        self._models = models
        self._calls: dict[str, Call] = {}

    async def open(self, request: CallRequest) -> dict[str, str]:
        for call in list(self._calls.values()):
            await call.end("hangup")
        self._calls.clear()
        call = Call(request, self._models)
        # Registered before it opens: a close from the core during the loading finds it.
        self._calls[request.call_id] = call
        try:
            return await call.open()
        except BaseException:
            self._calls.pop(request.call_id, None)
            await call.end("voice-error", notify=False)
            raise

    def get(self, call_id: str) -> Call | None:
        return self._calls.get(call_id)

    async def close(self, call_id: str) -> bool:
        call = self._calls.pop(call_id, None)
        if call is None:
            return False
        # The core asked: no need to tell it back.
        await call.end("hangup", notify=False)
        return True

    async def close_all(self) -> None:
        for call_id in list(self._calls):
            await self.close(call_id)
