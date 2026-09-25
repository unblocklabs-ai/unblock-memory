# Quality-audit sanity check

Eight synthetic examples, no private corpus data. This is a small behavioral
probe, not an accuracy benchmark or a calibrated production threshold.

```sh
node --import tsx eval/quality-audit/check.ts
```

The command is offline. The earlier on-host prompt-structure comparison is
recorded in [STRUCTURE-RESULTS.md](STRUCTURE-RESULTS.md). Its snapshot and
comparison harness targeted a retired state layout and has been removed; do not
treat those historical results as current runtime validation.

The initial eight-case run at `minNoise: 0.8` left all six useful examples unflagged
and flagged transport debris, but missed the escaped message envelope (noise 0.59,
evidence 0.93). The audit therefore separately flags JSON strings that decode to
message envelopes as possible encoding defects. It does not label their content
worthless or flag ordinary JSON objects by shape. Review findings against real
sources before taking action; misses and false positives remain possible.

The combined policy matched all eight expected review decisions in the follow-up
run (867 ms across two requests). That fixes this encoding case, not the general
problem of recognizing every kind of ingestion defect.

`audit-pages.py` remains an operator-only helper for an explicitly approved
Gateway quality audit. It writes private page results and a resumable cursor,
not source repairs. Run it only after approving transmission of the configured
corpora, and keep outputs outside the repository and indexed corpus.
