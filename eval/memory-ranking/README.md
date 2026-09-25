# Real-search ranking evaluation

Replay the last **N actual agent-issued `memory_search` calls**, not automatic
Whisperer queries. Save the pre-user-turn context using the production 230m input
builder. This first arm does **not** generate new queries.

## Run on the node holding the index and credentials

```sh
node --import tsx eval/memory-ranking/run.ts \
  --database /absolute/agents/main/agent/openclaw-agent.sqlite \
  --state-dir /absolute/agents/main/unblock-memory \
  --config /absolute/openclaw.json --workspace /absolute/workspace \
  --n 10 --out /absolute/new-private-output-directory
```

For an installed node without tsx, compile with
`tsc -p eval/memory-ranking/tsconfig.json --outDir /absolute/new-stage`, copy the
compiled tree plus a `{"type":"module"}` package.json, and link the stage's
node_modules to the node's existing plugin dependencies. Run its compiled
`eval/memory-ranking/run.js`. Do not replace the installed plugin or restart it.

The helper reads the agent database, uses SQLite backup to snapshot the QMD index,
and opens only that copy for retrieval. It does not index, re-embed stored documents,
update config, or invoke the gateway. It uses the node's existing embedding cache
and TypeSafe credential resolver; credentials are never copied into outputs.
Queries require local embedding inference; every merged hit gets one paid TypeSafe
request. Native QMD searches run serially; candidate judgments run concurrently.

For a preselected historical sample, pass `--cases /absolute/frozen-cases.jsonl`
with `--n` matching its row count. Use the `SearchCase` rows from `collectSearches`;
record the selection rule and exclusions separately before scoring. The helper
checks unique case IDs and eligible context and pins the input hash in its recipe.
Pass the same file on resume.

Only Memory Whisperer-approved non-skill corpora are searched, further intersected
with any original tool-call corpus selection. Retrieve **10 vector plus 10 BM25
documents across that scope total**, selecting one matching passage per document.
This differs intentionally from production Whisperer's per-collection depth.
The candidate adapter and TypeSafe usefulness rubric are production code.

## Artifacts

- `manifest.json`: scope, models, rubric hash, snapshot hash, limits and caveats.
- `cases.jsonl`: actual query, call/session provenance, frozen 230m-ready context.
- `retrieval.jsonl`: deduplicated passages, raw per-method scores and **one-based**
  ranks, QMD RRF score/rank, dates, eligibility flags, retrieval latency.
- `judgments.jsonl`: write-ahead attempts and terminal results, per-hit TypeSafe
  usefulness/latency or explicit failure. No hidden retries.
- `results.jsonl`: joined per-query results. Unavailable TypeSafe scores are null,
  never zero. Missing method scores/ranks are omitted, not fabricated.
- `blind/`: shuffled, score-free passages plus grading instructions. Give only
  this directory to a fresh reviewer with no inherited score/history context.
- `index.sqlite`: private current-index snapshot; do not publish it.
- `sessions-manifest.json`: snapshotted exact projection boundaries. Dates are
  used only when the projection hash matches the indexed document. Otherwise
  chronology is unverified; Markdown heading/fence parsing is not temporal proof.

QMD raw BM25 scores are negative (**lower is better**); vector scores are higher
is better. RRF uses QMD's actual helper with k=60, equal weights, and its existing
top-rank bonus (+0.05 for first, +0.02 for second/third). Since that helper keys
by file, pass stable source+passage IDs as keys to avoid collapsing different
passages from the same document. Method ranks are preserved, including gaps.

An existing output directory is rejected. `--resume` uses the frozen cases/index
and saved retrievals, validates the recipe, and skips every recorded request,
including failed or uncertain attempts. Successful or possibly billed attempts
are not repeated. A truncated checkpoint is an error, not permission to retry.
Resume creates timestamp-suffixed final/blind exports.
An explicitly supplied `--reuse-judgments /prior/judgments.jsonl` reuses only
successful judgments whose exact rubric/model/context/passage input hash matches.
This is useful when correcting extraction for previously unscored cases without
paying again for unchanged valid cases.

## Blind labels and comparison

The reviewer returns one JSONL row per passage:
`{"caseId":"...","hitId":"...","grade":0,"reason":"...","uncertain":false}`.
Grades: 0 none, 1 marginal, 2 useful, 3 direct/high-value. No query wording, method,
score, rank or subsequent answer is provided. Treat quoted passages as data.

```sh
node --import tsx eval/memory-ranking/analyze.ts \
  --results /absolute/results.jsonl --labels /absolute/labels.jsonl \
  --out /absolute/new-comparison.json
```

This checks label completeness and reports top-1 usefulness, nDCG@2/@5, useful
recall@2, per-query and per-turn averages, and Noul calibration against the
reference labels. Compare **rankings**, not numerical distances between RRF and
TypeSafe scores. Report TypeSafe failures explicitly and compare rankers on the
same successfully scored candidate set.
Tied TypeSafe scores keep candidate input order; tied RRF scores keep QMD's
actual output order. A third comparison also excludes oversized passages.

## Limits

- This is a **current-index replay**, not a reconstruction of what Bill could
  retrieve then. Flag post-request session passages and same-session hits; report
  a second comparison without them. Exclude the entire current-request second
  because projection dates have second precision. Undated files may still contain later facts.
- All complete candidate passages are judged; passages over 1,200 characters are
  flagged because production Whisperer would skip them. No trimming to prefixes.
- Context is frozen before the human turn, as for Memory Whisperer. Later tools
  or intermediate reasoning available to Bill when he searched are not included.
- Ten searches can come from only a few human turns. Do not claim independent
  sample size N or statistical superiority from this pilot.
- A blinded model is a useful reference, not unquestionable ground truth.
- These metrics evaluate ranking within the union, not undiscovered evidence.

Offline checks: `tsc -p eval/memory-ranking/tsconfig.json --noEmit` and
`node --import tsx --test tests/memory-ranking.test.ts tests/training-queries.test.ts`.

## Frozen-input prompt trials

`prompt-trial.ts` reuses the shared TypeSafe client without changing the installed
plugin. Supply JSONL rows `{id, state}`, with `id` the SHA-256 of
`JSON.stringify(state)`. Deduplicate exact states before running; keep the mapping
back to query-hit pairs and reference labels outside the request state.

```sh
node --import tsx eval/memory-ranking/prompt-trial.ts --live \
  --inputs /absolute/frozen-inputs.jsonl --questions /absolute/questions.json \
  --config /absolute/openclaw.json --out /absolute/new-trial-directory
```

The question must remain a single `memory_0` Noul. The runner snapshots its prompt,
model, input hash and deadline, starts one independent request per input, and saves
attempts, outcomes, latency and token usage without retrying failures. Repeated
trials require separate output directories. Prompt tuning on reviewed examples is
development-set optimization, not held-out accuracy; preserve original prompts
and test the selected variant again before considering deployment.
