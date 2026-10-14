import json
import unittest
from pathlib import Path

from arianna_guard.entities import Entity
from arianna_guard.scoring import CaseResult, parse_case, score, timing

CASES = Path(__file__).resolve().parents[1] / "eval" / "cases.json"


class ParseCaseTest(unittest.TestCase):
    def test_gold_value_as_a_whole_word(self) -> None:
        case = parse_case({"id": "x", "group": "personal", "text": "P.IVA 09876543210, via Mazzini 21", "entities": [{"kind": "BUILDINGNUM", "value": "21"}]})
        self.assertEqual((case.gold[0].start, case.gold[0].end), (31, 33))

    def test_missing_value_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            parse_case({"id": "x", "group": "personal", "text": "Mario Rossi", "entities": [{"kind": "FULLNAME", "value": "Luigi"}]})

    def test_every_case_of_the_trial_parses(self) -> None:
        raw = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        ids = [item["id"] for item in raw]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(raw), 30)
        self.assertLessEqual(len(raw), 60)
        for item in raw:
            case = parse_case(item)
            self.assertIn(case.group, {"personal", "code_personal", "negative", "code"})
            # Negatives have no gold entity; the others have at least one.
            self.assertEqual(len(case.gold) == 0, case.group in {"negative", "code"}, case.id)


class ScoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.personal = parse_case(
            {"id": "p", "group": "personal", "text": "Mario Rossi, 333 1234567", "entities": [{"kind": "FULLNAME", "value": "Mario Rossi"}, {"kind": "TELEPHONENUM", "value": "333 1234567"}]}
        )
        self.code = parse_case({"id": "k", "group": "code", "text": "porta 7420", "entities": []})

    def test_found_missed_and_false_alarm(self) -> None:
        results = [
            # The name is found; the phone number is taken for a document id.
            CaseResult(self.personal, [Entity("FULLNAME", 0, 11, 0.9), Entity("ID_DOC", 13, 24, 0.6)]),
            CaseResult(self.code, [Entity("BUILDINGNUM", 6, 10, 0.7)]),
        ]
        scores = score(results)
        kinds = scores["by_kind"]
        self.assertEqual(kinds["FULLNAME"]["recall"], 1.0)
        self.assertEqual(kinds["TELEPHONENUM"]["recall"], 0.0)
        self.assertEqual(kinds["TELEPHONENUM"]["recall_any_kind"], 1.0)
        self.assertEqual(kinds["ID_DOC"]["false_positives"], 1)
        self.assertEqual(kinds["ID_DOC"]["spurious"], 0)
        self.assertEqual(kinds["BUILDINGNUM"]["spurious"], 1)
        self.assertEqual(scores["by_group"]["code"]["with_identifying_spurious"], 1)
        self.assertEqual(scores["by_group"]["personal"]["with_all_gold_found_any_kind"], 1)
        self.assertEqual(results[0].missed(), ["TELEPHONENUM"])

    def test_nothing_predicted(self) -> None:
        scores = score([CaseResult(self.code, [])])
        self.assertEqual(scores["by_group"]["code"]["with_findings"], 0)
        self.assertIsNone(scores["all_kinds"]["recall"])

    def test_timing(self) -> None:
        self.assertEqual(timing([10.0, 30.0, 20.0]), {"sentences": 3, "mean_ms": 20.0, "median_ms": 20.0, "p95_ms": 30.0, "max_ms": 30.0})


if __name__ == "__main__":
    unittest.main()
