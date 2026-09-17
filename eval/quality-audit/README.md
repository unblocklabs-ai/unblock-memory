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
