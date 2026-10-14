"""From the labels of the tokens to entities: pure functions, no model.

The model labels every token with a BIO tag (`B-FULLNAME`, `I-FULLNAME`, `O`).
Consecutive tokens of the same kind become one entity, with the character
positions of the text and the mean score. Nothing here keeps the text: an
entity is a kind, a start, an end and a score.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Token:
    label: str  # "B-FULLNAME", "I-FULLNAME" or "O"
    score: float
    start: int
    end: int


@dataclass(frozen=True)
class Entity:
    kind: str
    start: int
    end: int
    score: float

    def to_json(self) -> dict[str, object]:
        return {"kind": self.kind, "start": self.start, "end": self.end, "score": round(self.score, 4)}


def split_label(label: str) -> tuple[str, str]:
    """("B", "FULLNAME") for "B-FULLNAME", ("O", "") for "O"."""
    if label == "O" or "-" not in label:
        return "O", ""
    prefix, kind = label.split("-", 1)
    return (prefix if prefix in ("B", "I") else "O"), kind


def trim(text: str, start: int, end: int) -> tuple[int, int]:
    """The span without the spaces the tokenizer keeps at its edges."""
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def merge_bio(tokens: list[Token], text: str) -> list[Entity]:
    """Groups the tokens of one window into entities (like `aggregation_strategy="simple"`).

    An `I-X` after a token of another kind starts a new entity, as a `B-X`
    does: a model that forgets the `B` does not lose the entity.
    """
    entities: list[Entity] = []
    kind = ""
    start = end = 0
    scores: list[float] = []

    def close() -> None:
        if kind != "" and scores:
            s, e = trim(text, start, end)
            if e > s:
                entities.append(Entity(kind, s, e, sum(scores) / len(scores)))

    for token in tokens:
        if token.end <= token.start:  # special tokens have no characters
            continue
        prefix, token_kind = split_label(token.label)
        if prefix == "O":
            close()
            kind, scores = "", []
        elif prefix == "I" and token_kind == kind:
            end = token.end
            scores.append(token.score)
        else:
            close()
            kind, start, end, scores = token_kind, token.start, token.end, [token.score]
    close()
    return entities


def merge_windows(entities: list[Entity]) -> list[Entity]:
    """One list for a text read in overlapping windows: overlapping spans of one kind become one."""
    merged: list[Entity] = []
    for entity in sorted(entities, key=lambda item: (item.kind, item.start, item.end)):
        last = merged[-1] if merged else None
        if last is not None and last.kind == entity.kind and entity.start < last.end:
            merged[-1] = Entity(last.kind, last.start, max(last.end, entity.end), max(last.score, entity.score))
        else:
            merged.append(entity)
    return sorted(merged, key=lambda item: (item.start, item.end, item.kind))
