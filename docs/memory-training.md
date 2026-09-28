# Memory training collector

Operator-only collection for **LFM2.5-230M-Base**. No scheduler, runtime recall
changes, memory writes, live-index mutation or automatic background inference.

## Recipe

1. Collect eligible historical user turns and preceding visible conversation.
2. TypeSafe `jev-1.13.0` recall probability **>=0.7** gates query generation.
   Preserve negative labels for audit; greetings do not need query targets.
3. Isolated `openai/gpt-6-luna`, **xhigh**, generates **five distinct queries per
   lane**: discriminating BM25 keywords for `lex`, semantic natural language for
   `vec`. No fallback model, agent tools, future answer, or retrieved evidence.
4. Retrieve ten matches per query using **only its lane's backend**, from the
   originating agent's historical sessions. Use the same complete-excerpt renderer
   and **1,200-character limit** as runtime, with no merged passage-count cap.
5. The shared runtime TypeSafe `noul` grader judges each distinct passage in its
   own request against the **original conversation**. It receives as-of time and
   passage source/date context, never query, rank, retrieval score, or backend.
6. Score each query by the **mean of its three highest raw probabilities**. Average
   available matches when fewer than three exist; empty retrieval scores zero.
   Failed judgments leave the query unresolved, not zero or partially scored.
7. Run **one revision round per lane**, giving Luna only the same conversation and
   that lane's previous queries and scores. Retrieve and grade five new candidates.
8. Independently select the highest-scoring exact query across both rounds for each
   lane, with stable candidate-order ties. Export one `{"lex":"...","vec":"..."}`.

There is one passage grader, not a training-only rubric. Keep valid, fully evaluated
examples even when one or both lanes find no useful evidence. Low scores and empty
retrieval do not disqualify good queries; select the best query per lane, preserving
candidate order on ties. The runtime usefulness threshold controls live hints only,
not training eligibility. Flag failed evaluations, malformed teacher outputs, and
unavailable historical snapshots for review; these unresolved examples receive no
target and are not exported for training.
V2 replaces v1 in place; no v1 execution mode or old-output compatibility parser.

## Commands

```sh
openclaw memory-training collect --agent main --dry-run
openclaw memory-training collect --agent main
openclaw memory-training run --agent main --concurrency 256
openclaw memory-training generate --agent main --concurrency 8
openclaw memory-training evaluate --agent main --concurrency 4
openclaw memory-training status --agent main
openclaw memory-training export --agent main --output /private/query-training.jsonl
openclaw memory-training export --agent main --stage recall-gate --output /private/recall-gate.jsonl
```

Collection supports inclusive `--since` and exclusive `--until YYYY-MM-DD` UTC,
using user-event time, not session start. Omit dates for all eligible history.
Appends enter only through a later collect; narrow bounds do not delete old cohorts.
Use the same `--threshold` for generate/evaluate/export/status (default 0.7).

`generate` creates the first-round candidates. `evaluate` retrieves/grades, calls
Luna for revisions, and selects winners, so it also requires isolated-completion access.

Optional `--max-examples` bounds new work. Run and generate default to a
3,000,000 serialized input-byte budget, **not tokens**; rerun to drain pending work.
Evaluate's optional `--max-calls` counts new retrievals, uncached passage judgments,
and revision teacher calls. Its revision teacher input-byte budget also defaults to
3,000,000. There is no default example/call-count cap.

Recall defaults to 256 concurrent requests, generation to 8 isolated completions.
Evaluation defaults to 4 inputs. Distinct remote passage judgments overlap;
identical conversation/passage judgments are reused across queries and rounds.
Native vector work is serialized per snapshot. Raise concurrency within machine
and provider capacity. Provider failures flag their examples while unrelated inputs
continue without retrying failed requests. Storage/lease failures still stop the run.
In-flight work drains and persists before snapshots close. Dry runs make no inference calls.

Cached evaluations still validate the exact historical text and vector fingerprint,
but do not rebuild a QMD index. The index is built only on the first uncached search,
from the same read-only SQLite transaction used to compute that fingerprint.
Concurrent queries share that index; changed corpus content still invalidates caches.

## Input and historical boundaries

