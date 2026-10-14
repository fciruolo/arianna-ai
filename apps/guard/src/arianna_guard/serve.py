"""The second scanner as a service of the core (D-113, stage 2).

The core starts this process and talks to it with one JSON object per line,
on stdin and stdout: no socket, no port, nothing another process could reach.
First line out: {"ready": true, "kinds": [...]} once the model is loaded. Then
for each request {"id": 1, "texts": ["..."]} one answer, in order:
{"id": 1, "entities": [[{"kind": "FULLNAME", "start": 9, "end": 20, "score": 0.99}]]},
one list per text, positions in UTF-16 code units as JavaScript counts them;
or {"id": 1, "error": "<step>"}. Answers never carry text, and nothing of a
text is written to stderr: errors name the step.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import IO, Protocol

from .entities import Entity

# A request larger than this is refused, not read: the core sends briefs and
# messages, a few hundred KB at most.
MAX_REQUEST_CHARS = 4 * 1024 * 1024
MAX_TEXTS = 64


class Finder(Protocol):
    def find(self, text: str) -> list[Entity]: ...


def utf16_index(text: str) -> list[int]:
    """For each code point position of `text` (and its end), the position in UTF-16 code units."""
    positions = [0]
    for char in text:
        positions.append(positions[-1] + (2 if ord(char) > 0xFFFF else 1))
    return positions


def to_wire(entity: Entity, positions: list[int]) -> dict[str, object]:
    return {"kind": entity.kind, "start": positions[entity.start], "end": positions[entity.end], "score": round(entity.score, 4)}


def handle(finder: Finder, line: str) -> dict[str, object]:
    """The answer to one request line; never raises."""
    if len(line) > MAX_REQUEST_CHARS:
        # The core writes the id first: the answer still reaches the request that waits for it.
        head = re.match(r'\{"id":(\d{1,15}),', line)
        return {"id": int(head.group(1)) if head else None, "error": "too-large"}
    try:
        request = json.loads(line)
    except ValueError:
        return {"id": None, "error": "bad-request"}
    if not isinstance(request, dict):
        return {"id": None, "error": "bad-request"}
    request_id = request.get("id")
    if not isinstance(request_id, int) or isinstance(request_id, bool):
        return {"id": None, "error": "bad-request"}
    texts = request.get("texts")
    if not isinstance(texts, list) or len(texts) > MAX_TEXTS or not all(isinstance(text, str) for text in texts):
        return {"id": request_id, "error": "bad-request"}
    try:
        entities = []
        for text in texts:
            positions = utf16_index(text)
            entities.append([to_wire(entity, positions) for entity in finder.find(text)])
    except Exception:  # noqa: BLE001 - the step is named, the text never
        return {"id": request_id, "error": "scan-failed"}
    return {"id": request_id, "entities": entities}


def serve(finder: Finder, kinds: list[str], stdin: IO[str], stdout: IO[str]) -> None:
    def write(message: dict[str, object]) -> None:
        stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
        stdout.flush()

    write({"ready": True, "kinds": kinds})
    for line in stdin:
        if line.strip() == "":
            continue
        write(handle(finder, line))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="arianna_guard.serve")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    args = parser.parse_args(argv)
    # stdout carries only the protocol: whatever a library prints goes to stderr.
    protocol = sys.stdout
    sys.stdout = sys.stderr
    try:
        from .detector import Detector

        detector = Detector(args.model, args.device)
    except Exception as error:  # noqa: BLE001
        print(f"arianna_guard: the model could not be loaded ({type(error).__name__})", file=sys.stderr)
        return 1
    serve(detector, detector.kinds, sys.stdin, protocol)
    return 0


if __name__ == "__main__":
    sys.exit(main())
