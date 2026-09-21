# Retrieval, whisperers and maintenance

[Overview](../README.md) · [Configuration and credentials](configuration.md)

## Search and read

`memory_search` searches every configured **non-skill** corpus for this agent by
default. Select named corpora, or use `["all"]` alone. An empty list or unknown
name is an error. Default: **5 results**, vector `minScore: 0.3`; configurable
`maxResults` is 1–20 and `minScore` is 0–1. No TypeSafe, BM25, query expansion
or reranker runs in this tool.

Example tool input (the `memory` corpus exists by default):

```json
{ "query": "Who approved the staging rollout?", "corpora": ["memory"], "maxResults": 5 }
```

Results carry `path`, `startLine`, `endLine`, `snippet`, `score`, `corpus`
and citation data; session hits also carry session metadata. Vector similarity
is a retrieval signal, not confidence in the truth of a claim.

Read the **returned** path, substituting its actual source/line values:

```json
{ "path": "qmd://source-RETURNED_ID/memory/example.md", "from": 12, "lines": 40 }
```

`memory_get` reads the indexed snapshot, not arbitrary filesystem paths or QMD
docids. It accepts exact configured `qmd://` paths, excludes skills, defaults to
120 lines and bounds content to 12,000 characters. `from` is 1-based; requested
`lines` is 1–1,000. `status: "ok"` can still have `truncated: true`: use
`nextFrom` to continue when present. A single oversized line can be clipped
without a continuation line; inspect the authorized original source if that
complete line matters. `not_found` and `unavailable` are not successful empty reads.

Search snippets are leads. Inspect attribution, qualifications, dates and adjacent
context before relying on a factual claim. An old plan is not proof it happened,
and memory does not grant permission to act. No results may mean the wrong corpus,
a high threshold, an unsynced session or an unavailable index—not absence of the fact.
Search initialization errors include an `error` alongside empty `results`;
other failures may surface as tool errors. Investigate them instead of reporting
“nothing is remembered.”

Corpora and session filters select evidence; they are not audience ACLs. Normal
tools can access this agent's configured non-skill corpora, not just its current
chat. Only index material suitable for the agent's tool callers. Per-feature
TypeSafe allowlists do not restrict ordinary retrieval.

## QMD search modes

The following describes QMD's TypeSafe-ranked `query` API (2.10+). Use the exact
dependency in the installed plugin's package metadata when diagnosing an older
installation.

| Surface | Retrieval/ranking | Score / useful distinction |
| --- | --- | --- |
| Plugin `memory_search` | Direct vector search, expansion off | Vector similarity; ordinary agent recall |
| QMD CLI `search` / SDK `searchLex` | Local BM25 | Normalized lexical relevance; useful for names, identifiers and exact phrases |
| QMD CLI/SDK `vsearch` | Local vectors; standalone default includes local query expansion | Vector similarity; `--no-expand` / `expand:false` selects literal retrieval |
| QMD CLI/MCP `query` / SDK `search` | Literal vectors + BM25, deduplicated source excerpts, independent TypeSafe usefulness ranking | Usefulness divided by 3, not cosine similarity; default limit 10/minScore 0 |
| QMD `query --no-rerank` / SDK/MCP `rerank:false` | Local retrieval, best reciprocal retrieval-rank ordering | 1 / rank; explicitly skips remote scoring |

Plain `query` takes `ceil(1.5 × limit)` candidates per backend, without local
expansion or local reranking. Explicit `lex`/`vec`/`hyde` variants share the
TypeSafe ranking policy by default. A supplied hypothetical `hyde` passage is
a retrieval input, not evidence. Scores across modes are not interchangeable.

**Migration:** Memory 0.3.22 removed the temporary `memory_xsearch` tool. QMD's
`query` provides that hybrid retrieval/ranking functionality; there is no plugin
`memory_query`, and `memory_search` did not become hybrid.