Read original agent SQLite active-branch conversations (schema 17–19), including
direct/group/channel chats, excluding cron, heartbeat, spawned/subagent, hook/plugin
and untyped diagnostic sessions. Exclude explicit bots, synthetic messages,
analysis/thinking, errors and tool payloads. Ordinary older users need not have
enriched sender metadata. Strip recognized transport envelopes.

A following assistant reply/tool action establishes eligibility before the next
user/context boundary; delivery mirrors count, duplicate visible replies appear once.
The qualifying **future answer never enters its input**. Earlier visible replies
may appear in later inputs. Compaction/internal messages break history continuity.
Training and runtime share the pinned LFM tokenizer and **8,192-token / 24,000-byte**
serialized-conversation window. Drop oldest whole messages, never slice the latest
request. Oversized requests are skipped and listed by session ID/event sequence in
the collection report's `review` field, without persisting their oversized text. Sessions above 50,000 events or
32 MB become unavailable, not deleted. Tool calls can establish a response, but
tool outputs and thinking never enter the input.

Snapshots require matching projection hashes and trusted message spans. Copy
only prefixes before the **entire second of the user's timestamp**, stopping at
unknown/future dates. Never infer dates from quoted headings. Copy existing vectors
only for complete chunks within the safe prefix; BM25 sees that same prefix.
Validate returned passages/dates again. No reembedding or temporary transcripts.

QMD cannot independently set per-method depth through its public search API.
A small discovery adapter retains its tokenization, FTS-highlight chunk selection,
source-aware dedup and installed chunk helpers, but requests ten from the selected
backend and omits query-conditioned scoring. It does not rewrite QMD. Training and
runtime share complete-excerpt rendering, including the 1,200-character cap;
oversized matches are discarded rather than truncated.

Historical retrieval honors configured session chat types and each node's indexed DM policy. Time-unversioned
files and Loggie projections are excluded. This is a historical text-prefix
evaluation of the currently retained corpus, not a reconstruction of the old index:
later edits/deletions cannot be undone. Persist coverage/exclusion counts.

## Checkpoints, retries and permissions

Private database: `<state>/agents/<agent>/unblock-memory/training.sqlite` (0600).
Never commit, publish or index this file or its exports.

Source identity includes persisted node ID, agent, session and user-event sequence.
Exact inputs share recall/teacher checkpoints. V2 identities include lane, round,
feedback, prompt, and recipe version. Retrieval keys include query, source/cutoff,
corpus fingerprint, renderer and settings. Passage keys include original conversation,
as-of time, exact rendered passage/metadata, model, and shared grader version.
Unchanged judgments survive changes in queries/corpus. Selection is separately versioned.
Old v1 records may remain inert audit data; they are not reinterpreted as v2 results.

Run/generate/evaluate/export revalidate collected inputs; edits change affected
hashes, branch removals retire sources, and paid checkpoints remain intact.
Status does not rescan. V2 query progress and exports are recipe-scoped, and exports
require the active recall gate and a resolved pair.

A renewable SQLite lease serializes modifying commands. Attempts commit **before**
dispatch. Crashes, uncertain transport and malformed responses become ambiguous;
4xx/host authorization errors are definite failures. Storage errors propagate
separately. There are no automatic paid retries or model/route fallbacks.

```sh
openclaw memory-training retry-failed --agent main --id <reviewed-step-hash>
# Explicit acceptance of possible duplicate billing:
openclaw memory-training retry-failed --agent main --id <reviewed-step-hash> --include-ambiguous
```

Inspect exact cases in `status.reviews` / `status.retryable` before explicit recovery;
`--id` accepts one or more reviewed hashes. Attempts stay preserved. Retry
commands do not themselves send requests. V1 query checkpoints are not reset.
Dropping failed judgments from query averages is not a supported resolution.

The host must support isolated completion and grant
`plugins.entries.unblock-memory.llm.allowModelOverride: true` with
`allowedModels: ["openai/gpt-6-luna"]`. The operator CLI explicitly selects an
agent, so an unbound CLI runtime also requires
`plugins.entries.unblock-memory.llm.allowAgentIdOverride: true`. Preserve other
grants. The host's model catalog and selected runtime must support that exact
model with usable host-managed authentication; a model permission grant alone
does not establish model availability. The plugin does not change its own
permissions. Credentials stay with the host, never in provenance.

## Export and consolidation

