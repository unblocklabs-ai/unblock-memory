# Response audit calibration

Run only on an approved host with its existing local key. Evidence/labels/results
are private sandbox files, never repository fixtures or memory inputs.

- `pilot.mjs PLUGIN STATE OUTPUT SENDER live 60 2`: up to two 100-episode batches,
  then cache, CLI and unchanged-config checks. Uses a fresh output directory.
- `compare.mjs BASELINE CANDIDATE`: compare stored judgments and composed outcomes.
- `sentiment.mjs PLUGIN KEYFILE OUTPUT`: nine invented sentiment controls through
  the live API. No transcript reads. Writes an exclusive private result file;
  distinguish strict probability targets from whether a false flag was emitted.
- `holdout.mjs prepare PLUGIN STATE OUTPUT BASELINE SENDER`: freeze up to 12
  eligible exchanges from distinct sessions absent from BASELINE/evidence.json.
  Looks back 90 days, inspects at most 200 new eligible sessions from a bounded
  500-session metadata selection. No TypeSafe request is made during preparation.
- Read the frozen evidence BEFORE any predictions. Create `holdout-labels.json`
  with `reviewerType` (`human` or `agent`), `evidenceSha256`, and `rows` containing
  each `id`, `inputHash`, `expected` (`reported_shortfall`, `acknowledged_success`,
  `unknown`) and a brief evidence-based `note`. Do not put credentials in labels.
- `holdout.mjs score PLUGIN STATE OUTPUT BASELINE SENDER`: validate the labels and
  excluded sessions, then evaluate once. Reports exact agreement, false flags,
  missed shortfalls, recall (null with no positive labels), and classified coverage.
  Output creation is exclusive; do not overwrite results to hide unsuccessful runs.

Keep development and held-out sessions disjoint. Do not tune prompts or thresholds
against held-out results and then present them as independent validation. Agent
review is not human ground truth. The 0.8 production thresholds remain provisional
until enough independently human-labeled positive AND negative examples exist.
Review uncertainty and reasons separately from binary flag accuracy; sample
selection and repeated exchanges can bias aggregate rates.

Rubric v10 and report v3 are distinct: unchanged typed judgments can be re-composed
offline without paying for inference. The CLI report exposes both versions; never
compare historical reports across different report policies as agent performance.
