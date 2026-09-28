#!/usr/bin/env python3
"""Private LFM preparation from frozen recall-gate cohorts and resolved query exports.

Write a NEW private directory. Never train, upload, or discard unresolved heldout cases.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from query_contract import CONTRACT, MODEL, REVISION, load_tokenizer, student_messages, validate_conversation, validate_query_pair

SECRET_PATTERNS = {
    "private-key": r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----",
    "credential-token": r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AKIA[A-Z0-9]{16})\b",
    "bearer-token": r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}",
    "assigned-secret": r"(?i)\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\b[\s\"']*[:=][\s\"']*[^\s\"',;{}]{12,}",
    "url-credential": r"https?://[^\s/:]+:[^\s/@]+@",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def secret_reasons(value):
    content = json.dumps(value, ensure_ascii=False)
    return [name for name, pattern in SECRET_PATTERNS.items() if re.search(pattern, content)]


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
        hashes[str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open() as source:
            for line_number, line in enumerate(source, 1):
                yield json.loads(line), {"export": str(path.resolve()), "line": line_number}


def valid_recall_row(row, stage):
    probability = row.get("recallProbability") if isinstance(row, dict) else None
    if not isinstance(row, dict) or row.get("stage") != stage or type(probability) not in (int, float) or \
            not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError(f"Invalid {stage} row")
    return probability >= 0.7


def input_hash(row):
    value = row.get("inputHash")
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
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


def prepare(exports, cohort_exports, output, tokenizer, validation_fraction=0.1):
    if not cohort_exports:
        raise ValueError("A frozen recall-gate cohort is required")
    if not math.isfinite(validation_fraction) or not 0 <= validation_fraction <= 1:
        raise ValueError("Invalid validation fraction")
    if output.exists():
        raise FileExistsError(output)
    parent, inputs, cohort, provenance, quarantined = {}, {}, {}, [], []
    cohort_hashes, file_hashes = {}, {}
    cohort_rows = 0

    # Membership and connected groups come exclusively from the frozen cohort,
    # never from which teacher examples happened to succeed.
    for row, location in read_exports(cohort_exports, cohort_hashes):
        if not valid_recall_row(row, "recall-gate"):
            continue
        cohort_rows += 1
        validate_conversation(row["input"], tokenizer)
        key, checkpoint_hash = digest(row["input"]), input_hash(row)
        if not isinstance(row.get("sources"), list) or not row["sources"]:
            raise ValueError("Recall cohort row has no historical sources")
        inputs.setdefault(key, row["input"])
        for raw in row["sources"]:
            identity, source = source_identity(raw, "id")
            item = {"id": identity, "inputId": key, "inputHash": checkpoint_hash, "source": source}
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

    groups = {find(parent, "input:" + key) for key in inputs}
    split = {group: "validation" if int(digest(group)[:8], 16) / 2**32 < validation_fraction else "train" for group in groups}
    if len(groups) > 1 and len(set(split.values())) == 1:
        ordered = sorted(groups, key=digest)
        split[ordered[0]], split[ordered[-1]] = "validation", "train"
    cohort_quarantine = {item["id"] for item in quarantined}

    prepared, targets = {}, {}
    target_inputs, target_sources = set(), set()
    overlength = 0
    for row, location in read_exports(exports, file_hashes):
        if not valid_recall_row(row, "query-training"):
            raise ValueError("Query target is below the recall threshold")
        validate_conversation(row["input"], tokenizer)
        key, checkpoint_hash = digest(row["input"]), input_hash(row)
        identity, source = source_identity(row["source"], "sourceId")
        frozen = cohort.get(identity)
        if frozen is None or frozen["inputId"] != key or frozen["inputHash"] != checkpoint_hash or frozen["source"] != source:
            raise ValueError(f"Query target is outside the frozen cohort: {identity}")
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

    counts = {"train": 0, "validation": 0, "validationEval": 0, "validationUnresolved": 0,
              "quarantined": len(quarantined) - overlength, "overlength": overlength}
    tokens = {"train": 0, "validation": 0}
    os.umask(0o077)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for partition in ("train", "validation"):
        with (output / (partition + ".jsonl")).open("x") as writer:
            for key, item in sorted(prepared.items()):
                if split[find(parent, "input:" + key)] == partition:
                    writer.write(json.dumps(item, ensure_ascii=False) + "\n")
                    counts[partition] += 1
                    tokens[partition] += item["tokenCount"]
    membership = []
    with (output / "validation-eval.jsonl").open("x") as writer:
        for identity, item in sorted(cohort.items()):
            group = find(parent, "input:" + item["inputId"])
            membership.append({"id": identity, "inputId": item["inputId"], "splitGroup": digest(group),
                               "split": split[group], "quarantined": identity in cohort_quarantine})
            if split[group] != "validation" or identity in cohort_quarantine:
                continue
            evaluation = {"id": identity, "input": inputs[item["inputId"]], "source": item["source"], "splitGroup": digest(group)}
            if identity in targets:
                evaluation["target"] = targets[identity]
            else:
                counts["validationUnresolved"] += 1
            writer.write(json.dumps(evaluation, ensure_ascii=False) + "\n")
            counts["validationEval"] += 1
    for name, rows in [("provenance", provenance), ("quarantine", quarantined), ("cohort-splits", membership)]:
        with (output / (name + ".jsonl")).open("x") as destination:
            for row in rows:
                destination.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest = {"model": MODEL, "revision": REVISION, "format": "official chat template; assistant-only causal-LM loss",
                "sources": file_hashes, "cohortSources": cohort_hashes, "cohortRows": cohort_rows,
                "cohortSourceExamples": len(cohort), "uniqueInputs": len(inputs), "sourceRows": len(provenance),
                "targetInputs": len(target_inputs), "targetSources": len(target_sources),
                "duplicates": len(provenance) - len(target_inputs), "connectedGroups": len(groups), "counts": counts, "tokens": tokens,
                "privacy": "Private local data. Regex secret screen is not exhaustive; quarantine contains IDs and source-file references, not secret text.",
                "split": f"Frozen recall-positive cohort; deterministic {validation_fraction:.0%} group hash; connected session/identical-input groups never cross splits",
                "tokenCeiling": CONTRACT["contextTokens"], "conversationTokenCeiling": CONTRACT["conversationTokens"],
                "conversationByteCeiling": CONTRACT["conversationBytes"], "queryContract": CONTRACT["version"],
                "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.iterdir())}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="+", type=Path)
    parser.add_argument("--cohort", nargs="+", required=True, type=Path, help="Frozen recall-gate exports, before target success filtering")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    tokenizer = load_tokenizer()
    print(json.dumps(prepare(args.exports, args.cohort, args.output, tokenizer), indent=2))


if __name__ == "__main__":
    main()
