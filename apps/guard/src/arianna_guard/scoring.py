"""Scores of the trial on invented sentences (D-113, stage 1): pure functions.

A gold entity is found when the model returns an entity of the same kind that
overlaps it; found with any kind when an entity of another kind overlaps it
(for a gate that blocks, the kind matters less than the finding). A predicted
entity is a false positive of its kind when no gold entity of that kind
overlaps it, and spurious when no gold entity at all overlaps it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import mean, median

from .entities import Entity

# The kinds that point at a person or a place where one lives or pays: the
# candidates for stopping an exit towards the cloud (D-113). Dates, times,
# amounts, ages, genders, organizations and cities alone are measured too, but
# a sentence with only those is common in work that is not personal.
IDENTIFYING = frozenset(
    {
        "FULLNAME", "EMAIL", "TELEPHONENUM", "STREET", "BUILDINGNUM", "ZIPCODE",
        "IBAN", "CF", "PIVA", "CREDITCARDNUMBER", "CATASTO", "ID_DOC", "DOCID", "TARGA",
    }
)  # fmt: skip


@dataclass(frozen=True)
class Gold:
    kind: str
    start: int
    end: int


@dataclass(frozen=True)
class Case:
    id: str
    group: str
    text: str
    gold: tuple[Gold, ...]


def parse_case(raw: dict[str, object]) -> Case:
    """A case of cases.json; every gold value must be in the text, as a whole word.

    "21" in "P.IVA 09876543210, via Mazzini 21" is the house number, not the
    digits inside the VAT number: a value next to a letter or a digit is skipped.
    """
    text = str(raw["text"])
    gold: list[Gold] = []
    entities = raw.get("entities", [])
    assert isinstance(entities, list)
    for item in entities:
        value = str(item["value"])
        match = re.search(rf"(?<!\w){re.escape(value)}(?!\w)", text)
        if match is None:
            raise ValueError(f"case {raw['id']}: a gold value is not in the text")
        gold.append(Gold(str(item["kind"]), match.start(), match.end()))
    return Case(str(raw["id"]), str(raw["group"]), text, tuple(gold))


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start < b_end and b_start < a_end


@dataclass
class KindScore:
    gold: int = 0
    found: int = 0
    found_any_kind: int = 0
    predicted: int = 0
    false_positives: int = 0
    spurious: int = 0

    def to_json(self) -> dict[str, object]:
        return {
            "gold": self.gold,
            "found": self.found,
            "found_any_kind": self.found_any_kind,
            "recall": ratio(self.found, self.gold),
            "recall_any_kind": ratio(self.found_any_kind, self.gold),
            "predicted": self.predicted,
            "false_positives": self.false_positives,
            "spurious": self.spurious,
            "precision": ratio(self.predicted - self.false_positives, self.predicted),
        }


def ratio(part: int, whole: int) -> float | None:
    return None if whole == 0 else round(part / whole, 4)


@dataclass
class CaseResult:
    case: Case
    predicted: list[Entity]

    def missed(self) -> list[str]:
        return [g.kind for g in self.case.gold if not any(p.kind == g.kind and overlaps(p.start, p.end, g.start, g.end) for p in self.predicted)]

    def false_positives(self) -> list[str]:
        return [p.kind for p in self.predicted if not any(p.kind == g.kind and overlaps(p.start, p.end, g.start, g.end) for g in self.case.gold)]

    def spurious(self) -> list[str]:
        return [p.kind for p in self.predicted if not any(overlaps(p.start, p.end, g.start, g.end) for g in self.case.gold)]


def score(results: list[CaseResult]) -> dict[str, object]:
    kinds: dict[str, KindScore] = {}

    def of(kind: str) -> KindScore:
        return kinds.setdefault(kind, KindScore())

    groups: dict[str, dict[str, int]] = {}
    for result in results:
        for g in result.case.gold:
            item = of(g.kind)
            item.gold += 1
            if any(p.kind == g.kind and overlaps(p.start, p.end, g.start, g.end) for p in result.predicted):
                item.found += 1
            if any(overlaps(p.start, p.end, g.start, g.end) for p in result.predicted):
                item.found_any_kind += 1
        for p in result.predicted:
            of(p.kind).predicted += 1
        for kind in result.false_positives():
            of(kind).false_positives += 1
        for kind in result.spurious():
            of(kind).spurious += 1
        group = groups.setdefault(
            result.case.group,
            {"cases": 0, "with_findings": 0, "with_identifying_findings": 0, "with_spurious": 0, "with_identifying_spurious": 0, "with_all_gold_found_any_kind": 0},
        )
        group["cases"] += 1
        group["with_findings"] += int(len(result.predicted) > 0)
        group["with_identifying_findings"] += int(any(p.kind in IDENTIFYING for p in result.predicted))
        spurious = result.spurious()
        group["with_spurious"] += int(len(spurious) > 0)
        group["with_identifying_spurious"] += int(any(kind in IDENTIFYING for kind in spurious))
        all_found = all(any(overlaps(p.start, p.end, g.start, g.end) for p in result.predicted) for g in result.case.gold)
        group["with_all_gold_found_any_kind"] += int(all_found and len(result.case.gold) > 0)

    total = KindScore()
    identifying = KindScore()
    for kind, item in kinds.items():
        for target in (total, identifying) if kind in IDENTIFYING else (total,):
            target.gold += item.gold
            target.found += item.found
            target.found_any_kind += item.found_any_kind
            target.predicted += item.predicted
            target.false_positives += item.false_positives
            target.spurious += item.spurious
    return {
        "by_kind": {kind: kinds[kind].to_json() for kind in sorted(kinds)},
        "all_kinds": total.to_json(),
        "identifying_kinds": {"kinds": sorted(IDENTIFYING), **identifying.to_json()},
        "by_group": groups,
    }


def timing(milliseconds: list[float]) -> dict[str, float]:
    ordered = sorted(milliseconds)
    p95 = ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]
    return {
        "sentences": len(ordered),
        "mean_ms": round(mean(ordered), 2),
        "median_ms": round(median(ordered), 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(ordered[-1], 2),
    }
