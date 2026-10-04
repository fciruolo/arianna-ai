"""Models.unload_all and the idle clock (D-074), without MLX: runs with the standard library."""

from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from arianna_voice.models import Models


class UnloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models = Models(Path(tempfile.gettempdir()))

    def tearDown(self) -> None:
        self.models.close()

    def test_unload_all_drops_every_model_once(self) -> None:
        self.assertEqual(self.models.unload_all(), 0)
        self.models._loaded.update({"a": object(), "b": object()})  # noqa: SLF001 - as if loaded
        self.assertEqual(self.models.loaded(), 2)
        self.assertEqual(self.models.unload_all(), 2)
        self.assertEqual(self.models.loaded(), 0)
        self.assertEqual(self.models.unload_all(), 0)

    def test_work_resets_the_idle_clock(self) -> None:
        self.models._last_used = time.monotonic() - 120  # noqa: SLF001 - two minutes ago
        self.assertGreaterEqual(self.models.idle_seconds(), 120)
        asyncio.run(self.models.run(lambda: None))
        self.assertLess(self.models.idle_seconds(), 5)


if __name__ == "__main__":
    unittest.main()
