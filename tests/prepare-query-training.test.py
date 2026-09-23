import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_query_training", Path(__file__).parents[1] / "scripts/prepare-query-training.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class CharacterTokenizer:
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "".join(f"<{m['role']}>" + m["content"] + "</end>" for m in messages) + ("<assistant>" if add_generation_prompt else "")

    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]


class PreparationTests(unittest.TestCase):
    def test_connected_sessions_dedup_loss_mask_and_secret_quarantine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = []
            for node, session, request in [("n1", "a", "One"), ("n1", "a", "Two"),
                                           ("n2", "b", "Two"), ("n2", "b", "Three"),
                                           ("n3", "c", "Separate"),
                                           ("n4", "d", "password=secretvalue123456789")]:
                rows.append({"stage": "query-training", "recallProbability": 0.9,
                             "input": {"history": [], "currentRequest": request}, "inputHash": request,
                             "target": ["query one", "query two", "query three"],
                             "source": {"nodeId": node, "agentId": "main", "sessionId": session}})
            source = root / "source.jsonl"
            source.write_text("".join(json.dumps(row) + "\n" for row in rows))
            out = root / "prepared"
            report = prepare.prepare([source], out, CharacterTokenizer())
            self.assertEqual(report["duplicates"], 1)
            self.assertEqual(report["counts"]["quarantined"], 1)
            partitions = {}
            for partition in ("train", "validation"):
                for line in (out / (partition + ".jsonl")).read_text().splitlines():
                    row = json.loads(line)
                    partitions[row["id"]] = partition
                    boundary = next(i for i, token in enumerate(row["labels"]) if token != -100)
                    self.assertGreater(boundary, 0)
                    self.assertEqual(row["labels"][boundary:], row["input_ids"][boundary:])
            linked = [prepare.digest({"history": [], "currentRequest": request}) for request in ("One", "Two", "Three")]
            self.assertEqual(len({partitions[key] for key in linked}), 1)
            self.assertEqual(len(partitions), 4)
            self.assertEqual((out / "train.jsonl").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                prepare.prepare([source], out, CharacterTokenizer())


if __name__ == "__main__":
    unittest.main()