Export creates a new 0600 JSONL file and refuses overwrite. Query rows contain
exact inputs, one `{lex, vec}` target, all lane/round scores and passage references, source/time,
recall probability, corpus coverage and teacher/retrieval/judgment provenance.
Recall-gate exports include negatives. Export revalidates input sources but does
not rerun retrieval; evaluate first if a fresh corpus assessment is desired.
Export reselects targets from saved completed scores, including older v2 evaluations
excluded only for no useful evidence. It makes no new Luna/TypeSafe calls, records
the current target policy, and leaves original checkpoint/attempt records untouched.

Freeze one **recall-gate export per node after recall labeling and before selecting
successful query targets**. Reuse these same files for every preparation/evaluation
of that cohort; their hashes are recorded in the prepared manifest. Preparation
uses all completed recall-positive inputs (**>=0.7**), including examples with failed
or missing query targets. Negative recall rows are not query examples.

Transfer privately and verify hashes. Deduplicate identical training inputs while
retaining source provenance; quarantine suspected secrets. Compute train/validation
groups from the frozen cohort **before reading query labels**. Connected session and
identical-input groups stay together across nodes, including connections through
unresolved examples. A target must match its frozen source, exact input/hash, and
historical timestamp; changed/out-of-cohort targets are rejected rather than changing
the evaluation population. Use the actual
**LFM2.5-230M-Base** tokenizer and an explicit causal-LM input/target format before
fine-tuning; the byte guard is additional to the token limit. Runtime abstention remains
a separate TypeSafe gate; positive-only query training does not teach abstention.

The repository helper uses a pinned official tokenizer revision and chat template,
with assistant-only loss labels, a 32,768-token total-sequence ceiling, and deterministic
grouped splits. Targets exceeding the worker's 256-token output budget are quarantined
for review, never truncated. Reserve template/output space; config position counts do not establish
a larger supported context. The shared conversation ceiling remains 8,192 tokens:

```sh
python scripts/prepare-query-training.py /private/node1-queries.jsonl /private/node2-queries.jsonl \
  --cohort /private/node1-recall-frozen.jsonl /private/node2-recall-frozen.jsonl \
  --output /private/new-prepared-directory
```

The new private directory contains:

- `train.jsonl` / `validation.jsonl`: resolved, screened, deduplicated assistant-loss
  training rows only. Identical inputs retain the first valid target in stable export order.
- `validation-eval.jsonl`: **every safe held-out source**, not just successful teacher
  examples. Each row is `{id, input, source, splitGroup, target?}`; `input` is the raw
  prepared conversation, `source` includes node/agent/session/event identity and the
  historical millisecond `timestamp`, and `target` is omitted when unresolved or
  quarantined. Use this file for model generation/retrieval evaluation, not the
  success-filtered SFT validation file. IDs and split membership do not change when
  a missing target later succeeds.
- `cohort-splits.jsonl`: content-free source/input IDs and split assignments for the
  complete frozen cohort, including explicitly marked privacy-quarantined sources.
- `quarantine.jsonl`: affected IDs, reason codes, and original export/line references,
  never secret text. Unsafe cohort inputs are omitted from model-facing files;
  unsafe or overlong targets leave otherwise safe held-out inputs in evaluation.
- `provenance.jsonl` / `manifest.json`: source-file references, target hashes, exact
  input/cohort file hashes, split counts, and artifact hashes. Alternate labels remain
  in their original private exports rather than copying possible secrets into provenance.

Install `transformers` and `jinja2` in a separate environment first. Preparation uses
the bundled official pinned tokenizer/template offline, never model weights. Regex secret screening is not an
exhaustive privacy audit; inspect quarantine references before including those rows.

The MLX worker, prepared data, trainer/evaluator validators, and model `system.txt`
must use the same v2 contract. Ship the exact pinned tokenizer/template with the
model. Old three-query models are incompatible: switch model and runtime together.
Remove the obsolete `memoryWhisperer.historyMessages` setting from existing configs;
memory now always uses the shared token/byte window. Other features' history settings
are unchanged. A configured model failure skips the hint; the separately configured
no-model direct-vector mode remains available.
Only offline dataset creation has two teacher rounds; deployed LFM generates once.
Keep the held-out evaluation cohort fixed, including unresolved target-generation
cases. No retained v1 mode or comparison is required. Actual training and deployment
remain separate operator actions.
