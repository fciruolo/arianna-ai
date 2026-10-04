"""HTTP of apps/voice with a fake Models: needs aiohttp, so it runs in the venv (pnpm test:voice)."""

from __future__ import annotations

import asyncio
import base64
import unittest

try:
    from aiohttp.test_utils import AioHTTPTestCase
except ImportError:  # the standard library alone: skipped
    AioHTTPTestCase = None  # type: ignore[assignment,misc]

from arianna_voice.models import ModelError, Speech
from arianna_voice.wav import encode_wav

TOKEN = "t" * 40
PARAKEET = {"id": "parakeet-tdt-0.6b-v3-mlx", "family": "parakeet"}
WHISPER = {"id": "whisper-large-v3-turbo-mlx", "family": "whisper"}
KOKORO = {"id": "kokoro-82m-bf16-mlx", "family": "kokoro"}


class FakeModels:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.held = 0
        self.idle = 0.0

    def loaded(self) -> int:
        return self.held

    def idle_seconds(self) -> float:
        return self.idle

    def unload_all(self) -> int:
        count, self.held = self.held, 0
        self.calls.append(("unload_all",))
        return count

    async def run(self, function, *args):
        return function(*args)

    def transcribe(self, ref, pcm16):
        self.calls.append(("transcribe", ref.id))
        if ref.family == "whisper":
            raise ModelError("missing")
        return "ciao", 0.25

    def speak(self, ref, text, voice):
        self.calls.append(("speak", ref.id, voice))
        return Speech(encode_wav(b"\x00\x00" * 24, 24_000), 0.001, 24_000), 0.5, 0.25

    def close(self) -> None:
        pass


if AioHTTPTestCase is not None:
    from arianna_voice.server import CALLS_KEY, IDLE_SECONDS, authorized, create_app, release_idle, should_unload

    class FakeCalls:
        def __init__(self, count: int) -> None:
            self._count = count

        def count(self) -> int:
            return self._count

        async def close_all(self) -> None:
            self._count = 0

    class ServerTest(AioHTTPTestCase):
        async def get_application(self):
            self.models = FakeModels()
            return create_app(self.models, TOKEN)  # type: ignore[arg-type]

        def auth(self, token: str = TOKEN) -> dict[str, str]:
            return {"Authorization": f"Bearer {token}"}

        async def test_token_is_required(self) -> None:
            for headers in ({}, self.auth("x" * 40), {"Authorization": TOKEN}):
                response = await self.client.get("/health", headers=headers)
                self.assertEqual(response.status, 401)
            response = await self.client.get("/health", headers=self.auth())
            self.assertEqual(await response.json(), {"ok": True})
            self.assertFalse(authorized(None, TOKEN))

        async def test_transcribe_reports_each_model(self) -> None:
            body = {"pcm16": base64.b64encode(b"\x00\x00" * 16_000).decode(), "rate": 16_000, "models": [PARAKEET, WHISPER]}
            response = await self.client.post("/trial/transcribe", json=body, headers=self.auth())
            self.assertEqual(response.status, 200)
            results = (await response.json())["results"]
            self.assertEqual(results[0], {**PARAKEET, "text": "ciao", "seconds": 0.25})
            self.assertEqual(results[1], {**WHISPER, "error": "missing"})

        async def test_speak_returns_wav(self) -> None:
            response = await self.client.post("/trial/speak", json={"text": "Ciao", "model": KOKORO, "voice": "if_sara"}, headers=self.auth())
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "audio/wav")
            self.assertEqual((await response.read())[:4], b"RIFF")
            self.assertEqual(response.headers["X-Seconds-Spent"], "0.500")
            self.assertEqual(response.headers["X-First-Audio"], "0.250")

        async def test_idle_models_are_unloaded_only_outside_a_call(self) -> None:
            # D-074: loaded, unused for a minute, no call → dropped; any of the three missing → kept.
            self.assertTrue(should_unload(2, 0, IDLE_SECONDS))
            self.assertFalse(should_unload(0, 0, IDLE_SECONDS * 10))
            self.assertFalse(should_unload(2, 1, IDLE_SECONDS * 10))
            self.assertFalse(should_unload(2, 0, IDLE_SECONDS - 1))

            self.models.held, self.models.idle = 2, IDLE_SECONDS - 1
            self.assertEqual(await release_idle(self.app), 0)
            self.models.idle = IDLE_SECONDS + 1
            self.app[CALLS_KEY]["calls"] = FakeCalls(1)
            self.assertEqual(await release_idle(self.app), 0)
            self.assertEqual(self.models.held, 2)
            self.app[CALLS_KEY]["calls"] = FakeCalls(0)
            self.assertEqual(await release_idle(self.app), 2)
            self.assertEqual(self.models.held, 0)
            self.assertEqual(await release_idle(self.app), 0)
            self.assertEqual(self.models.calls.count(("unload_all",)), 1)

        async def test_the_sweeper_unloads_by_itself(self) -> None:
            # The loop of the running app, with a short period (D-074).
            from aiohttp.test_utils import TestClient, TestServer

            models = FakeModels()
            models.held, models.idle = 1, IDLE_SECONDS + 1
            client = TestClient(TestServer(create_app(models, TOKEN, sweep_seconds=0.01)))  # type: ignore[arg-type]
            await client.start_server()
            try:
                for _ in range(100):
                    if models.held == 0:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(models.held, 0)
                self.assertIn(("unload_all",), models.calls)
            finally:
                await client.close()

        async def test_bad_requests(self) -> None:
            response = await self.client.post("/trial/speak", data="{}", headers={**self.auth(), "Content-Type": "text/plain"})
            self.assertEqual(response.status, 400)
            response = await self.client.post("/trial/speak", json={"text": "Ciao"}, headers=self.auth())
            self.assertEqual(response.status, 400)
            response = await self.client.post("/trial/transcribe", data=b"x" * (3 * 1024 * 1024), headers={**self.auth(), "Content-Type": "application/json"})
            self.assertEqual(response.status, 413)


if __name__ == "__main__":
    unittest.main()
