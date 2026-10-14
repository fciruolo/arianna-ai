"""Rizzo-PII on the Mac: a text in, the personal data found out (D-113).

The weights come only from the folder of the catalog (data/guard/models/<id>, D-203), with
Hugging Face offline. The text is never logged: errors name the step, not the
content, and the results carry only kinds, positions and scores.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .entities import Entity, Token, merge_bio, merge_windows

# The model was trained on texts of up to 768 tokens: longer texts are read in
# overlapping windows of 512, well inside what it saw, and the overlap of 64
# tokens lets an entity on a border be seen whole in one of the two windows.
WINDOW_TOKENS = 512
STRIDE_TOKENS = 64


class Detector:
    def __init__(self, model_dir: Path, device: str = "auto") -> None:
        # Imported here: the tests of the pure parts run without torch.
        import torch
        from transformers import AutoModelForTokenClassification, AutoTokenizer
        from transformers.utils import logging as hf_logging

        hf_logging.set_verbosity_error()
        hf_logging.disable_progress_bar()
        logging.getLogger("transformers").setLevel(logging.ERROR)
        config_file = model_dir / "config.json"
        if not config_file.is_file():
            raise FileNotFoundError("the model folder has no config.json")
        # Only a token classifier: any other model would get a head of random weights
        # and a scanner that finds nothing without saying so.
        architectures = json.loads(config_file.read_text(encoding="utf-8")).get("architectures") or []
        if not any(str(name).endswith("ForTokenClassification") for name in architectures):
            raise ValueError("the model is not a token classifier")
        self._torch = torch
        if device == "auto":
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.device = device
        self._tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
        if not self._tokenizer.is_fast:
            raise RuntimeError("a fast tokenizer is required for the character positions")
        model, info = AutoModelForTokenClassification.from_pretrained(str(model_dir), local_files_only=True, output_loading_info=True)
        if info.get("missing_keys"):
            raise ValueError("the weights do not cover the model: some layers would be random")
        model.eval()
        self._model = model.to(device)
        self._labels: dict[int, str] = {int(key): value for key, value in model.config.id2label.items()}

    @property
    def kinds(self) -> list[str]:
        """The kinds of personal data the model knows, without B-/I-."""
        return sorted({label.split("-", 1)[1] for label in self._labels.values() if "-" in label})

    def find(self, text: str) -> list[Entity]:
        """The personal data of `text`: kind, start and end in characters, score."""
        if text.strip() == "":
            return []
        torch = self._torch
        encoded = self._tokenizer(
            text,
            return_offsets_mapping=True,
            return_overflowing_tokens=True,
            truncation=True,
            max_length=WINDOW_TOKENS,
            stride=STRIDE_TOKENS,
            padding=True,
            return_tensors="pt",
        )
        offsets = encoded.pop("offset_mapping").tolist()
        encoded.pop("overflow_to_sample_mapping", None)
        inputs = {key: value.to(self.device) for key, value in encoded.items()}
        with torch.inference_mode():
            logits = self._model(**inputs).logits
        probabilities = torch.softmax(logits.float(), dim=-1)
        scores, ids = probabilities.max(dim=-1)
        found: list[Entity] = []
        for window, window_offsets in enumerate(offsets):
            tokens = [
                Token(self._labels[int(label)], float(score), int(start), int(end))
                for label, score, (start, end) in zip(ids[window].tolist(), scores[window].tolist(), window_offsets)
            ]
            found.extend(merge_bio(tokens, text))
        return merge_windows(found)
