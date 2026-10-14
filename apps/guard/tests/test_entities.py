import unittest

from arianna_guard.entities import Entity, Token, merge_bio, merge_windows, split_label, trim


class SplitLabelTest(unittest.TestCase):
    def test_bio_labels(self) -> None:
        self.assertEqual(split_label("B-FULLNAME"), ("B", "FULLNAME"))
        self.assertEqual(split_label("I-ID_DOC"), ("I", "ID_DOC"))

    def test_outside_and_unknown(self) -> None:
        self.assertEqual(split_label("O"), ("O", ""))
        self.assertEqual(split_label("X-FULLNAME"), ("O", "FULLNAME"))


class MergeBioTest(unittest.TestCase):
    text = "Mario Rossi abita a Pisa"

    def test_groups_tokens_of_one_kind(self) -> None:
        tokens = [
            Token("O", 1.0, 0, 0),  # special token, no characters
            Token("B-FULLNAME", 0.9, 0, 5),
            Token("I-FULLNAME", 0.7, 5, 11),
            Token("O", 0.99, 11, 17),
            Token("O", 0.99, 17, 19),
            Token("B-CITY", 0.8, 19, 24),
        ]
        entities = merge_bio(tokens, self.text)
        self.assertEqual([(e.kind, e.start, e.end) for e in entities], [("FULLNAME", 0, 11), ("CITY", 20, 24)])
        self.assertAlmostEqual(entities[0].score, 0.8)

    def test_i_without_b_starts_an_entity(self) -> None:
        entities = merge_bio([Token("I-FULLNAME", 0.9, 0, 5), Token("I-FULLNAME", 0.9, 5, 11)], self.text)
        self.assertEqual([(e.kind, e.start, e.end) for e in entities], [("FULLNAME", 0, 11)])

    def test_a_new_b_or_another_kind_splits(self) -> None:
        entities = merge_bio([Token("B-FULLNAME", 0.9, 0, 5), Token("B-FULLNAME", 0.9, 5, 11), Token("I-CITY", 0.9, 19, 24)], self.text)
        self.assertEqual([(e.kind, e.start, e.end) for e in entities], [("FULLNAME", 0, 5), ("FULLNAME", 6, 11), ("CITY", 20, 24)])

    def test_nothing_found(self) -> None:
        self.assertEqual(merge_bio([Token("O", 0.99, 0, 5)], self.text), [])

    def test_trim_drops_spaces_only(self) -> None:
        self.assertEqual(trim(" a b ", 0, 5), (1, 4))
        self.assertEqual(trim("   ", 0, 3), (3, 3))


class MergeWindowsTest(unittest.TestCase):
    def test_overlapping_spans_of_one_kind_become_one(self) -> None:
        merged = merge_windows([Entity("FULLNAME", 0, 5, 0.6), Entity("FULLNAME", 3, 11, 0.9), Entity("CITY", 20, 24, 0.8)])
        self.assertEqual(merged, [Entity("FULLNAME", 0, 11, 0.9), Entity("CITY", 20, 24, 0.8)])

    def test_different_kinds_or_apart_stay(self) -> None:
        entities = [Entity("STREET", 0, 9, 0.9), Entity("BUILDINGNUM", 5, 9, 0.9), Entity("STREET", 12, 15, 0.9)]
        self.assertEqual(merge_windows(entities), entities)

    def test_json_has_no_text(self) -> None:
        self.assertEqual(Entity("EMAIL", 1, 9, 0.123456).to_json(), {"kind": "EMAIL", "start": 1, "end": 9, "score": 0.1235})


if __name__ == "__main__":
    unittest.main()
