"""The trial of Rizzo-PII on invented sentences (D-113, stage 1): `pnpm guard:trial`.

Reads apps/guard/eval/cases.json, runs the model on every sentence, and writes
recall and false positives by kind and by group, plus the time per sentence on
each device of the Mac, to data/evals/report-guard.json. The report names the
cases by id and the kinds missed or added, never the text.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import resource
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .detector import Detector
from .entities import Entity
from .scoring import CaseResult, parse_case, score, timing

WARMUP = 3


def spans(entities: list[Entity]) -> list[tuple[str, int, int]]:
    return [(entity.kind, entity.start, entity.end) for entity in entities]


def devices() -> list[str]:
    import torch

    return (["mps"] if torch.backends.mps.is_available() else []) + ["cpu"]


def measure(model_dir: Path, device: str, texts: list[str]) -> tuple[Detector, dict[str, object]]:
    started = time.perf_counter()
    detector = Detector(model_dir, device)
    load_s = time.perf_counter() - started
    for text in texts[:WARMUP]:
        detector.find(text)
    milliseconds: list[float] = []
    for text in texts:
        started = time.perf_counter()
        detector.find(text)
        milliseconds.append((time.perf_counter() - started) * 1000)
    # A brief of a few kilobytes, as a delegation to the cloud can be: every sentence in one text.
    joined = "\n".join(texts)
    long_ms: list[float] = []
    for _ in range(3):
        started = time.perf_counter()
        detector.find(joined)
        long_ms.append((time.perf_counter() - started) * 1000)
    long_text = {"characters": len(joined), "median_ms": round(sorted(long_ms)[1], 2)}
    return detector, {"device": device, "load_s": round(load_s, 2), **timing(milliseconds), "long_text": long_text}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="arianna_guard.trial")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    raw = json.loads(args.cases.read_text(encoding="utf-8"))
    cases = [parse_case(item) for item in raw["cases"]]
    texts = [case.text for case in cases]

    timings: list[dict[str, object]] = []
    results: list[CaseResult] = []
    kinds: list[str] = []
    for device in devices():
        detector, measured = measure(args.model, device, texts)
        findings = [detector.find(case.text) for case in cases]
        if not results:  # the scores come from the first device
            results = [CaseResult(case, found) for case, found in zip(cases, findings)]
            kinds = detector.kinds
        # The same weights on another device can round differently: how many sentences
        # have other entities (kind and position; the scores always differ a little).
        measured["sentences_with_other_findings"] = sum(spans(found) != spans(r.predicted) for found, r in zip(findings, results))
        timings.append(measured)
        del detector

    import torch
    import transformers

    report = {
        "suite": "guard",
        "decision": "D-113",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": args.model.name,
        "model_kinds": kinds,
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            # Peak memory of the process with both devices loaded one after the other (bytes on macOS).
            "max_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20),
        },
        "cases": len(cases),
        "scores": score(results),
        "timing": timings,
        "per_case": [
            {"id": r.case.id, "group": r.case.group, "missed": r.missed(), "false_positives": r.false_positives(), "spurious": r.spurious()}
            for r in results
            if r.missed() or r.false_positives()
        ],
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(args.out, 0o600)

    scores = report["scores"]
    assert isinstance(scores, dict)
    print(f"guard trial: {len(cases)} sentences, report in {args.out.name}")
    for kind, item in scores["by_kind"].items():
        print(f"  {kind:<17} gold {item['gold']:>2}  recall {item['recall']}  any kind {item['recall_any_kind']}  predicted {item['predicted']:>2}  false positives {item['false_positives']:>2}")
    for group, item in scores["by_group"].items():
        print(f"  {group:<14} {item}")
    for measured in timings:
        print(f"  {measured}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
