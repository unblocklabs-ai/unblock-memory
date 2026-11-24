import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

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

    def test_mismatched_recall_model_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = query_row()
            row["recallModel"] = "liquid/d1.2-ultra-20261116"
            cohort = cohort_row(row)
            cohort["model"] = "jev-1.13.0"
            source_file = write_rows(root / "queries.jsonl", [row])
            cohort_file = write_rows(root / "cohort.jsonl", [cohort])
            with self.assertRaisesRegex(ValueError, "recallModel mismatches"):
                prepare.prepare([source_file], [cohort_file], root / "prepared", CharacterTokenizer())

    def test_mismatched_recall_endpoint_scope_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = query_row()
            row["recallModel"] = "liquid/d1.2-ultra-20261116"
            row["recallRequestedModel"] = "liquid/d1.2-ultra@https://custom.example/v1/decisions"
            cohort = cohort_row(row)
            cohort["model"] = "liquid/d1.2-ultra-20261116"
            cohort["requestedModel"] = "liquid/d1.2-ultra"
            source_file = write_rows(root / "queries.jsonl", [row])
            cohort_file = write_rows(root / "cohort.jsonl", [cohort])
            with self.assertRaisesRegex(ValueError, "recallRequestedModel mismatches"):
                prepare.prepare([source_file], [cohort_file], root / "prepared", CharacterTokenizer())
            # A target missing recallRequestedModel is also rejected against a custom-endpoint scoped cohort.
            unscoped = query_row()
            unscoped["recallModel"] = "liquid/d1.2-ultra-20261116"
            scoped_cohort = cohort_row(unscoped)
            scoped_cohort["model"] = "liquid/d1.2-ultra-20261116"
            scoped_cohort["requestedModel"] = "liquid/d1.2-ultra@https://custom.example/v1/decisions"
            with self.assertRaisesRegex(ValueError, "recallRequestedModel mismatches"):
                prepare.prepare(
                    [write_rows(root / "unscoped.jsonl", [unscoped])],
                    [write_rows(root / "scoped-cohort.jsonl", [scoped_cohort])],
                    root / "prepared-scoped",
                    CharacterTokenizer(),
                )

    def test_atomic_publication_cleans_staging_on_mid_write_failure_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [query_row(node=f"n{i}", session=f"s{i}", request=f"Request {i}", event=i + 1) for i in range(4)]
            source = write_rows(root / "queries.jsonl", rows)
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            out = root / "prepared"

            real_write_jsonl = prepare.write_jsonl
            call_count = 0

            def flaky_write_jsonl(path, data):
                nonlocal call_count
                call_count += 1
                if call_count == 3:
                    raise OSError("simulated mid-write disk failure")
                return real_write_jsonl(path, data)

            with mock.patch.object(prepare, "write_jsonl", side_effect=flaky_write_jsonl):
                with self.assertRaisesRegex(OSError, "simulated mid-write disk failure"):
                    prepare.prepare([source], [cohort], out, CharacterTokenizer())

            self.assertFalse(out.exists())
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["cohort.jsonl", "queries.jsonl"])

            # Immediate retry succeeds cleanly and publishes private directory + 0o600 files.
            manifest = prepare.prepare([source], [cohort], out, CharacterTokenizer())
            self.assertTrue(out.is_dir())
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual((out / "manifest.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["cohort.jsonl", "prepared", "queries.jsonl"])
            for name, expected_hash in manifest["files"].items():
                published = out / name
                self.assertEqual(published.stat().st_mode & 0o777, 0o600)
                self.assertEqual(hashlib.sha256(published.read_bytes()).hexdigest(), expected_hash)

    def test_atomic_publication_rejects_racing_destination_without_overwriting_or_leaking_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = query_row()
            source = write_rows(root / "queries.jsonl", [row])
            cohort = write_rows(root / "cohort.jsonl", [cohort_row(row)])
            out = root / "prepared"

            real_write_jsonl = prepare.write_jsonl
            created = False

            def racing_write_jsonl(path, data):
                nonlocal created
                real_write_jsonl(path, data)
                if not created:
                    created = True
                    out.mkdir(mode=0o700)
                    (out / "sentinel.txt").write_text("do-not-overwrite")

            with mock.patch.object(prepare, "write_jsonl", side_effect=racing_write_jsonl):
                with self.assertRaises(FileExistsError):
                    prepare.prepare([source], [cohort], out, CharacterTokenizer())

            self.assertEqual((out / "sentinel.txt").read_text(), "do-not-overwrite")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["cohort.jsonl", "prepared", "queries.jsonl"])

    def test_configurable_min_score_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                query_row(node="n1", session="s1", request="Low score", event=1, probability=0.55),
                query_row(node="n2", session="s2", request="Mid score", event=2, probability=0.75),
                query_row(node="n3", session="s3", request="High score", event=3, probability=0.92),
            ]
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))

            # Lower threshold (0.5) admits all 3 rows.
            all_sources = write_rows(root / "all-queries.jsonl", rows)
            low_report = prepare.prepare([all_sources], [cohort], root / "out-low", CharacterTokenizer(), min_score=0.5)
            self.assertEqual(low_report["cohortSourceExamples"], 3)
            self.assertEqual(low_report["minScore"], 0.5)
            self.assertEqual(low_report["counts"]["train"] + low_report["counts"]["validation"], 3)

            # Higher threshold (0.8) admits only the 0.92 row and rejects a 0.75 query target.
            high_only = write_rows(root / "high-queries.jsonl", [rows[2]])
            high_report = prepare.prepare([high_only], [cohort], root / "out-high", CharacterTokenizer(), min_score=0.8)
            self.assertEqual(high_report["cohortSourceExamples"], 1)
            self.assertEqual(high_report["minScore"], 0.8)
            self.assertEqual(high_report["counts"]["train"] + high_report["counts"]["validation"], 1)

            mid_source = write_rows(root / "mid-queries.jsonl", [rows[1]])
            with self.assertRaisesRegex(ValueError, "below the recall threshold"):
                prepare.prepare([mid_source], [cohort], root / "out-reject", CharacterTokenizer(), min_score=0.8)
            self.assertFalse((root / "out-reject").exists())

            for bad in (-0.1, 1.1, float("nan"), True):
                with self.assertRaisesRegex(ValueError, "Invalid min_score"):
                    prepare.prepare([high_only], [cohort], root / "out-bad", CharacterTokenizer(), min_score=bad)

    def test_input_files_are_hashed_from_exact_bytes_read_for_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                query_row(node="n1", session="s1", request="First", event=1),
                query_row(node="n2", session="s2", request="Second", event=2),
            ]
            source = write_rows(root / "queries.jsonl", rows)
            cohort = write_rows(root / "cohort.jsonl", map(cohort_row, rows))
            expected_source_bytes = source.read_bytes()
            expected_cohort_bytes = cohort.read_bytes()
            expected_source_hash = hashlib.sha256(expected_source_bytes).hexdigest()
            expected_cohort_hash = hashlib.sha256(expected_cohort_bytes).hexdigest()

            # Simulate concurrent replacement of the path on disk right after open("rb") begins:
            # hash-while-reading must record the SHA-256 of the exact open FD bytes parsed, never a second read pass.
            original_open = Path.open
            open_counts = {}

            def tracking_open(self_path, *args, **kwargs):
                handle = original_open(self_path, *args, **kwargs)
                resolved = str(self_path.resolve())
                if self_path in (source, cohort):
                    open_counts[resolved] = open_counts.get(resolved, 0) + 1
                    # Atomically replace path on disk after FD is opened (UNIX inode of `handle` stays original).
                    replacement = self_path.with_suffix(".replaced")
                    replacement.write_text('{"corrupted":true}\n')
                    replacement.replace(self_path)
                return handle

            with mock.patch.object(Path, "open", tracking_open):
                manifest = prepare.prepare([source], [cohort], root / "prepared", CharacterTokenizer())

            self.assertEqual(open_counts[str(source.resolve())], 1)
            self.assertEqual(open_counts[str(cohort.resolve())], 1)
            self.assertEqual(manifest["sources"][str(source.resolve())], expected_source_hash)
            self.assertEqual(manifest["cohortSources"][str(cohort.resolve())], expected_cohort_hash)
            self.assertNotEqual(hashlib.sha256(source.read_bytes()).hexdigest(), expected_source_hash)


if __name__ == "__main__":
    unittest.main()
