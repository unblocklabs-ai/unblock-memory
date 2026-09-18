"""Aggregate checkpointed paired results; report drift, not unlabeled accuracy."""
import json
from pathlib import Path
import statistics
import sys


def main():
    lines = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
    meta = lines[0]
    rows = [row for row in lines if row.get("type") == "result"]
    expected = meta["jobs"] * meta["repeats"] * 2
    if len(rows) != expected:
        raise RuntimeError(f"Incomplete comparison: {len(rows)}/{expected} requests")
    keyed = {(r["repeat"], r["job"], r["arm"]): r for r in rows}
    assert len(keyed) == expected, "Duplicate requests"
    for repeat in range(meta["repeats"]):
        for job in range(meta["jobs"]):
            a, b = [keyed[repeat, job, arm] for arm in ["baseline", "structured"]]
            assert a["stateHash"] == b["stateHash"], "Unequal paired state"
            assert a["stateHash"] == keyed[0, job, "baseline"]["stateHash"], "State changed across repeats"
            assert a["model"] == b["model"] == "jev-1.13.0", "Model mismatch"
    results = {}
    changes = []
    for kind in ["quality", "skill", "memory"]:
        filtered = [r for r in rows if r["kind"] == kind]
        if not filtered:
            continue
        decision = {"quality": "flagged", "skill": "selected", "memory": "included"}[kind]
        by_arm = {}
        for arm in ["baseline", "structured"]:
            requests = [r for r in filtered if r["arm"] == arm]
            outcomes = [o for r in requests for o in r["outputs"]]
            times = sorted(r["elapsedMs"] for r in requests)
            by_arm[arm] = {
                "requests": len(requests), "medianMs": statistics.median(times),
                "p95Ms": times[max(0, (95 * len(times) + 99) // 100 - 1)],
                "over1500ms": sum(t > 1500 for t in times),
                "inputTokens": sum(r.get("usage", {}).get("input_tokens", 0) for r in requests),
                "requestBytes": sum(r["requestBytes"] for r in requests),
            }
            if kind != "quality":
                by_arm[arm]["correct"] = sum(o["correct"] for o in outcomes)
                by_arm[arm]["decisions"] = len(outcomes)
            else:
                by_arm[arm]["cohorts"] = {}
                for corpus, cohort in sorted({(o["corpus"], o["cohort"]) for o in outcomes}):
                    subset = [o for o in outcomes if (o["corpus"], o["cohort"]) == (corpus, cohort)]
                    by_arm[arm]["cohorts"][corpus + ":" + cohort] = {
                        "unique": len({o["id"] for o in subset}), "decisions": len(subset),
                        "flagged": sum(o["flagged"] for o in subset),
                        "meanNoise": statistics.mean(o["noise"] for o in subset),
                        "labeledCorrect": sum(o["flagged"] == o["expected"] for o in subset if "expected" in o),
                        "labeledDecisions": sum("expected" in o for o in subset),
                    }
            first = {o["id"]: o for r in requests if r["repeat"] == 0 for o in r["outputs"]}
            second = {o["id"]: o for r in requests if r["repeat"] == 1 for o in r["outputs"]}
            by_arm[arm]["repeatDecisionChanges"] = sum(first[k][decision] != second[k][decision] for k in first)
        disagreements = 0
        for r in filtered:
            if r["arm"] != "baseline":
                continue
            other = keyed[r["repeat"], r["job"], "structured"]
            for a, b in zip(r["outputs"], other["outputs"]):
                assert a["id"] == b["id"]
                if a[decision] != b[decision]:
                    disagreements += 1
                    changes.append({"kind": kind, "repeat": r["repeat"], "baseline": a, "structured": b})
        results[kind] = {"arms": by_arm, "pairedDisagreements": disagreements}
    print(json.dumps({"complete": True, "requests": len(rows), "results": results, "changes": changes}, indent=2))


if __name__ == "__main__":
    main()
