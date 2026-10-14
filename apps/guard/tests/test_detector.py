"""The real model, only when its weights are on disk (ARIANNA_GUARD_MODEL, set by pnpm test:guard)."""

import contextlib
import io
import logging
import os
import unittest
from pathlib import Path

MODEL = Path(os.environ.get("ARIANNA_GUARD_MODEL", ""))


@unittest.skipUnless(str(MODEL) != "." and (MODEL / "model.safetensors").is_file(), "Rizzo-PII is not in data/guard/models")
class DetectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from arianna_guard.detector import Detector

        cls.detector = Detector(MODEL, "cpu")

    def test_finds_a_name_and_an_email(self) -> None:
        text = "Scrivi a Giulia Ferrandi, giulia.ferrandi@example.it."
        kinds = {(e.kind, text[e.start : e.end]) for e in self.detector.find(text)}
        self.assertIn(("FULLNAME", "Giulia Ferrandi"), kinds)
        self.assertIn(("EMAIL", "giulia.ferrandi@example.it"), kinds)

    def test_nothing_in_a_plain_sentence(self) -> None:
        self.assertEqual(self.detector.find("Oggi piove e il treno e' in ritardo."), [])
        self.assertEqual(self.detector.find("   "), [])

    def test_a_long_text_is_read_in_windows(self) -> None:
        filler = "Il treno parte presto e arriva tardi. " * 120
        text = filler + "Chiama Marco Bellini al 347 555 0192."
        found = [(e.kind, text[e.start : e.end]) for e in self.detector.find(text)]
        self.assertIn(("FULLNAME", "Marco Bellini"), found)

    def test_the_text_is_never_logged(self) -> None:
        marker = "Zebedeo Quaglierini"
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root = logging.getLogger()
        root.addHandler(handler)
        previous = root.level
        root.setLevel(logging.DEBUG)
        try:
            with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                self.detector.find(f"Ho incontrato {marker} in via Roma 3 a Pisa.")
        finally:
            root.removeHandler(handler)
            root.setLevel(previous)
        self.assertNotIn("Zebedeo", stream.getvalue())


def libraries() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(libraries(), "torch and transformers are in data/guard/venv only")
class RefusedModelTest(unittest.TestCase):
    def test_a_model_that_is_not_a_token_classifier_is_refused(self) -> None:
        import json
        import tempfile

        from arianna_guard.detector import Detector

        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "config.json").write_text(json.dumps({"architectures": ["ModernBertForMaskedLM"]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not a token classifier"):
                Detector(Path(folder), "cpu")

    def test_a_folder_without_config_is_refused(self) -> None:
        import tempfile

        from arianna_guard.detector import Detector

        with tempfile.TemporaryDirectory() as folder, self.assertRaises(FileNotFoundError):
            Detector(Path(folder), "cpu")


if __name__ == "__main__":
    unittest.main()