Standalone QMD is a separate entry point. Its project/named/global index is not
automatically this agent's `unblock-memory/index.sqlite`. Plugin corpus names
also are not QMD collection IDs: each configured path maps to a `source-<hash>`
collection, and a corpus can contain several. Establish the intended index,
collection scope and installed QMD version before using CLI/MCP as an alternative.
Do not run standalone collection/update/embed maintenance against a live
plugin-managed index as a casual search fallback.

QMD CLI/MCP read `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` from their own
process; SDK callers can supply credentials. Plugin `typesafe.apiKeyFile` does
not export a key to those processes. Ranked query sends the query, intent,
selected excerpts, source paths and evaluation time to TypeSafe. Missing keys or
scoring failures return errors, not vector fallback or a successful empty answer.
Use an explicitly local mode when appropriate.

See the [QMD guide](https://github.com/unblocklabs-ai/qmd#readme) for CLI/MCP syntax.
Private skill frontmatter retrieval and response-audit lexical investigations are
internal workflows, not extra public plugin search modes.

## Sessions

Add a `sessions` entry alongside `memory` in your configured corpora (see the
[session profile](configuration.md#example-profiles)). Start a manual refresh with
`memory_sync_sessions({})`, then poll `memory_sync_status({})` until completed
or failed. `started` / `already_running` only acknowledge background work.
Check completion counts, including per-session failures, before assuming freshness.

Use `sessionFilter` to restrict session results by metadata while leaving file
corpora searchable. Supported fields are `startedFrom` and `startedTo`
(inclusive ISO 8601 timestamps), `provider`, `chatType`, `accountId`, and
`conversationId`:

```json
{
  "query": "deployment decision",
  "sessionFilter": {
    "startedFrom": "2026-08-01T00:00:00Z",
    "provider": "slack",
    "chatType": "channel"
  }
}
```

Provider matching is case-normalized; `chatType` uses the lowercase values
shown in the configuration example. Account and conversation IDs are trimmed
and matched exactly. When only `sessions` is selected and no sessions match,
search returns no results. With other corpora selected, their results remain
eligible.

The date bounds are inclusive **session start times**, not dates of messages or
claims. A matching session may contain much older facts. These metadata filters
do not change the selected file corpora or authorize disclosure to another audience.

The optional `sessions` corpus reads the current agent's normal OpenClaw SQLite
store and indexes its active user/assistant transcript branch. It defaults to
channel and group conversations; add `direct` explicitly to include DMs. A
session vector hit expands to its complete user/assistant turn when the turn
fits `maxExpandedTokens`, or to its complete enclosing message when only that
fits. The default is `500`; the original semantic chunk is preserved when
neither complete context fits, so expansion never clips the matched evidence.
Run
`memory_sync_sessions` to start a refresh, then use `memory_sync_status` to
check its progress or result. The read-only adapter explicitly supports OpenClaw
agent database schemas 17, 18, and 19 and validates its required columns before
reading. Projections are private derived Markdown under the
agent's `unblock-memory/sessions` state directory and can be rebuilt from
OpenClaw at any time. Their embedded text contains only `# Transcript` and
role-labeled, timestamped speaker messages; filtering metadata remains in the
session manifest. The projected file modification time matches the session
start time for meaningful chronological cluster reads. Session results include
provider, chat type, conversation identity, and start time as an ISO 8601 timestamp. They
participate in the same search and clustering index as file memory. The plugin
automatically checks each configured agent's sessions every 60 minutes while
the Gateway runs. Set `syncIntervalMinutes` on the `sessions` corpus to an integer
from `1` to `1440`, or `0` for manual-only syncing. For example:

```json
{ "name": "sessions", "kind": "sessions", "syncIntervalMinutes": 60 }
```

The first refresh runs after one interval, not during startup. Restart the
Gateway after changing the interval. Refreshes are incremental; an already-running
sync is skipped, and failures are visible through `memory_sync_status` and retried
at the next interval. `memory_sync_sessions` still provides an immediate manual
refresh. Syncing and embedding run inside the Gateway process, without an LLM turn.

Quiet checks compare source metadata and the last successful index checkpoint
before initializing the memory manager. Unchanged sessions skip QMD updates and
embedding. New assistant answers count too, not just human messages. Changed
transcripts are projected and content-hashed; tool-only or filtered additions
that leave the indexed text unchanged also skip indexing. Empty/filtered sessions
are remembered. Index changes, missing projections, changed projection settings,
QMD upgrades and incomplete runs invalidate the skip checkpoint; `force: true`
bypasses both gates. `memory_sync_status` reports `lastCheckedAt`, `lastIndexedAt`
and `skipReason` (`no_changes` or `no_indexable_changes`) separately. Existing
explicit intervals remain unchanged on upgrade; set them to `60` for hourly checks.

Indexes live at `~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite` (or the
equivalent configured OpenClaw state directory). Durable agent-supplied event
dates, maintenance proposals, people/dossiers and response audits live separately
in `unblock-memory.sqlite`, so a QMD
index rebuild does not discard them. The first lookup builds the index;
Markdown filesystem changes queue a debounced, serialized background refresh.

### Loggie meeting interoperability

Loggie v0.1.12+ persists versioned, speaker-attributed meeting Markdown separately
from its workflow prompt. Session projection recognizes that format and also
normalizes complete legacy Loggie JSON envelopes. Unrecognized, malformed or
truncated legacy payloads keep their original text; source sessions are never
rewritten. Summaries remain labeled as generated material, distinct from speech.

QMD groups adjacent speaker blocks rather than forcing one chunk per speaker.
Search expands around the matching exchange within its existing budget. Long
monologue excerpts regain the source speaker label while citations still point
to the exact original source lines. No identity or timestamp is invented.

Within a session, identical replayed transcripts are suppressed; distinct
complete revisions with ordered source sequence numbers retain their history
and assistant follow-ups, with older versions marked superseded. Account,
workspace, meeting and external transcript identifiers scope the comparison.
Ambiguous/partial revisions are preserved. Separate session windows are not
globally deduplicated.

Use the session projection as the searchable meeting copy. Loggie raw archives
remain opt-in and should stay outside file-corpus globs (new default:
`transcripts/loggie-archive`). Memory never follows archive paths embedded in
messages. Truncated sessions stay explicitly incomplete; enabling archive
enrichment is not part of this version.

### Conservative ingestion cleanup

Session projections unwrap complete, recognized task/attachment envelopes while
keeping the actual result, task/status, filename, MIME type, and untrusted-content
label. Internal task cleanup requires structured inter-session provenance, not
just matching text. Unknown formats, malformed envelopes, and code examples stay
intact. Assistant messages and Loggie's separate projection path are unaffected.
Raw session events and workspace memory files are never rewritten.
Attachment matching has a fixed work budget; oversized or repeatedly nested/
incomplete envelopes leave the entire message unchanged rather than blocking sync.

The companion QMD semantic-chunking update skips only source-confirmed standalone
REM heading/marker spans and orphan closing fences. Reflections and useful text
remain searchable, with original source offsets. These are deterministic rules,
not TypeSafe judgments; audit flags never authorize automatic memory deletion.

The plugin installs its exact release-pinned QMD dependency (see
[package metadata](../package.json)). Projector/chunker version changes refresh derived
projections and embeddings on their next normal sync; the first sync may take
longer while re-embedding. No manual deletion of source memories or review tasks
is needed.

## Memory Whisperer

Memory Whisperer is optional and **off by default**. It proactively retrieves
historical context before user-triggered turns, without changing `memory_search`
or `memory_get`. Enable it in the plugin config with an explicit corpus allowlist:

```json
{
  "memoryWhisperer": {
    "enabled": true,
    "corpora": ["knowledge"],
    "historyMessages": 5,
    "minUsefulness": 0.9,
    "maxHints": 2,
    "cooldownTurns": 10,
    "timeoutMs": 3000
  }
}
```

Requires `hooks.allowConversationAccess: true` on the plugin entry, prompt
injection permission, and [shared TypeSafe credentials](configuration.md#shared-typesafe-credentials).
An empty allowlist is invalid when enabled; `all`, unknown names, and `skills`
are not accepted. File corpora are approved for **every audience using the agent**:
do not allowlist private dossiers for an agent that also serves shared channels.
If `sessions` is allowlisted, only the exact current session is searched, including
its older indexed messages. Missing session identity excludes that corpus. Other
sessions, even in the same channel, are excluded before sending excerpts to TypeSafe.
Session availability still depends on the normal indexing/sync schedule.

The example is a plugin config fragment; `knowledge` must already be configured.
For a complete corpus example, use the [configuration profiles](configuration.md#example-profiles).

QMD searches the current request plus the last N user/assistant messages (at most
12,000 characters), retrieving up to eight vector candidates without query expansion,
the local reranker, or a similarity-score cutoff. TypeSafe evaluates one independent
Noul question per candidate in a single request: does the excerpt add material value
beyond what the conversation already contains? Merely related, redundant,
wrong-person/project, and clearly superseded information should be rejected;
useful contradictory evidence can qualify. `minUsefulness` thresholds the probability
of yes, not a calibrated guarantee of accuracy. Evaluate it on your own conversations.

**Privacy and budgets:** this feature sends up to 16,000 characters of the available
user/assistant conversation, prioritizing the current request and recent messages,
plus up to eight 1,200-character excerpts, corpus names, and session dates to
`api.typesafe.ai`. Session excerpts retain a complete turn or message when it fits,
otherwise the complete matched chunk. Chunks exceeding the excerpt budget are
skipped, never sliced; ordinary `memory_search` is unchanged.
It does not fetch a complete historical transcript; the host may
already have compacted the available context. Truncation is marked in the judge's
input. System messages, thinking blocks, images, and tool-result messages are omitted;
anything quoted in ordinary user/assistant text can still be transmitted.

At most two qualifying excerpts are injected verbatim with source references and
historical/untrusted-data framing. Excerpts are deduplicated by normalized content
and overlapping source lines; recently injected content has a ten-user-turn cooldown
by default. Cooldown state is in memory and resets on session end or Gateway restart.
The complete hint payload is capped at 5,000 characters plus a short framing paragraph.

Unlike Skill Whisperer, **disabled TypeSafe, a missing key, no qualifying hits, or any
failure means no memory hint**—there is no vector-only fallback. The overall process
has a 3-second deadline, with the shared 1.5-second TypeSafe request deadline inside it;
neither performs retries. Timed-out or superseded runs cannot inject late hints.
Already-running local QMD work may finish in the background, but does not keep the
agent waiting beyond the deadline. No new indexing, clustering, or summarization runs
are triggered by this feature beyond the memory manager's normal initialization.

## Skill Whisperer

Skill Whisperer is an optional semantic reminder for user turns. Configure one
isolated `skills` corpus, set `skillWhisperer.enabled` to `true`, and authorize
`plugins.entries.unblock-memory.hooks.allowConversationAccess`. The feature
embeds the current prompt plus the configured number of prior user/assistant
messages, compares it with each configured skill's frontmatter `name` and
`description`. With TypeSafe enabled and a key available, the top three valid
candidates are sent to TypeSafe, without a vector-score cutoff. TypeSafe chooses
one skill or none. A "none" decision never falls back to a vector hint. Full skill
procedures do not influence routing; no skill is invoked automatically.

See [shared TypeSafe credentials](configuration.md#shared-typesafe-credentials) for key setup,
rotation and the `enabled: true` / `timeoutMs: 1500` defaults.

If TypeSafe is disabled or no key is found, selection uses the original local
vector process and `skillWhisperer.minScore`. With a key present, an API error,
invalid response, or timeout emits no hint and logs a sanitized warning; it does
not switch to vector-only selection. There are no automatic HTTP retries. Other
credential-file read errors likewise produce a warning and no hint.

**Privacy:** enabled TypeSafe selection sends up to 12,000 characters of current
prompt/recent user-assistant text, plus the shortlisted names/descriptions, to
`api.typesafe.ai`. Source-path fields, full skill procedures, tool-result messages,
and system messages are excluded; dossiers and ordinary memory files are not read
for this call. Material already quoted in user/assistant text can still be included.
Disable `typesafe.enabled` to keep Skill Whisperer entirely local. The pinned model
is `jev-1.13.0`.

The defaults use five prior messages, a vector-only score threshold of `0.5`,
and a ten-turn cooldown. A skill is cooling down after either a suggestion or a
successful direct `read` of its indexed `SKILL.md`. When the selected
skill is cooling down, no hint is emitted; Skill Whisperer does not fall through
to a weaker match. Cooldown state is per session and intentionally resets with
the Gateway. Shell-command reads are not tracked.

The `skills` corpus shares the existing QMD store and warm embedding model but
is private to Skill Whisperer: it is excluded from ordinary `memory_search`
(including `corpora: ["all"]`), `memory_get`, clustering, and memory-maintenance
tasks. Paths are explicit by design; the plugin does not reconstruct
OpenClaw's effective skill inventory from `openclaw.json`. Configured skill
globs follow symlinked directories, including OpenClaw's `plugin-skills`
directory.

## Review and diagnostics

- `memory_diagnostics` reports credential **availability only**, per-agent process-local
  whisperer counters, projection version, old indexed-session projection count, and
  embedding readiness. Counters are bounded to 100 agents and reset on restart.
  This is not a complete people/response feature-status report; it makes no TypeSafe
  request, but can initialize the memory manager/index on first use.
  No prompts, excerpts, paths, keys, or provider error bodies enter these counters.
  Parser cleanup/budget-skip counts are persisted with the latest completed
  `memory_sync_status`; unchanged sessions are not counted again. QMD structural
  omission counts cover this manager's embedding passes, not the whole corpus.
- Quality-audit groups distinguish `preserve_evidence_repair`, `inspect_scaffolding`,
  and `context_review`, reusing cached noise/evidence judgments without another call.
  Evidence-preserving repair tasks sort first. Maintenance tasks expose indexed
  fingerprint presence; `not_present_in_index` is **not** a verified repair and
  never resolves or deletes the task. Chunk boundaries may simply have changed.
- `memory_review_cluster` uses the existing `qualityAudit` opt-in/corpus allowlist.
  It judges up to three representative and three low-membership members, deduplicates
  the sample, and skips unapproved or >2,000-character chunks whole. Repeated defect
  labels are investigation leads only. Stale/changed samples are rejected; useful
  or uncertain members are retained. No tasks or sources are modified.
- `memory_review_claim` accepts one atomic claim (up to 2,000 characters) and 1–3
  citations `{path, from, lines}`. It reads approved indexed evidence itself (at
  most 6,000 characters), returns supports/contradicts/insufficient_evidence with
  confidence and source hashes, and never writes or authorizes a write. Support
  below 0.9 confidence is marked for review. This threshold is provisional, not a
  guarantee of truth; read original evidence and verify current-state claims.

Optional plugin config fragment (corpora must already be configured):

```json
{
  "evidenceReview": { "enabled": true, "corpora": ["memory", "knowledge", "sessions"] },
  "memoryWhisperer": {
    "enabled": true, "corpora": ["memory", "knowledge"], "complementaryHints": true
  }
}
```

Both additions default off. Claim review sends the proposed claim and approved
source excerpts to TypeSafe; cluster review sends approved sampled excerpts.
Complementary hints use one extra bounded call over at most four already-useful
candidates (six directional comparisons). Only redundancy probability >=0.9
removes a hint; distinct evidence and contradictions should remain. Provider errors
retain baseline hints, while the existing total turn deadline/cancellation still
suppresses late results. Missing keys or disabled TypeSafe never enable these calls.
The retrieval corpus/session boundaries are unchanged.

## Memory quality audit

`memory_audit_quality` is an on-demand, source-read-only audit. TypeSafe flags likely
ingestion noise for agent investigation; it never deletes, rewrites, or suppresses
memory. Enable it with explicit approval for the corpora sent to TypeSafe:

```json
{
  "qualityAudit": {
    "enabled": true,
    "corpora": ["memory", "knowledge"],
    "minNoise": 0.8
  }
}
```

This is a plugin config fragment; both corpora must already be configured.
Off by default. Uses the shared TypeSafe credentials and request timeout. Missing
credentials or disabled TypeSafe produces no audit. Approval includes transmission
of full eligible chunks and visibility of findings to all audiences using the agent.
Unlike Memory Whisperer, approving `sessions` includes **all indexed sessions** in
that corpus, including configured direct conversations. Only approve that when intended.

Call with `{ "limit": 10 }` (maximum 20 indexed chunk occurrences per page), then
pass the returned `next` as `after` until `done` is true. A `partial` result preserves
the completed cursor; retry there, or from the beginning if no cursor exists. This
is not a full-document audit: unindexed content is not scanned. Chunks over 6,000
characters are counted as skipped, not silently truncated. No clustering is required.

Two independent Noul questions distinguish ingestion noise from identifiable useful
evidence. High values for both can indicate valuable content trapped in a wrapper.
Low evidence alone does not create a junk finding. JSON, logs, code, terse facts,
historical records, and missing context are not automatically defects. Empty chunks
are detected locally. A JSON string that decodes to a message envelope is also
flagged as a possible double-encoding defect, even when its content is useful.
An ordinary JSON message object is not flagged from its shape alone. These are
review clues, never verdicts about whether the information should be kept.

At most four unique chunks (24,000 characters) and their source kinds are sent in
one request, without conversation context or source paths. Requests do not retry
automatically and stop starting new work after a 30-second audit deadline; existing
manager initialization/indexing may finish later. Judgments are cached in the
curation database by content, source kind, model and question version. A rescan from
the beginning reuses cached results, including after corpus/index changes. Changes
behind a page cursor are picked up on the next rescan.

Suspect chunks become `quality_review` tasks in `memory_list_maintenance_tasks`.
The audit returns page-local groups by configured source and suspected issue,
with up to three examples each, not a claim that a whole cluster is defective.
Findings include source references, bounded previews, probabilities and content
fingerprints. Reviewed tasks are not reopened for unchanged content. The curator
inspects the original source and ingestion path, proposes or performs authorized
repairs, and verifies the resulting source/index before resolving with a required
note. Prefer repairing a common extractor or inclusion rule over many symptoms;
never manually edit generated session projections. Thresholds need evaluation on
your data; model probability is not proof of a defect.

## Memory analysis

Analysis is opt-in. Core indexing, `memory_search`, and `memory_get` need only
Unblock Memory and its automatically installed QMD dependency. To enable
clustering, install the public
[`unblock-cluster`](https://github.com/unblocklabs-ai/unblock-cluster) worker once
on the same host:

```bash
git clone https://github.com/unblocklabs-ai/unblock-cluster.git
cd unblock-cluster
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-analysis.txt
```

Set `analysis.executable` to the absolute path of
`bin/unblock-memory-analysis` in that checkout. One worker installation can
serve every agent on the host. The plugin invokes it directly with
`--db <the agent's known index path>`, the plugin's non-skill collection IDs,
and, when requested, a validated `--config-json <clustering options>` payload.
Agents cannot choose a database, executable, collection, shell command, or
arbitrary arguments.

Without the worker, `memory_list_clusters` reports that memory has not been
analyzed and `memory_recluster` reports that analysis is unavailable. Ordinary
memory search and reads continue to work.

The analysis worker reads QMD's existing semantic vectors and writes only
derived results into four namespaced tables in that same `index.sqlite`:

- `memory_analysis_runs`
- `memory_analysis_clusters`
- `memory_analysis_memberships`
- `memory_analysis_duplicate_occurrences`

Unblock Memory exposes:

- `memory_list_clusters` to cheaply list current clusters and report whether the
  retained analysis is stale
- `memory_recluster` to explicitly rebuild clusters when the list is missing or stale
- `memory_fetch_cluster` to return a sorted, paginated selection of QMD chunks
  for a short `clusterId` returned by `memory_list_clusters`

`memory_recluster` optionally accepts UMAP controls (`method`, components,
neighbors, and minimum distance), HDBSCAN controls (minimum cluster size,
minimum samples, selection method and epsilon, and single-cluster behavior),
and a deterministic seed. Omitting them uses the worker's defaults.

`memory_fetch_cluster` accepts `topK` (1–50), a zero-based `offset`, and
`sort`: `representative` (the default), `score_desc`, `score_asc`, `date_desc`,
or `date_asc`. Score is cluster membership probability for normal clusters and
outlier score for noise. Each member reports raw `sourceModifiedAt` separately
from `eventTime` and `eventTimeBasis`. Session start times and dated memory paths
resolve programmatically; reviewed annotations resolve otherwise ambiguous
chunks or whole documents. Date sorting uses resolved event time when available
and the clearly labeled source modification time only as a fallback. Responses
include page totals and the next offset when more members remain.

A chronological cluster read creates a coalesced maintenance proposal only for
returned documents whose event time remains ambiguous; it does not scan the
whole corpus for chores. Persisted exact-duplicate analysis can likewise create
review proposals for non-session Markdown. `memory_list_maintenance_tasks`
returns at most ten tasks, while `memory_update_maintenance_task` can resolve,
defer, or mark one irrelevant and optionally attach a supported event date.
For duplicate proposals, defer confirmed cleanup until the source change is
complete, mark intentional repetition irrelevant, and resolve only completed
work. These tools never edit or delete source Markdown. Duplicate cleanup
remains a reviewed source change outside the maintenance tool, and generated
session projections must never be edited directly.

Member excerpts are capped at 2 KB each and 12 KB across a response; source
aliases are capped at five per member and 50 across a response. These budgets
are shared across the page so every returned member receives a useful excerpt
and at least one source path, including a full 50-member page.

If indexing changes content or vectors, the previous derived analysis is kept
and marked stale. Cluster reads include the analysis timestamp, stale timestamp,
and a hint to call `memory_recluster`; unavailable chunks reduce `availableSize`
without copying canonical text into analysis tables. A no-op sync stays fresh.
A failed rebuild leaves the stale result intact, while a successful rebuild
atomically replaces it. Analysis is never scheduled automatically. If the worker
is absent or fails, `memory_search` and `memory_get` continue to work.

## Curating knowledge

The plugin bundles the `memory-curator` skill for turning useful clusters into
durable knowledge. It becomes available when the plugin is enabled. If the
agent has an explicit skill allowlist, include `memory-curator`.

Keep maintained knowledge outside `memory/**` so each file belongs to only one
corpus. Use stable topic files updated in place:

```text
knowledge/
├── fleet.md
├── people/
│   └── rico.md
└── projects/
    └── unblock-memory.md
```

Knowledge is the agent's maintained, current understanding of its unique world:
facts such as fleet membership, local decisions and preferences, assessments,
and explicit uncertainty that would be expensive to reconstruct from scattered
history. Each claim should carry its own epistemic qualification so it remains
honest when semantic chunking retrieves it alone. Remove stale conclusions
instead of preserving history, changelogs, or `Supersedes` passages in the same
file; raw memory and sessions retain the evidence history.

Public or vendor-owned facts, generic command syntax, and behavior likely to
change with third-party releases should normally be looked up from the current
authoritative source. A local policy or deliberate divergence may belong in
knowledge, but the local decision—not copied generic documentation—is the
durable content.

For a manual run, ask the agent:

```text
Use $memory-curator to review my memory clusters and curate any durable updates.
```

For recurring curation, use an OpenClaw automation with the same thin message:

```text
Use $memory-curator to run the scheduled memory curation cycle.
```

The skill treats a cluster as an incomplete attention signal. It frames the
question raised, uses representative, score, and chronological views as useful,
searches existing knowledge and adjacent corpora, and investigates live systems,
files, documentation, or the web when those are better evidence. It then updates
a stable knowledge topic or correctly writes nothing. Its own writes are indexed
for the next cycle; it does not recluster recursively in the same run.

Existing `unblock-qmd` indexes are derived caches and may be left in place;
Unblock Memory rebuilds its own index from configured corpora.
