# Quality-audit sanity check

Eight synthetic examples, no private corpus data. This is a small behavioral
probe, not an accuracy benchmark or a calibrated production threshold.

```sh
node --import tsx eval/quality-audit/check.ts
node --env-file=.env --import tsx eval/quality-audit/check.ts --live
```

The first command is offline. `--live` sends the synthetic text to TypeSafe and
prints probabilities plus the combined review decision. Keep `.env` untracked.

The initial eight-case run at `minNoise: 0.8` left all six useful examples unflagged
and flagged transport debris, but missed the escaped message envelope (noise 0.59,
evidence 0.93). The audit therefore separately flags JSON strings that decode to
message envelopes as possible encoding defects. It does not label their content
worthless or flag ordinary JSON objects by shape. Review findings against real
sources before taking action; misses and false positives remain possible.

The combined policy matched all eight expected review decisions in the follow-up
run (867 ms across two requests). That fixes this encoding case, not the general
problem of recognizing every kind of ingestion defect.

## Prose versus structured JSON

The structured prompts keep the prose policy, model, thresholds and state content
unchanged, organizing instructions and criteria into labeled objects/arrays. The
quality judge has a new version so runtime caches do not reuse prose judgments.

The opt-in on-host workflow is:

1. `audit-pages.py REPORT_DIRECTORY` calls the installed Gateway's
   `memory_audit_quality` for agent `main` until `done`. It saves private page
   results and a resumable cursor, and stops on three non-progressing pages.
   Run it only after approval to transmit the configured corpora. It writes
   review indicators, not source repairs.
2. `snapshot-structure.ts CONFIG WORKSPACE STATE_DIRECTORY OUTPUT` reads the
   approved corpus index and baseline judgment cache, without mutating either.
   It samples up to 100 unique chunks per corpus by content hash, plus up to 40
   baseline-noise-enriched examples per corpus. The latter is a diagnostic
   sample, not an estimate of defect prevalence. Keep the snapshot on-host.
3. `structure-fixtures.ts PRIOR_SKILL_RESULTS OUTPUT` prepares synthetic cases
   with frozen top-three QMD shortlists from the earlier Skill Whisperer eval.
   It includes 12 Memory Whisperer cases and the eight quality sanity cases.
4. `compare-structure.ts BASELINE_MODULE STRUCTURED_MODULE CASES OUTPUT CONFIG`
   invokes the two actual modules twice each, alternating order. It reads the
   key from the host config without logging it. Quality batches remain four;
   state is identical for each pair, and labels/source paths are never sent.
   The 10-second experiment deadline separates model behavior from production's
   shorter request budget. Results include latency, usage, state/module hashes
   and decisions; no live plugin replacement or cache/inbox writes occur.
5. `summarize-structure.py RESULTS` rejects incomplete runs and checks paired
   input/model equality before reporting disagreement, repeat variation,
   synthetic-label accuracy and latency. Unlabeled corpus changes are not
   accuracy gains. Latencies above 1.5 seconds are reported separately.

Build the TypeScript harness for a remote host with:

```sh
npx tsc -p eval/quality-audit/tsconfig.json --noEmit false --declaration false \
  --outDir reports/typesafe-structure/build --rootDir .
```

Private snapshots/results belong in a mode-700 on-host directory with mode-600
files, outside a repository or indexed corpus. Only sanitized aggregate results
should enter this repository. A comparison failure retains partial results and
does not substitute a prediction or produce a success summary.
