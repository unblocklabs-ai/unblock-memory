#!/usr/bin/env python3
"""Private LFM preparation from frozen recall-gate cohorts and resolved query exports.

Write a NEW private directory. Never train, upload, or discard unresolved heldout cases.
"""
import argparse
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from query_contract import CONTRACT, MODEL, REVISION, load_tokenizer, student_messages, validate_conversation, validate_query_pair

SECRET_PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    "credential-token": re.compile(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AKIA[A-Z0-9]{16})\b"),
    "bearer-token": re.compile(r"\bbearer\s+[A-Za-z0-9._~+/-]{20,}", re.IGNORECASE),
    "assigned-secret": re.compile(r"\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\b[\s\"']*[:=][\s\"']*[^\s\"',;{}]{12,}", re.IGNORECASE),
    "url-credential": re.compile(r"https?://[^\s/:]+:[^\s/@]+@"),
}
INPUT_HASH_PATTERN = re.compile(r"[a-f0-9]{64}")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def secret_reasons(value):
    content = json.dumps(value, ensure_ascii=False)
    return [name for name, pattern in SECRET_PATTERNS.items() if pattern.search(content)]


def optional_nonempty_str(row, key):
    value = row.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _open_private(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "w", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


def write_jsonl(path, rows):
    with _open_private(path) as destination:
        for row in rows:
            destination.write(json.dumps(row, ensure_ascii=False) + "\n")


def find(parent, value):
    parent.setdefault(value, value)
    while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
    return value


def connect(parent, left, right):
    a, b = find(parent, left), find(parent, right)
    parent[max(a, b)] = min(a, b)


def read_exports(paths, hashes):
    for path in sorted(paths):
        resolved = str(path.resolve())
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            for line_number, raw_line in enumerate(source, 1):
                hasher.update(raw_line)
                yield json.loads(raw_line.decode("utf-8")), {"export": resolved, "line": line_number}
        hashes[resolved] = hasher.hexdigest()


def valid_recall_row(row, stage, min_score=0.7):
    probability = row.get("recallProbability") if isinstance(row, dict) else None
    if not isinstance(row, dict) or row.get("stage") != stage or type(probability) not in (int, float) or \
            not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError(f"Invalid {stage} row")
    return probability >= min_score


def input_hash(row):
    value = row.get("inputHash")
    if not isinstance(value, str) or not INPUT_HASH_PATTERN.fullmatch(value):
        raise ValueError("Invalid exported input hash")
    return value


def source_identity(raw, id_field):
    if not isinstance(raw, dict) or any(not isinstance(raw.get(key), str) or not raw[key].strip()
                                       for key in ("nodeId", "agentId", "sessionId", id_field)) or \
            any(type(raw.get(key)) is not int or raw[key] < 0 for key in ("userEventId", "timestamp")):
        raise ValueError("Invalid historical source identity")
    source = {key: raw[key] for key in ("nodeId", "agentId", "sessionId", "userEventId", "timestamp")}
    source["sourceId"] = raw[id_field]
    return digest([source["nodeId"], source["agentId"], source["sourceId"]]), source


def training_row(key, conversation, target, tokenizer, group):
    messages = student_messages(conversation)
    target_text = json.dumps(target, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    text = tokenizer.apply_chat_template(messages + [{"role": "assistant", "content": target_text}], tokenize=False)
    prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
    ids = tokenizer.encode(text, add_special_tokens=False)
    if ids[:len(prompt_ids)] != prompt_ids:
        raise ValueError("Tokenizer prompt boundary is not prefix-stable")
    if len(ids) > CONTRACT["contextTokens"]:
        return None, "over-32768-tokens"
    if len(ids) - len(prompt_ids) > CONTRACT["outputTokens"]:
        return None, "target-exceeds-output-budget"
    return {"id": key, "splitGroup": digest(group),
            "messages": messages + [{"role": "assistant", "content": target_text}], "text": text,
            "input_ids": ids, "attention_mask": [1] * len(ids),
            "labels": [-100] * len(prompt_ids) + ids[len(prompt_ids):], "tokenCount": len(ids)}, None


def _load_cohort(cohort_exports, tokenizer, min_score):
    parent, inputs, cohort, quarantined = {}, {}, {}, []
    cohort_hashes = {}
    cohort_rows = 0

    # Membership and connected groups come exclusively from the frozen cohort,
    # never from which teacher examples happened to succeed.
    for row, location in read_exports(cohort_exports, cohort_hashes):
        if not valid_recall_row(row, "recall-gate", min_score):
            continue
        cohort_rows += 1
        validate_conversation(row["input"], tokenizer)
        key, checkpoint_hash = digest(row["input"]), input_hash(row)
        if not isinstance(row.get("sources"), list) or not row["sources"]:
            raise ValueError("Recall cohort row has no historical sources")
        inputs.setdefault(key, row["input"])
        cohort_model = optional_nonempty_str(row, "model")
        cohort_requested = optional_nonempty_str(row, "requestedModel")
        for raw in row["sources"]:
            identity, source = source_identity(raw, "id")
            item = {"id": identity, "inputId": key, "inputHash": checkpoint_hash, "source": source,
                    **({"recallModel": cohort_model} if cohort_model else {}),
                    **({"recallRequestedModel": cohort_requested} if cohort_requested else {})}
            if identity in cohort and cohort[identity] != item:
                raise ValueError(f"Conflicting frozen cohort source: {identity}")
            if identity in cohort:
                continue
            cohort[identity] = item
            session = "session:" + digest([source[k] for k in ("nodeId", "agentId", "sessionId")])
            connect(parent, "input:" + key, session)
            reasons = secret_reasons({"input": row["input"], "source": source})
            if reasons:
                quarantined.append({"id": identity, "inputId": key, "stage": "cohort", "reasons": reasons, **location})

    return parent, inputs, cohort, quarantined, cohort_hashes, cohort_rows


def _assign_splits(parent, inputs, validation_fraction):
    groups = {find(parent, "input:" + key) for key in inputs}
    split = {group: "validation" if int(digest(group)[:8], 16) / 2**32 < validation_fraction else "train" for group in groups}
    if len(groups) > 1 and len(set(split.values())) == 1:
        ordered = sorted(groups, key=digest)
        split[ordered[0]], split[ordered[-1]] = "validation", "train"
    return groups, split


def _load_targets(exports, cohort, parent, cohort_quarantine, tokenizer, min_score):
    prepared, targets, file_hashes = {}, {}, {}
    provenance, quarantined = [], []
    target_inputs, target_sources = set(), set()
    overlength = 0

    for row, location in read_exports(exports, file_hashes):
        if not valid_recall_row(row, "query-training", min_score):
            raise ValueError("Query target is below the recall threshold")
        validate_conversation(row["input"], tokenizer)
        key, checkpoint_hash = digest(row["input"]), input_hash(row)
        identity, source = source_identity(row["source"], "sourceId")
        frozen = cohort.get(identity)
        if frozen is None or frozen["inputId"] != key or frozen["inputHash"] != checkpoint_hash or frozen["source"] != source:
            raise ValueError(f"Query target is outside the frozen cohort: {identity}")
        query_model = optional_nonempty_str(row, "recallModel")
        if frozen.get("recallModel") and query_model and frozen["recallModel"] != query_model:
            raise ValueError(f"Query target recallModel mismatches frozen cohort: {identity}")
        query_requested = optional_nonempty_str(row, "recallRequestedModel")
        frozen_requested = frozen.get("recallRequestedModel")
        if frozen_requested and (
            (query_requested and frozen_requested != query_requested)
            or (not query_requested and "@" in frozen_requested)
        ):
            raise ValueError(f"Query target recallRequestedModel mismatches frozen cohort: {identity}")
        target = validate_query_pair(row["target"])
        target_inputs.add(key)
        target_sources.add(identity)
        # Hashes/references retain all alternate-label provenance without copying
        # a quarantined target's potential credentials into the prepared directory.
        provenance.append({"id": identity, "inputId": key, "inputHash": checkpoint_hash,
                           "targetHash": digest(target), **location})
        if identity in cohort_quarantine:
            continue
        reasons = secret_reasons(target)
        if reasons:
            quarantined.append({"id": identity, "inputId": key, "stage": "target", "reasons": reasons, **location})
            continue
        group = find(parent, "input:" + key)
        item, reason = training_row(key, row["input"], target, tokenizer, group)
        if reason:
            quarantined.append({"id": identity, "inputId": key, "stage": "target", "reasons": [reason], **location})
            overlength += 1
            continue
        # First valid target in stable export/line order wins for identical inputs;
        # independent source-specific targets remain available to heldout evaluation.
        prepared.setdefault(key, item)
        targets.setdefault(identity, target)

    return prepared, targets, provenance, quarantined, file_hashes, target_inputs, target_sources, overlength


def _write_outputs(output, parent, inputs, cohort, cohort_quarantine, groups, split,
                   prepared, targets, provenance, quarantined, file_hashes, cohort_hashes,
                   cohort_rows, target_inputs, target_sources, overlength, validation_fraction, min_score):
    counts = {"train": 0, "validation": 0, "validationEval": 0, "validationUnresolved": 0,
              "quarantined": len(quarantined) - overlength, "overlength": overlength}
    tokens = {"train": 0, "validation": 0}

    partition_rows = {"train": [], "validation": []}
    for key, item in sorted(prepared.items()):
        partition = split[find(parent, "input:" + key)]
        partition_rows[partition].append(item)
        counts[partition] += 1
        tokens[partition] += item["tokenCount"]

    membership, validation_eval = [], []
    for identity, item in sorted(cohort.items()):
        group = find(parent, "input:" + item["inputId"])
        group_digest = digest(group)
        membership.append({"id": identity, "inputId": item["inputId"], "splitGroup": group_digest,
                           "split": split[group], "quarantined": identity in cohort_quarantine})
        if split[group] != "validation" or identity in cohort_quarantine:
            continue
        evaluation = {"id": identity, "input": inputs[item["inputId"]], "source": item["source"], "splitGroup": group_digest}
        if identity in targets:
            evaluation["target"] = targets[identity]
        else:
            counts["validationUnresolved"] += 1
        validation_eval.append(evaluation)
        counts["validationEval"] += 1

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    published = False
    try:
        os.chmod(staging, 0o700)
        for name, rows in [
            ("train", partition_rows["train"]),
            ("validation", partition_rows["validation"]),
            ("validation-eval", validation_eval),
            ("provenance", provenance),
            ("quarantine", quarantined),
            ("cohort-splits", membership),
        ]:
            write_jsonl(staging / (name + ".jsonl"), rows)

        manifest = {"model": MODEL, "revision": REVISION, "format": "official chat template; assistant-only causal-LM loss",
                    "sources": file_hashes, "cohortSources": cohort_hashes, "cohortRows": cohort_rows,
                    "cohortSourceExamples": len(cohort), "uniqueInputs": len(inputs), "sourceRows": len(provenance),
                    "targetInputs": len(target_inputs), "targetSources": len(target_sources),
                    "duplicates": len(provenance) - len(target_inputs), "connectedGroups": len(groups), "counts": counts, "tokens": tokens,
                    "minScore": min_score,
                    "privacy": "Private local data. Regex secret screen is not exhaustive; quarantine contains IDs and source-file references, not secret text.",
                    "split": f"Frozen recall-positive cohort; deterministic {validation_fraction:.0%} group hash; connected session/identical-input groups never cross splits",
                    "tokenCeiling": CONTRACT["contextTokens"], "conversationTokenCeiling": CONTRACT["conversationTokens"],
                    "conversationByteCeiling": CONTRACT["conversationBytes"], "queryContract": CONTRACT["version"],
                    "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(staging.iterdir())}}
        with _open_private(staging / "manifest.json") as manifest_file:
            manifest_file.write(json.dumps(manifest, indent=2) + "\n")

        if output.exists() or output.is_symlink():
            raise FileExistsError(output)
        try:
            os.rename(staging, output)
        except OSError as exc:
            if exc.errno in (errno.EEXIST, errno.ENOTEMPTY, errno.ENOTDIR, errno.EISDIR):
                raise FileExistsError(output) from exc
            raise
        published = True
        return manifest
    finally:
        if not published:
            shutil.rmtree(staging, ignore_errors=True)


def prepare(exports, cohort_exports, output, tokenizer, validation_fraction=0.1, min_score=0.7):
    if not cohort_exports:
        raise ValueError("A frozen recall-gate cohort is required")
    if type(validation_fraction) not in (int, float) or not math.isfinite(validation_fraction) or not 0 <= validation_fraction <= 1:
        raise ValueError("Invalid validation fraction")
    if type(min_score) not in (int, float) or not math.isfinite(min_score) or not 0 <= min_score <= 1:
        raise ValueError("Invalid min_score")
    if output.exists() or output.is_symlink():
        raise FileExistsError(output)

    parent, inputs, cohort, cohort_quarantined, cohort_hashes, cohort_rows = _load_cohort(cohort_exports, tokenizer, min_score)
    groups, split = _assign_splits(parent, inputs, validation_fraction)
    cohort_quarantine = {item["id"] for item in cohort_quarantined}
    prepared, targets, provenance, target_quarantined, file_hashes, target_inputs, target_sources, overlength = _load_targets(
        exports, cohort, parent, cohort_quarantine, tokenizer, min_score,
    )
    quarantined = cohort_quarantined + target_quarantined
    return _write_outputs(
        output, parent, inputs, cohort, cohort_quarantine, groups, split,
        prepared, targets, provenance, quarantined, file_hashes, cohort_hashes,
        cohort_rows, target_inputs, target_sources, overlength, validation_fraction, min_score,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="+", type=Path)
    parser.add_argument("--cohort", nargs="+", required=True, type=Path, help="Frozen recall-gate exports, before target success filtering")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--min-score", type=float, default=0.7, help="Minimum recall probability threshold (default: 0.7)")
    args = parser.parse_args()
    tokenizer = load_tokenizer()
    print(json.dumps(prepare(args.exports, args.cohort, args.output, tokenizer, min_score=args.min_score), indent=2))


if __name__ == "__main__":
    main()
