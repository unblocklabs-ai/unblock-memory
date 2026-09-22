# Retrieval lab

Local synthetic comparison; no TypeSafe call or live OpenClaw corpus access.
QMD may download its embedding model if not already cached.

```sh
npm run eval:retrieval
npm run eval:retrieval -- --repeat 3 --out reports/retrieval-lab/my-new-run
```

`--repeat` accepts 1–20 (default 2). `--out` must not already exist. The default
creates a timestamped directory under ignored `reports/retrieval-lab/`.

Each run creates a temporary Markdown corpus and one isolated QMD index. One
runner compares `vector@5`, `vector@20`, `lexical`, and the SDK's existing
`hybrid@20` (`rerank:false`). Production retrieval is unchanged.

Read `README.md` in the report for the comparison, `inputs.json` for the frozen
corpus/labels/metadata, and `results.json` for raw first-trial predictions, scores
and successful-trial timings. Reports are private (0700 directory, 0600 report
files); corpus copies remain in the OS temporary directory. There is no real-dataset
loader or replay command yet. This tiny seed cannot establish product quality.

The [experiment plan](../../docs/planning/retrieval-staged-plan-2026-09-21.md)
is authoritative for budgets, metrics, current validation and limitations.
