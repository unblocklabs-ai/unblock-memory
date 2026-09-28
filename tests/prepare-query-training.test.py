import copy
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


def query_row(node="n1", session="a", request="Question", event=1, probability=0.9):
    conversation = {"history": [], "currentRequest": request}
    return {"stage": "query-training", "recallProbability": probability,
            "input": conversation, "inputHash": prepare.digest(conversation),
            "target": {"lex": "query identifiers", "vec": "semantic query"},
            "source": {"nodeId": node, "agentId": "main", "sessionId": session,
                       "sourceId": prepare.digest([node, session, event]), "userEventId": event,
                       "timestamp": 100_000 + event}}


def cohort_row(query):
    source = dict(query["source"])
    source["id"] = source.pop("sourceId")
    return {"stage": "recall-gate", "recallProbability": query["recallProbability"],
            "input": query["input"], "inputHash": query["inputHash"], "sources": [source]}


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    return path


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class PreparationTests(unittest.TestCase):
    def test_connected_sessions_dedup_loss_mask_and_secret_quarantine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [query_row(node, session, request, event) for node, session, request, event in [
                ("n1", "a", "One", 1), ("n1", "a", "Two", 2),
                ("n2", "b", "Two", 1), ("n2", "b", "Three", 2),
                ("n3", "c", "Separate", 1), ("n4", "d", "password=secretvalue123456789", 1)]]
            source = write_rows(root / "queries.jsonl", rows)
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            out = root / "prepared"
            report = prepare.prepare([source], [cohort], out, CharacterTokenizer())
            self.assertEqual(report["duplicates"], 1)
            self.assertEqual(report["counts"]["quarantined"], 1)
            partitions = {}
            for partition in ("train", "validation"):
                for row in read_rows(out / (partition + ".jsonl")):
                    partitions[row["id"]] = partition
                    boundary = next(i for i, token in enumerate(row["labels"]) if token != -100)
                    self.assertGreater(boundary, 0)
                    self.assertEqual(row["labels"][boundary:], row["input_ids"][boundary:])
                    self.assertEqual(json.loads(row["messages"][-1]["content"]), {"lex": "query identifiers", "vec": "semantic query"})
            linked = [prepare.digest({"history": [], "currentRequest": request}) for request in ("One", "Two", "Three")]
            self.assertEqual(len({partitions[key] for key in linked}), 1)
            self.assertEqual(len(partitions), 4)
            membership = read_rows(out / "cohort-splits.jsonl")
            self.assertEqual(len(membership), 6)
            self.assertEqual(len({row["splitGroup"] for row in membership if row["inputId"] in linked}), 1)
            self.assertEqual(len({row["split"] for row in membership if row["inputId"] in linked}), 1)
            self.assertEqual((out / "train.jsonl").stat().st_mode & 0o777, 0o600)
            self.assertEqual((out / "validation-eval.jsonl").stat().st_mode & 0o777, 0o600)
            for path in out.iterdir():
                self.assertNotIn("secretvalue123456789", path.read_text())
            with self.assertRaises(FileExistsError):
                prepare.prepare([source], [cohort], out, CharacterTokenizer())

    def test_rejects_legacy_targets_and_differently_windowed_exports(self):
        for target, request in [(["one", "two", "three"], "Question"),
                                ({"lex": "keywords", "vec": "semantic"}, "a" * 8193)]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                row = query_row(request=request)
                row["target"] = target
                source = write_rows(root / "queries.jsonl", [row])
                cohort = write_rows(root / "cohort.jsonl", [cohort_row(row)])
                with self.assertRaises(ValueError):
                    prepare.prepare([source], [cohort], root / "prepared", CharacterTokenizer())

    def test_flags_targets_that_cannot_fit_runtime_generation_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = query_row()
            row["target"] = {"lex": "a" * 200, "vec": "b" * 200}
            source = write_rows(root / "queries.jsonl", [row])
            cohort = write_rows(root / "cohort.jsonl", [cohort_row(row)])
            report = prepare.prepare([source], [cohort], root / "prepared", CharacterTokenizer(), validation_fraction=1)
            self.assertEqual(report["counts"]["overlength"], 1)
            self.assertEqual(report["counts"]["train"] + report["counts"]["validation"], 0)
            quarantine = read_rows(root / "prepared/quarantine.jsonl")
            self.assertEqual(quarantine[0]["reasons"], ["target-exceeds-output-budget"])
            evaluation = read_rows(root / "prepared/validation-eval.jsonl")
            self.assertEqual(len(evaluation), 1)
            self.assertNotIn("target", evaluation[0])
            self.assertEqual(evaluation[0]["source"]["timestamp"], row["source"]["timestamp"])

    def test_unresolved_heldout_sources_remain_fixed_when_labels_later_succeed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [query_row(node=f"node-{i}", session=f"session-{i}", request=f"Request {i}") for i in range(8)]
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            source = write_rows(root / "queries.jsonl", [])
            before = root / "before"
            report = prepare.prepare([source], [cohort], before, CharacterTokenizer(), validation_fraction=0.5)
            pending = read_rows(before / "validation-eval.jsonl")
            self.assertGreater(len(pending), 0)
            self.assertEqual(report["counts"]["validationUnresolved"], len(pending))
            self.assertTrue(all("target" not in row for row in pending))
            self.assertEqual(read_rows(before / "train.jsonl"), [])
            self.assertEqual(read_rows(before / "validation.jsonl"), [])
            chosen = next(row for row in rows if row["source"]["sourceId"] == pending[0]["source"]["sourceId"])
            write_rows(source, [chosen])
            after = root / "after"
            report_after = prepare.prepare([source], [cohort], after, CharacterTokenizer(), validation_fraction=0.5)
            resolved = read_rows(after / "validation-eval.jsonl")
            self.assertEqual([row["id"] for row in pending], [row["id"] for row in resolved])
            self.assertEqual([{key: value for key, value in row.items() if key != "target"} for row in resolved], pending)
            self.assertEqual(sum("target" in row for row in resolved), 1)
            self.assertEqual(report_after["counts"]["validation"], 1)
            self.assertEqual(report_after["counts"]["validationUnresolved"], len(pending) - 1)
            self.assertEqual((before / "cohort-splits.jsonl").read_bytes(), (after / "cohort-splits.jsonl").read_bytes())

    def test_cohort_only_bridge_keeps_all_connected_sessions_together(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [query_row("n1", "a", "Labeled first", 1), query_row("n1", "a", "Bridge", 2),
                    query_row("n2", "b", "Bridge", 1), query_row("n2", "b", "Labeled second", 2),
                    query_row("n3", "c", "Separate", 1)]
            source = write_rows(root / "queries.jsonl", [rows[0], rows[3], rows[4]])
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            out = root / "prepared"
            prepare.prepare([source], [cohort], out, CharacterTokenizer(), validation_fraction=0.5)
            membership = {row["id"]: row for row in read_rows(out / "cohort-splits.jsonl")}
            first_four = [membership[prepare.source_identity(row["source"], "sourceId")[0]] for row in rows[:4]]
            self.assertEqual(len({row["splitGroup"] for row in first_four}), 1)
            self.assertEqual(len({row["split"] for row in first_four}), 1)
            train_groups = {row["splitGroup"] for row in read_rows(out / "train.jsonl")}
            validation_groups = {row["splitGroup"] for row in read_rows(out / "validation-eval.jsonl")}
            self.assertFalse(train_groups & validation_groups)

    def test_out_of_cohort_sources_changed_inputs_or_cutoffs_are_rejected(self):
        for change in ("source", "input", "timestamp", "hash"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                frozen = query_row()
                row = copy.deepcopy(frozen)
                if change == "source":
                    row["source"]["sourceId"] = "not-in-cohort"
                elif change == "input":
                    row["input"]["currentRequest"] = "Changed"
                elif change == "timestamp":
                    row["source"]["timestamp"] += 1
                else:
                    row["inputHash"] = "0" * 64
                source = write_rows(root / "queries.jsonl", [row])
                cohort = write_rows(root / "cohort.jsonl", [cohort_row(frozen)])
                with self.assertRaisesRegex(ValueError, "outside the frozen cohort"):
                    prepare.prepare([source], [cohort], root / "prepared", CharacterTokenizer())
                self.assertFalse((root / "prepared").exists())

    def test_cohort_privacy_removes_unsafe_text_but_not_safe_requests_with_unsafe_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [query_row(request="password=cohortsecret123456789", event=1),
                    query_row(request="Safe request with unsafe target", event=2),
                    query_row(request="Still unresolved", event=3)]
            rows[1]["target"]["lex"] = "password=targetsecret123456789"
            source = write_rows(root / "queries.jsonl", rows[:2])
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            out = root / "prepared"
            report = prepare.prepare([source], [cohort], out, CharacterTokenizer(), validation_fraction=1)
            self.assertEqual(report["counts"]["quarantined"], 2)
            self.assertEqual(report["counts"]["validationUnresolved"], 2)
            evaluation = read_rows(out / "validation-eval.jsonl")
            self.assertEqual(len(evaluation), 2)
            self.assertTrue(all("target" not in row for row in evaluation))
            quarantine = read_rows(out / "quarantine.jsonl")
            self.assertEqual({item["stage"] for item in quarantine}, {"cohort", "target"})
            self.assertEqual(len({item["id"] for item in quarantine}), 2)
            for path in out.iterdir():
                self.assertNotIn("cohortsecret123456789", path.read_text())
                self.assertNotIn("targetsecret123456789", path.read_text())

    def test_negative_recall_is_not_in_the_query_cohort_and_cohort_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = query_row(probability=0.69)
            cohort = write_rows(root / "cohort.jsonl", [cohort_row(row)])
            source = write_rows(root / "queries.jsonl", [])
            report = prepare.prepare([source], [cohort], root / "prepared", CharacterTokenizer())
            self.assertEqual(report["cohortSourceExamples"], 0)
            with self.assertRaisesRegex(ValueError, "cohort is required"):
                prepare.prepare([source], [], root / "missing", CharacterTokenizer())


if __name__ == "__main__":
    unittest.main()
