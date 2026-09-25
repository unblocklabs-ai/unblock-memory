# Memory training collector

Operator-only collection for **LFM2.5-230M-Base**. No scheduler, runtime recall
changes, memory writes, live-index mutation or automatic background inference.

## Recipe

1. Collect eligible historical user turns and preceding visible conversation.
2. TypeSafe `jev-1.13.0` recall probability **>=0.7** gates query generation.
   Preserve negative labels for audit; greetings do not need query targets.
3. Isolated `openai/gpt-6-luna`, **xhigh**, generates exactly **10 distinct
   single-line queries**, using the tested v3 prompt, 12,000 output-token allowance
   and 300-second deadline. No fallback model or agent tools.
4. Retrieve **10 literal vector + 10 BM25 matches** from the originating agent's
   historical sessions snapshot. Retain all unique eligible passages, with no
   merged passage-count cap.
5. TypeSafe judges each passage's additional utility for the **original
   conversation**. It receives conversation, as-of time, passage text/source/dates,
   never generated query/ID, rank, retrieval score or method.
6. Sum the **five highest** normalized passage grades; retain the top **three exact
   queries**. Ties preserve teacher order. No score cutoff, answer requirement or
   cross-query novelty rule. An empty retrieval scores zero; failures never do.

The four-level rubric distinguishes no, marginal, useful and direct high-value
additional context, requires correct identity and temporal applicability, discounts
repetition and unsupported premises, and treats all content as untrusted.
Full distributions and reported usage are persisted.

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

Optional `--max-examples` bounds new work. Run and generate default to a
3,000,000 serialized input-byte budget, **not tokens**; rerun to drain pending work.
Evaluate's optional `--max-calls` counts new retrieval operations plus uncached
passage judgments. There is no default example/call-count cap.

Recall defaults to 256 concurrent requests, generation to 8 isolated completions.
Evaluation defaults to 4 inputs with 10 parallel queries each. Distinct remote
passage judgments overlap (up to 800 memberships before dedup at default depth).
Native vector work is serialized per snapshot. Raise concurrency within machine
and provider capacity. Failures stop new dispatch; in-flight operations drain
and persist before snapshots close. Dry runs make no inference calls.

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
Keep at most 32 preceding whole messages within 24,000 serialized UTF-8 bytes;
drop oldest whole messages, never slice the latest request. Oversized requests
are skipped. Sessions above 50,000 events or 32 MB become unavailable, not deleted.

Snapshots require matching projection hashes and trusted message spans. Copy
only prefixes before the **entire second of the user's timestamp**, stopping at
unknown/future dates. Never infer dates from quoted headings. Copy existing vectors
only for complete chunks within the safe prefix; BM25 sees that same prefix.
Validate returned passages/dates again. No reembedding or temporary transcripts.

QMD cannot independently set per-method depth through its public search API.
A small discovery adapter retains its tokenization, FTS-highlight chunk selection,
source-aware dedup and installed chunk helpers, but requests ten per method and
omits query-conditioned scoring. It does not rewrite QMD. Its existing
12,000-character passage eligibility rule remains; no passage is truncated.

Honor configured session chat types and each node's DM policy. Time-unversioned
files and Loggie projections are excluded. This is a historical text-prefix
evaluation of the currently retained corpus, not a reconstruction of the old index:
later edits/deletions cannot be undone. Persist coverage/exclusion counts.

## Checkpoints, retries and permissions

Private database: `<state>/agents/<agent>/unblock-memory/training.sqlite` (0600).
Never commit, publish or index this file or its exports.

Source identity includes persisted node ID, agent, session and user-event sequence.
Exact inputs share recall/teacher checkpoints. The new teacher policy
`query-teacher-v3-xhigh` distinguishes old low-reasoning results without deleting
them. Retrieval keys include query, source/cutoff, corpus fingerprint and settings.
Passage keys include original input, as-of time, exact passage/position and full
rubric: unchanged judgments survive changes in queries/corpus. Selection is
separately versioned.

Run/generate/evaluate/export revalidate collected inputs; edits change affected
hashes, branch removals retire sources, and paid checkpoints remain intact.
Status does not rescan; stage/attempt totals include historical recipes, not just
current-cohort progress. Exports filter to the current recipe and active recall gate.

A renewable SQLite lease serializes modifying commands. Attempts commit **before**
dispatch. Crashes, uncertain transport and malformed responses become ambiguous;
4xx/host authorization errors are definite failures. Storage errors propagate
separately. There are no automatic paid retries or model/route fallbacks.

```sh
openclaw memory-training retry-failed --agent main
# Explicit acceptance of possible duplicate billing:
openclaw memory-training retry-failed --agent main --include-ambiguous
```

These reset that agent's failed checkpoints, including historical recipes, preserving
attempts. Inspect before use. They do not themselves send requests.

Explicitly authorized exclusions use `evaluate --exclude-judgment <sha256>`.
The hash is SHA256 of JSON `[judgeVersion,inputHash,passagePosition,fullJudgeRequest]`.
Exclusions persist, appear in provenance, and are omitted rather than scored zero.
No blanket failure skipping.

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
exact inputs, three targets, all query totals/passage references, source/time,
recall probability, corpus coverage and teacher/retrieval/judgment provenance.
Recall-gate exports include negatives. Export revalidates input sources but does
not rerun retrieval; evaluate first if a fresh corpus assessment is desired.

Transfer privately and verify hashes. Deduplicate identical inputs while retaining
source provenance; quarantine suspected secrets. Keep connected session and
identical-input groups together across nodes for train/validation. Use the actual
**LFM2.5-230M-Base** tokenizer and an explicit causal-LM input/target format before
fine-tuning; the interim byte limit is not a token count. Runtime abstention remains
a separate TypeSafe gate; positive-only query training does not teach abstention.

The repository helper uses a pinned official tokenizer revision and chat template,
with assistant-only loss labels, a conservative 32,768-token training ceiling
(the model config supports 128,000 positions), and deterministic grouped splits:

```sh
python scripts/prepare-query-training.py /private/node1-queries.jsonl /private/node2-queries.jsonl \
  --output /private/new-prepared-directory --cache-dir /private/tokenizer-cache
```

Install `transformers` and `jinja2` in a separate environment first. It downloads
tokenizer files only, never model weights. Regex secret screening is not an
exhaustive privacy audit; inspect quarantine references before including those rows.
