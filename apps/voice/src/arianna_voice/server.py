"""HTTP of apps/voice, on 127.0.0.1 only. Only the core calls it, with the
service token it generated when it started this process (D-066). Errors are
closed codes: no transcript or text ever reaches a log or a response other
than the one that asked for it."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
from typing import Any

from aiohttp import web

from .call_request import parse_call, parse_say
from .models import ModelError, Models
from .trial import RequestError, parse_speak, parse_transcribe

# 30 s of 16 kHz 16-bit audio in base64 is 1.28 MB.
MAX_BODY_BYTES = 2 * 1024 * 1024
log = logging.getLogger("arianna_voice")

MODELS_KEY = web.AppKey("models", Models)
TOKEN_KEY = web.AppKey("token", str)
# The open calls; Pipecat is imported with the first one (calls.py).
CALLS_KEY = web.AppKey("calls", dict)
SWEEP_KEY = web.AppKey("sweep", float)

# Outside a call the speech models go after a minute without use (D-074): a
# trial of voices keeps them, a call loads them again before it answers.
IDLE_SECONDS = 60.0
SWEEP_SECONDS = 15.0


def should_unload(loaded: int, open_calls: int, idle: float, limit: float = IDLE_SECONDS) -> bool:
    return loaded > 0 and open_calls == 0 and idle >= limit


def authorized(header: str | None, token: str) -> bool:
    if header is None or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer ") :].encode(), token.encode())


@web.middleware
async def guard(request: web.Request, handler):
    if not authorized(request.headers.get("Authorization"), request.app[TOKEN_KEY]):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except RequestError as error:
        return web.json_response({"error": str(error)}, status=400)
    except ModelError as error:
        return web.json_response({"error": error.code}, status=422 if error.code in ("missing", "family") else 500)
    except Exception as error:  # noqa: BLE001 - logged by class only
        log.error("voice error: %s", type(error).__name__)
        return web.json_response({"error": "internal error"}, status=500)


async def read_json(request: web.Request) -> Any:
    if request.content_type != "application/json":
        raise RequestError("content type must be application/json")
    try:
        return json.loads(await request.read())
    except (ValueError, UnicodeDecodeError) as error:
        raise RequestError("body is not valid JSON") from error


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def transcribe(request: web.Request) -> web.Response:
    parsed = parse_transcribe(await read_json(request))
    models = request.app[MODELS_KEY]
    results = []
    for ref in parsed.models:
        entry: dict[str, Any] = {"id": ref.id, "family": ref.family}
        try:
            text, seconds = await models.run(models.transcribe, ref, parsed.pcm16)
            entry.update(text=text, seconds=round(seconds, 3))
        except ModelError as error:
            entry["error"] = error.code
        results.append(entry)
    return web.json_response({"results": results})


async def speak(request: web.Request) -> web.Response:
    parsed = parse_speak(await read_json(request))
    models = request.app[MODELS_KEY]
    speech, spent, first = await models.run(models.speak, parsed.model, parsed.text, parsed.voice)
    headers = {"X-Seconds-Spent": f"{spent:.3f}", "X-First-Audio": f"{first:.3f}", "X-Audio-Seconds": f"{speech.seconds:.3f}", "Cache-Control": "no-store"}
    return web.Response(body=speech.wav, content_type="audio/wav", headers=headers)


def calls_of(app: web.Application):
    holder = app[CALLS_KEY]
    if "calls" not in holder:
        from .calls import Calls

        holder["calls"] = Calls(app[MODELS_KEY])
    return holder["calls"]


async def open_call(request: web.Request) -> web.Response:
    parsed = parse_call(await read_json(request))
    try:
        answer = await calls_of(request.app).open(parsed)
    except RequestError:
        raise
    except Exception as error:  # noqa: BLE001 - logged by class only
        log.error("call failed: %s", type(error).__name__)
        return web.json_response({"error": "call-failed"}, status=500)
    return web.json_response(answer)


async def say(request: web.Request) -> web.Response:
    text = parse_say(await read_json(request))
    call = calls_of(request.app).get(request.match_info["call_id"])
    if call is None:
        return web.json_response({"error": "not-found"}, status=404)
    await call.say(text)
    return web.json_response({"ok": True})


async def close_call(request: web.Request) -> web.Response:
    closed = await calls_of(request.app).close(request.match_info["call_id"])
    return web.json_response({"ok": closed}, status=200 if closed else 404)


def open_calls(app: web.Application) -> int:
    holder = app[CALLS_KEY]
    return holder["calls"].count() if "calls" in holder else 0


async def release_idle(app: web.Application) -> int:
    """Drops the speech models when no call is open and they sat unused long enough."""
    models = app[MODELS_KEY]
    if not should_unload(models.loaded(), open_calls(app), models.idle_seconds()):
        return 0
    # On the worker thread, after whatever is queued: a call that opens meanwhile loads them again.
    count = await models.run(models.unload_all)
    if count > 0:
        log.info("speech models unloaded: %d", count)
    return count


async def sweeper(app: web.Application):
    async def loop() -> None:
        while True:
            await asyncio.sleep(app[SWEEP_KEY])
            try:
                await release_idle(app)
            except Exception as error:  # noqa: BLE001 - logged by class only
                log.error("unload failed: %s", type(error).__name__)

    task = asyncio.create_task(loop())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def close_all(app: web.Application) -> None:
    if "calls" in app[CALLS_KEY]:
        await app[CALLS_KEY]["calls"].close_all()


def create_app(models: Models, token: str, sweep_seconds: float = SWEEP_SECONDS) -> web.Application:
    if len(token) < 32:
        raise ValueError("token too short")
    app = web.Application(middlewares=[guard], client_max_size=MAX_BODY_BYTES)
    app[MODELS_KEY] = models
    app[TOKEN_KEY] = token
    app[CALLS_KEY] = {}
    app[SWEEP_KEY] = sweep_seconds
    app.cleanup_ctx.append(sweeper)
    app.on_shutdown.append(close_all)
    app.router.add_get("/health", health)
    app.router.add_post("/trial/transcribe", transcribe)
    app.router.add_post("/trial/speak", speak)
    app.router.add_post("/calls", open_call)
    app.router.add_post("/calls/{call_id}/say", say)
    app.router.add_delete("/calls/{call_id}", close_call)
    return app
