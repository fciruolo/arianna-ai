"""Entry point: `python -m arianna_voice`, started by the core (D-066).

Everything comes from the environment the core builds: the port, the service
token, the models folder and a private tmp folder, all inside ARIANNA_HOME.
The process exits when its standard input closes, so it never outlives the
core that started it, even after a crash of the core.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
from pathlib import Path

from aiohttp import web

from .models import Models
from .server import create_app

HOST = "127.0.0.1"


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if value == "":
        sys.stderr.write(f"arianna_voice: {name} is not set\n")
        raise SystemExit(2)
    return value


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    # Blocks until the core closes the pipe or dies.
    try:
        while sys.stdin.buffer.read(1024):
            pass
    finally:
        loop.call_soon_threadsafe(stop.set)


async def serve() -> None:
    port = int(env("ARIANNA_VOICE_PORT"))
    token = env("ARIANNA_VOICE_TOKEN")
    models = Models(Path(env("ARIANNA_MODELS_DIR")), Path(env("ARIANNA_VOICE_TMP")))
    runner = web.AppRunner(create_app(models, token), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, HOST, port).start()
    stop = asyncio.Event()
    threading.Thread(target=watch_stdin, args=(asyncio.get_running_loop(), stop), daemon=True).start()
    try:
        await stop.wait()
    finally:
        await runner.cleanup()
        models.close()


def main() -> None:
    # Libraries may log what they hear or say at INFO: only warnings reach the
    # log file, and our own logger writes closed codes only.
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("arianna_voice").setLevel(logging.INFO)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
