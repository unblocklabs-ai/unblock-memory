"""Run the installed audit through Gateway tools.invoke; keep private results on-host."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    os.umask(0o077)
    report = Path(sys.argv[1]).resolve()
    report.mkdir(mode=0o700, parents=True, exist_ok=True)
    checkpoint = report / "audit-checkpoint.json"
    state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {
        "pages": 0, "done": False, "next": None,
        "totals": {key: 0 for key in ["scanned", "judged", "cached", "skippedOversized", "skippedStale", "flagged"]},
        "groups": {},
    }
    failures = 0
    while not state["done"]:
        args = {"limit": 20}
        if state["next"]:
            args["after"] = state["next"]
        params = {"name": "memory_audit_quality", "agentId": "main", "args": args}
        run = subprocess.run(["openclaw", "gateway", "call", "tools.invoke", "--params",
                              json.dumps(params), "--json", "--timeout", "45000"],
                             capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise RuntimeError("Gateway call failed; checkpoint retained")
        envelope = json.loads(run.stdout)
        result = envelope.get("output", {}).get("details", {})
        if not envelope.get("ok") or result.get("status") not in ["ok", "partial"]:
            raise RuntimeError("Audit unavailable or refused; checkpoint retained")
        with (report / "audit-pages.jsonl").open("a") as output:
            output.write(json.dumps(result) + "\n")
        for key in state["totals"]:
            state["totals"][key] += result.get(key, 0)
        for group in result.get("groups", []):
            key = group["corpus"] + ":" + group["reason"]
            state["groups"][key] = state["groups"].get(key, 0) + group["pending"]
        progressed = result.get("next") != state["next"]
        state.update(pages=state["pages"] + 1, done=result["done"], next=result.get("next"))
        staged = report / "audit-checkpoint.tmp"
        staged.write_text(json.dumps(state, indent=2) + "\n")
        staged.replace(checkpoint)
        if state["pages"] % 20 == 0 or state["done"]:
            print(json.dumps(state), flush=True)
        failures = 0 if progressed or result["done"] else failures + 1
        if failures >= 3:
            raise RuntimeError("Three non-progressing pages; stopped with resumable checkpoint")
        if result["status"] == "partial":
            time.sleep(2)


if __name__ == "__main__":
    main()
