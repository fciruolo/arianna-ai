import io
import json
import unittest

from arianna_guard.entities import Entity
from arianna_guard.serve import handle, serve, utf16_index


class FakeFinder:
    """Finds every "Mario Rossi" as a FULLNAME; raises on the text "boom"."""

    def find(self, text: str) -> list[Entity]:
        if text == "boom":
            raise RuntimeError("Mario Rossi failed")
        start = text.find("Mario Rossi")
        return [] if start < 0 else [Entity("FULLNAME", start, start + 11, 0.987654)]


class HandleTest(unittest.TestCase):
    def test_entities_per_text(self) -> None:
        answer = handle(FakeFinder(), json.dumps({"id": 3, "texts": ["Scrivi a Mario Rossi", "niente"]}))
        self.assertEqual(answer, {"id": 3, "entities": [[{"kind": "FULLNAME", "start": 9, "end": 20, "score": 0.9877}], []]})

    def test_positions_in_utf16_units(self) -> None:
        # The emoji is one code point in Python and two code units in JavaScript.
        text = "🙂 Mario Rossi"
        answer = handle(FakeFinder(), json.dumps({"id": 1, "texts": [text]}))
        entity = answer["entities"][0][0]  # type: ignore[index]
        self.assertEqual((entity["start"], entity["end"]), (3, 14))
        self.assertEqual(utf16_index("a🙂b"), [0, 1, 3, 4])

    def test_bad_requests(self) -> None:
        for line in ["not json", "[]", json.dumps({"texts": []}), json.dumps({"id": True, "texts": []})]:
            self.assertEqual(handle(FakeFinder(), line), {"id": None, "error": "bad-request"})
        for texts in ["x", [1], ["x"] * 65]:
            self.assertEqual(handle(FakeFinder(), json.dumps({"id": 2, "texts": texts})), {"id": 2, "error": "bad-request"})
        self.assertEqual(handle(FakeFinder(), "x" * (4 * 1024 * 1024 + 1)), {"id": None, "error": "too-large"})
        big = '{"id":7,"texts":["' + "x" * (4 * 1024 * 1024) + '"]}'
        self.assertEqual(handle(FakeFinder(), big), {"id": 7, "error": "too-large"})

    def test_a_failure_never_carries_the_text(self) -> None:
        answer = handle(FakeFinder(), json.dumps({"id": 4, "texts": ["boom"]}))
        self.assertEqual(answer, {"id": 4, "error": "scan-failed"})
        self.assertNotIn("Mario", json.dumps(answer))


class ServeTest(unittest.TestCase):
    def test_ready_line_then_one_answer_per_request(self) -> None:
        stdin = io.StringIO(json.dumps({"id": 1, "texts": ["Mario Rossi"]}) + "\n\n" + json.dumps({"id": 2, "texts": []}) + "\n")
        stdout = io.StringIO()
        serve(FakeFinder(), ["FULLNAME"], stdin, stdout)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(lines[0], {"ready": True, "kinds": ["FULLNAME"]})
        self.assertEqual([line["id"] for line in lines[1:]], [1, 2])
        self.assertEqual(lines[2], {"id": 2, "entities": []})


if __name__ == "__main__":
    unittest.main()
