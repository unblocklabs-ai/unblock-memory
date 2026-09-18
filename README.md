# Unblock Memory

## Response quality tracking (opt-in)

`responseAudit` evaluates bounded human-agent exchanges in the background. It is
separate from chunk-quality auditing and never changes memories or prompts. It
creates private response-review tasks, not memory-curation tasks.
Its primary purpose is tracking delivery quality over time: visible fulfillment,
deliverable fit, clear underdelivery and its observable reason. Memory gaps are only
an optional diagnostic lead, not a proxy for performance.
Only approved Slack sender IDs with trusted `senderKind: human` or owner metadata
qualify (older Slack records use unknown senderKind even for known owners).
Explicit bots, unverified identities, internal messages, other senders and thread changes form
hard boundaries. Synthetic delivery mirrors and gateway-injected answers are excluded.
Assistant progress messages are grouped with the terminal answer.
Recognized Slack envelopes are stripped even inside `upstreamUserText`; embedded
history is not treated as current human text. Ambiguous envelopes are excluded.
Removed history marks the context as limited; ordinary Markdown/JSON is preserved.
Human feedback closes when the next assistant turn starts. Still-open feedback,
no-response exchanges, incomplete/failed turns and oversized inputs are not graded.

```json
{
  "responseAudit": {
    "enabled": true,
    "sentimentEnabled": true,
    "senderIds": ["YOUR_SLACK_USER_ID"],
    "chatTypes": ["direct"],
    "historyMessages": 6,
    "lookbackDays": 30,
    "maxEpisodes": 20,
    "intervalMinutes": 60,
    "memoryCorpora": ["memory", "knowledge"]
  }
}
```

This is explicit approval to send those exchanges to TypeSafe. Sender IDs apply
across the agent's Slack accounts; use only identities approved in all such accounts.
`memoryCorpora` is optional and separately approves configured **file** corpora for
memory-gap investigation. Leave it empty to send no indexed memory evidence.
`typesafe.enabled: false` or missing credentials prevents evaluation. An interval
of zero means manual-only. Defaults are disabled, no approved senders, direct chats,
6 preceding visible messages, 30 days, 20 episodes per run and a 60-minute interval.
`sentimentEnabled` defaults to **true within that opt-in audit**; it does not bypass
approved senders or TypeSafe credentials. Set it false to omit polarity, annoyance,
frustration and intensity questions while retaining quality/repair judgments.
`intervalMinutes` controls their shared cadence; no second sentiment timer is needed.
The Gateway checks a durable per-agent due time on startup and every minute (no
agent-turn cron or separate launchd job). First enablement waits one interval;
restarts preserve the due time and an overdue schedule gets one bounded catch-up,
not one run per missed interval. Each attempt advances the due time before work,
including missing-key skips, failures or interrupted runs, to prevent retry storms.
Changing the interval recalculates the due time from the last scheduled attempt
(or initial enablement). The Gateway must be running; manual audits do not change
the automatic schedule. Missing/unreadable credentials skip all quality and sentiment
inference without failing Gateway startup or normal memory functionality.
Changing the interval does not invalidate cached results. Changing the sentiment
toggle selects a separate reporting cohort, so older missing sentiment is not
treated as neutral; unchanged quality/feedback stages are reused across the toggle.

Operator commands (not agent tools):

```sh
openclaw memory-responses audit --agent main --dry-run
openclaw memory-responses audit --agent main
openclaw memory-responses report --agent main
openclaw memory-responses report --agent main --episode EPISODE_ID
openclaw memory-responses report --agent main --sender SLACK_USER_ID --account ACCOUNT_SCOPE --bucket day --since 2026-09-01 --until 2026-10-01
openclaw memory-responses report --agent main --person PERSON_ID
openclaw memory-responses tasks --agent main
openclaw memory-responses review --agent main --id TASK_ID --status deferred --reviewer human --note "Review the linked exchanges before changing preferences"
openclaw memory-responses annotate --agent main --date 2026-09-18 --kind prompt --note "Known prompt revision deployed"
openclaw memory-responses retry-failed --agent main
```

Reports group by scoped human identity as well as task/model/time. Names are not
identity keys. Existing active people-store links are resolved read-only at assessment
time; missing links do not prevent analysis. Unknown account scopes stay isolated
per session. No new identity fields are sent to TypeSafe. Date ranges are UTC with
an inclusive start and exclusive end. `periodStart` identifies a day/week bucket;
legacy `week`/`fromWeek`/`toWeek` fields remain aliases. `--task-type` and `--model`
further narrow comparisons. Human-specific scores are not rankings of the humans:
task difficulty, feedback habits and selection bias remain important.

Session checkpoints hash bounded active source bytes; unchanged sessions skip
extraction and all inference. Changed sessions are re-extracted within the existing
budget, then stage hashes reuse unchanged quality, feedback, sentiment and later
evidence judgments. Only hashes/counts are checkpointed, never a transcript copy.
A persisted cursor rotates through discovery and tracked-session reconciliation;
`deferredByLimit` includes known backlog and a lower-bound marker for unvisited
sessions. `stages` exposes pending/failed/succeeded counts and exhausted retries
for the cohort/date range, before person filters. `retry-failed` only resets failed
work; successful stages remain cached. Source freshness is checked before activation.

Review tasks distinguish concrete delivery shortfalls from high-intensity human
experience complaints. Stable task keys include exchange, scoped human and issue
family. Decisions survive rescoring; stale source evidence and superseded findings
are labeled separately. Review status/provenance never changes the raw judgments.
Tasks and change annotations are operator-only and stay out of memory/whisperer
prompts. `--reviewer` records human/agent provenance, not authentication or a new
permission grant. Task lists disclose their 1,000-item cap. There are no automatic
dossier updates: review the evidence and approve any concrete preference separately.
Old cohorts remain stored; the first staged-cohort run does not silently import
unverified older rubric judgments. Audit-history retention is not automatic.

Two separate TypeSafe requests prevent human feedback from influencing the original
fulfillment/deliverable-fit grade. The feedback pass distinguishes acceptance,
correction, continuation, unrelated replies, expressed sentiment, repeated constraints
and avoidable rework. Current-index memory investigation runs only for a strong
memory-gap signal: lexical retrieval selects up to three whole short documents from
approved collections. This is an investigation lead, **not proof of historical
availability, factual truth, or agent fault**. Tool-call counts do not establish what
the model saw or whether it should have searched. Unseen artifacts are unassessable.

Deliverable kind/format/scope has its own assessability gate, independent of whether
execution or external facts can be verified. Feedback attribution distinguishes the
current answer, earlier behavior, delivery, missing proactive action, external events,
new work and mixed/unclear targets. A reported forgotten instruction does not prove
searchable memory existed. A third, separate request examines the original exchange,
human feedback and available next assistant block for specific reported shortfalls,
acknowledgment, explicit factual corrections, delivery failures and regressions. These are
retrospective signals, not independently verified facts and never inputs to the
original grade. Clean text preceding a synthetic error/delivery notice can be assessed
as **partial** evidence; the notice itself is excluded and no successful completion
is inferred. Later evidence is capped at six messages/12K characters; incomplete,
unsafe or oversized blocks stay explicitly pending/unavailable/oversized. New later
evidence changes the input hash; only changed assessment stages are re-evaluated,
within normal audit budgets. Successful stages survive failures in later stages.
When the next block is unavailable, the third pass uses only the original exchange
and feedback; it cannot infer a missing delivery from missing later evidence.

Code combines narrow, confident evidence into an **observed outcome**, preserving
its basis and reason. A concrete original-answer shortfall or later admission takes
precedence over praise. Broad reported failures are used only when they do not
depend on a newly introduced requirement. Accurate explanations of earlier mistakes,
ordinary follow-ups, necessary clarification and unseen work are not automatically
failures. Sentiment and earlier-workflow complaints remain separate review signals.
Sentiment includes independent annoyance and frustration yes-probabilities (both
can apply), plus an expressed-dissatisfaction intensity score from 0 to 3. Intensity
means no expressed displeasure / restrained displeasure / pointed complaint /
explicit rejection or loss of trust. It is **not confidence or failure severity**.
External frustration, brevity and factual corrections alone do not establish
annoyance or frustration; mixed praise and complaints can still carry both signals.
Weekly reports show dissatisfaction, annoyance and frustration rates, intensity
means, unknown counts and their own assessment denominators. Unassessed results
are never counted as neutral. Sentiment deltas require 20 samples in both periods
and matching assessment coverage; they remain descriptive, not causal evidence.
Outcome, evidence basis and failure reasons remain distinct: a correction does not
automatically mean `incorrect_claim`. Confident reason judgments and direct
delivery/regression admissions supply reasons; otherwise `reasonStatus` is
`uncertain`. `reasonDetails` retain each label's source and strength, distinguishing
Choice confidence from Noul yes-probability. Multiple supported reasons can coexist.
`reportVersion` identifies composition/reporting semantics independently of the
judge rubric, allowing cached judgments to be re-reported without re-inference.

Results live in the agent's private `unblock-memory/response-audit.sqlite`, outside
the memory index. It stores judgments and source event references/hashes, not copies
of conversations. Identical successful inputs are cached; source rewrites invalidate
in-scope results on the next scan. Reports partition by fixed judge/rubric/context
configuration, UTC week, task type and agent model. They expose eligible/assessed
counts, excluded cases, confidence-qualified score means with per-dimension denominators, rework rates with Wilson
intervals, and evidence IDs. Small groups (<20) are marked explicitly. Confidence
thresholds are provisional, not calibrated guarantees. Human-reviewed evaluation
data is still needed before drawing performance conclusions.
Reports include dated clear-underdelivery examples and reason counts. Descriptive
score deltas compare successive available UTC weeks within the same task type,
agent model and rubric/configuration, with at least 20 confident scores per dimension
in each period and unchanged scored coverage; changed coverage withholds the score
delta. Outcome trends show acknowledgment, reported-shortfall and unknown rates
against **all evaluated exchanges**, with at least 20 evaluated exchanges per period.
Read the three rates together: fewer acknowledgments can mean more unknowns, not
more failures. Every delta includes before/after values, sample counts, denominator
and coverage-change flags. Unknown task types/models cannot produce deltas. These
are not statistical change-point detections or proof of causality; model/version
changes remain visible as separate groups rather than silently mixing cohorts.
The legacy `observedSuccessRate` group field remains acknowledgment / known outcomes
for compatibility, but is not used for trends. Unknowns are never successes.
Coverage changes and threshold variability can move rates; acknowledgment is not
factual verification. Week buckets
may be partial, and several exchanges in one session are not independent. Wilson
intervals are descriptive, not calibrated confidence about overall agent ability.

Each run selects at most 100 recent sessions for inference, each at most 2,000 active events/2M
characters; episodes must fit 24K characters and six feedback messages without
truncating the answer. Coverage counts describe the scanned sessions; only episodes
within `lookbackDays` are judged. Caps, failures and no-feedback cases remain visible.
Saved sessions in the report window are also reconciled independently of that
selection, so removing an entire active branch retires its scores. Oversized saved
sessions defer reconciliation rather than being treated as deleted; the report
exposes `reconciledSessions` and `reconciliationDeferred`. All reconciliation shares
the run deadline. Freshness checks compare the assessed episode, not unrelated
later session activity. Actual snapshot races do not exhaust provider retries.
The whole run has a two-minute deadline, at most three provider attempts per input (ten-minute
backoff), and a cross-process lease. Scheduling never starts inference on the agent
turn path or boots a QMD manager. No model downloads or source re-indexing occur.
The report is observational: different task mixes, selective human replies and judge
changes can produce apparent trends. It does not automatically declare regressions,
rewrite prompts, or treat silence as success.

## Review and diagnostics

- `memory_diagnostics` reports credential **availability only**, per-agent process-local
  whisperer counters, projection version, old indexed-session projection count, and
  embedding readiness. Counters are bounded to 100 agents and reset on restart.
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

New optional configuration (corpora must already be configured):

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

Workspace-native memory for OpenClaw, powered internally by `@unblocklabs/qmd`.
It keeps one warm QMD store per agent and exposes the standard `memory_search`
and `memory_get` tools. Search uses semantic chunking and direct QMD vector
search without query expansion or a reranker, so only the embedding model loads.

Optional memory analysis uses those same stored vectors in the same SQLite
index. It does not re-embed memory, copy vectors, or create another database.

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

This release pins QMD 2.9.6. Projector/chunker version changes refresh derived
projections and embeddings on their next normal sync; the first sync may take
longer while re-embedding. No manual deletion of source memories or review tasks
is needed.

## Installation

From npm:

```bash
openclaw plugins install npm:@unblocklabs/unblock-memory
```

Or directly from GitHub:

```bash
openclaw plugins install git:github.com/unblocklabs-ai/unblock-memory
```

Install the plugin once on each OpenClaw host, not once per agent. It installs
its pinned `@unblocklabs/qmd` runtime dependency automatically, so QMD does not
need to be installed separately. Each agent gets its own QMD index when it first
uses memory.

## Configuration

Select the plugin as the memory provider and group exact Markdown files,
directories, or globs into named corpora:

```json5
{
  plugins: {
    slots: { memory: "unblock-memory" },
    entries: {
      "unblock-memory": {
        hooks: {
          // Required when either whisperer is enabled.
          allowConversationAccess: true,
        },
        config: {
          // Default: avoid repeated model cold starts after idle periods.
          keepEmbeddingModelWarm: true,
          corpora: [
            {
              name: "memory",
              kind: "files",
              paths: ["MEMORY.md", "USER.md", "memory/**/*.md"],
            },
            {
              name: "sessions",
              kind: "sessions",
              chatTypes: ["channel", "group"],
              maxExpandedTokens: 500,
            },
            {
              name: "knowledge",
              kind: "files",
              paths: ["knowledge/**/*.md"],
            },
            {
              name: "skills",
              kind: "skills",
              paths: [
                "skills/**/SKILL.md",
                ".agents/skills/**/SKILL.md",
                "~/.agents/skills/**/SKILL.md",
                "~/.openclaw/skills/**/SKILL.md",
                "~/.openclaw/plugin-skills/**/SKILL.md",
              ],
            },
          ],
          skillWhisperer: {
            enabled: false,
            historyMessages: 5,
            minScore: 0.5,
            cooldownTurns: 10,
          },
          typesafe: {
            enabled: true, // Default; shared by enabled Skill and Memory Whisperers.
            // Alternatively set TYPESAFE_API_KEY in the Gateway environment.
            apiKeyFile: "/absolute/path/to/.env",
            timeoutMs: 1500,
          },
          people: {
            enabled: false,
            whisperer: { enabled: false, maxChars: 1200 },
          },
          // Optional: omit unless the local analysis worker is installed.
          analysis: {
            executable: "/absolute/path/to/unblock-cluster/bin/unblock-memory-analysis",
          },
        },
      },
    },
  },
}
```

Relative entries resolve from each agent workspace. Absolute paths and `~/`
paths are supported. A directory means recursive Markdown. When `corpora` is
omitted, the plugin creates a `memory` corpus containing `MEMORY.md`, `USER.md`,
and `memory/**/*.md`. Explicit configuration must include exactly one `memory`
corpus; other unique names may be added for custom material.

`keepEmbeddingModelWarm` defaults to `true`, keeping the embedding model and
context resident after first use. Set it to `false` to restore QMD's five-minute
idle unload behavior.

`memory_search` searches every configured non-skill corpus by default. Pass
`corpora: ["knowledge"]` to search selected corpora or `corpora: ["all"]` to
request all of them explicitly. Search results include their corpus name and
remain readable by passing the returned `qmd://` path to `memory_get`.

### Memory Whisperer

Memory Whisperer is optional and **off by default**. It proactively retrieves
historical context before user-triggered turns, without changing `memory_search`
or `memory_get`. Enable it in the plugin config with an explicit corpus allowlist:

```json5
memoryWhisperer: {
  enabled: true,
  corpora: ["knowledge"], // Must exist in corpora; approve its contents for all agent audiences.
  historyMessages: 5,
  minUsefulness: 0.9,
  maxHints: 2,
  cooldownTurns: 10,
  timeoutMs: 3000,
},
```

Requires `hooks.allowConversationAccess: true` on the plugin entry, prompt
injection permission, and the shared TypeSafe credentials described below.
An empty allowlist is invalid when enabled; `all`, unknown names, and `skills`
are not accepted. File corpora are approved for **every audience using the agent**:
do not allowlist private dossiers for an agent that also serves shared channels.
If `sessions` is allowlisted, only the exact current session is searched, including
its older indexed messages. Missing session identity excludes that corpus. Other
sessions, even in the same channel, are excluded before sending excerpts to TypeSafe.
Session availability still depends on the normal indexing/sync schedule.

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

### Skill Whisperer

Skill Whisperer is an optional semantic reminder for user turns. Configure one
isolated `skills` corpus, set `skillWhisperer.enabled` to `true`, and authorize
`plugins.entries.unblock-memory.hooks.allowConversationAccess`. The feature
embeds the current prompt plus the configured number of prior user/assistant
messages, compares it with each configured skill's frontmatter `name` and
`description`. With TypeSafe enabled and a key available, the top three valid
candidates are sent to TypeSafe, without a vector-score cutoff. TypeSafe chooses
one skill or none. A "none" decision never falls back to a vector hint. Full skill
procedures do not influence routing; no skill is invoked automatically.

The shared `typesafe` configuration defaults to `enabled: true` and
`timeoutMs: 1500`. Skill and Memory Whisperers share it. Credentials come from
`typesafe.apiKey`, an absolute `typesafe.apiKeyFile`, or (when neither is set)
the Gateway's `TYPESAFE_API_KEY` environment variable. Configure at most one of
`apiKey` and `apiKeyFile`. A key file may contain just the key or dotenv entries
including `TYPESAFE_API_KEY`; it is reread each turn to support rotation. A dotenv
file is not sourced as shell code and does not change the process environment.
Missing/empty files or dotenv files without that variable count as no key;
an explicit file never falls back to an unrelated environment key. Protect key
files with owner-only permissions. Workspace `.env` files are not auto-discovered:
point `apiKeyFile` at the intended file or load the variable into the Gateway.

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

### People Whisperer

#### Optional People Dossier Primer

`memory_people_prime({ personId, agentName? })` prepares evidence for an existing person;
it does **not** generate claims, update dossiers, or inject context. With
`people.enabled: true`, opt in separately:

```json
{
  "peoplePrimer": {
    "enabled": true,
    "corpora": ["memory", "knowledge", "sessions"],
    "hitsPerQuestion": 30,
    "minScore": 0.35,
    "minUsefulness": 0.8,
    "maxEvidencePerQuestion": 3,
    "timeoutMs": 30000
  }
}
```

List only configured, approved non-skill corpora. The feature is **off by
default** and requires shared TypeSafe credentials. Disabled TypeSafe or missing/
unreadable credentials safely skip the primer; agents can still research normally.
Enabling it approves sending the person's identity, retrieved excerpts and optional
draft snippet to TypeSafe. Existing dossiers are not sent as grading evidence.
Sessions includes all indexed conversations;
results are available to the agent's tool callers, so scope approval accordingly.

Three default questions cover explicit role/organization, enduring organizational
background, and the person's relationship to the agent (not its business mission).
Preferences, working styles, priorities, feedback and task history are excluded.
Each uses QMD vector search (no query expansion) for up to 30 hits, configurable
up to 40. All unique eligible hits above the vector threshold are graded, not just
the final top three. Complete excerpts over 6,000 characters are counted and skipped,
not silently truncated. Duplicate source spans across questions share a request;
Independent attribution, explicit-background, durability, recognition-value and
question-usefulness judgments run together; every dimension must pass the threshold.
Every candidate is graded against all three questions, regardless of which search
found it. Mixed excerpts may supply a useful background fact without making their
surrounding behavioral content eligible for the snippet.
Provider concurrency is four, with a two-minute overall tool deadline.

Supply the agent's human-facing name when no identity name is configured; otherwise
questions use "the assistant", never an internal routing ID such as `main`.
The output includes a deduplicated source-linked excerpt list referenced by each
question's evidence IDs, a bounded uncertain-review shortlist,
and retrieval/cache/failure counts. Coverage is `evidence_found`, `uncertain` or
`unknown`, not a claim that a question has been definitively answered. Partial
provider failures are explicit; absence of selected hits does not prove absence of
evidence. The agent must verify dates, speakers and contradictions before writing.
Memory evidence never grants permissions or establishes that an old request is
still open.

`memory_people_update({ action: "replace_dossier", personId, dossier, reason,
agentName? })` automatically checks the proposed blurb before saving. Exact
`qmd://path#Lstart-Lend` claim evidence locators supply up to three indexed ranges
from the primer's approved corpora (120 lines each, 6,000 characters total).
Support confidence and background-only/explicit-support probabilities must all
be >=0.9. `needs_review` or `review_unavailable` leaves the dossier and history
unchanged; missing keys and failures never count as approval. A concurrent dossier
edit/deletion returns `conflict` instead of overwriting the newer change.

After independently verifying every assertion and background eligibility, an agent
can supply a source-specific `manualVerification` explanation (up to 400 characters)
for direct human corrections, non-indexed evidence or disabled/unavailable/incorrect
reviews. This explicit path skips TypeSafe, records manual provenance in change
history and keeps all structural limits. It is not a provider pass. Normal success
returns `status: "ok"`, `saved: true` and `verification: "typesafe" | "manual"`.
The skill documents when to use each path. Sources outside approved corpora are
rejected before egress; no separate `evidenceReview` toggle is needed.

For optional read-only diagnostics, `memory_people_prime({ personId, agentName?,
draft: { blurb, citations: [{ path, from, lines }] } })` still reviews a snippet
without writing. Agents do not need this extra call in the normal update workflow.

Judgments are cached privately in `people.sqlite` (maximum 2,000 entries), keyed
by person, agent, exact evidence/context, questions,
and judge version. No source text or credentials are stored in the cache.
Retrieval reruns against the current index; unchanged judgments are reused.
This is on-demand preparation, not a new scheduler or incremental session scanner.
Use it from an existing People Whisperer maintenance cron. Refresh stale session
indexes with `memory_sync_sessions` before priming when needed.

#### People store and maintenance

PeopleSQL is an optional agent-local people store. When `people.enabled` is
true, incoming Slack messages with a canonical agent session key and exact
account and sender IDs create or refresh an injection-enabled person record.
Incomplete Slack identities create a bounded, deduplicated todo without storing
message content. Other channels are ignored.

PeopleSQL registers these tools when enabled:

- `memory_people_inspect` lists active people, reads one exact person, reads one
  person's dossier change history, or lists bounded actionable todos;
- `memory_people_update` replaces or deletes dossiers, toggles one person's
  injection, and manages company, todo, deletion, or restoration state;
- `memory_people_prime` prepares evidence when the separately opted-in primer is
  enabled, otherwise returns disabled; and
- the optional `memory_people_sync` enriches one active OpenClaw Slack account;
  its tool input accepts an account ID, not a token.

The inspect and update tools are part of the normal agent tool surface; they do
not depend on sender-owner authorization. Directory sync remains optional and
may need to be allowed explicitly. The sync is bounded to
200 normalized directory entries per call and is safe to rerun. Unblock Memory
keeps only normalized ID, name, handle, and avatar fields. Slack requires the
`users:read` scope.

The agent owns dossier generation and refresh. It can list people, inspect one
person's current dossier, search ordinary memory and sessions with
`memory_search`/`memory_get`, and replace the dossier when that would improve a
future conversation. The plugin owns no dossier-maintenance workflow or refresh
schedule. A dossier's `reviewedAt` value records its last successful write; it
is not scheduling state. Dossier generation belongs to the agent; prompt injection
performs no model call. The optional primer grades evidence and reviews draft snippets.
The goal is recognition, not a behavioral profile: one short paragraph of at most
70 words identifying the person and their enduring organization/agent relationship.
New writes allow only `role`/`relationship` sections and explicit `observed`/`reported`
claims; priorities, preferences and inferred profiles belong outside dossiers.
Legacy dossiers remain readable, but must be deliberately rewritten by the agent
before replacement. No automatic destructive migration or blanket deletion occurs.

Every `replace_dossier` and `delete_dossier` action requires a concise `reason`
(up to 500 characters for replacements, 1,000 for deletions). Replacement history
also records whether TypeSafe checks passed or a manual attestation was used.
The plugin transactionally records that reason with its authoritative before and
after dossier snapshots. List small newest-first summaries with
`memory_people_inspect({ view: "dossier_changes", personId, limit?, offset? })`,
then fetch one exact diff with
`memory_people_inspect({ view: "dossier_change", personId, changeId })`. List
responses include `nextOffset`, so all history remains reachable without loading
many dossiers into one tool result. Because the injected snippet is the dossier's
`blurb`, its changes are included in the same history. A complete new serialized
dossier is capped at 64 KiB; larger legacy dossiers remain readable and repairable.

Set `people.whisperer.enabled` to inject context. For each exact Slack sender,
the plugin prepends that person's stored dossier blurb, bounded by `maxChars`,
once per `(Slack thread, person)`. Receipts are durable across retries and
Gateway restarts, while different people in one thread are handled independently.
Unthreaded DMs use their OpenClaw session as the conversational scope. Unknown,
unavailable, disabled, or dossierless people produce no context. Injection
remains subject to OpenClaw's `allowPromptInjection` policy.

The package includes a `$people-whisperer` skill with the canonical agent
procedure and dossier shape. For a manual refresh, ask:

```text
Use $people-whisperer to maintain this person's brief background snippet.
```

For an optional cron or isolated agent session, use this goal:

```text
Use $people-whisperer to maintain brief background snippets for people you interact
with. Follow the packaged skill, including source verification and write results.
Update only when useful; several people or nobody is fine. Report changes and gaps.
```

Choose any cadence appropriate for the agent; the plugin does not require or
track one. If session transcripts are a source, configure a `sessions` corpus
(including `direct` when DMs matter) and refresh it with
`memory_sync_sessions`. Ordinary `memory_search` calls accept targeted queries,
corpora, session metadata filters, score thresholds, and up to 20 results per
call; People Whisperer itself imposes no evidence-window limit.

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
automatically refreshes each configured agent's sessions every 15 minutes while
the Gateway runs. Set `syncIntervalMinutes` on the `sessions` corpus to an integer
from `1` to `1440`, or `0` for manual-only syncing. For example:

```json
{ "name": "sessions", "kind": "sessions", "syncIntervalMinutes": 15 }
```

The first refresh runs after one interval, not during startup. Restart the
Gateway after changing the interval. Refreshes are incremental; an already-running
sync is skipped, and failures are visible through `memory_sync_status` and retried
at the next interval. `memory_sync_sessions` still provides an immediate manual
refresh. Syncing and embedding run inside the Gateway process, without an LLM turn.

Indexes live at `~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite` (or the
equivalent configured OpenClaw state directory). Durable agent-supplied event
dates and maintenance proposals live separately in `curation.sqlite`, so a QMD
index rebuild does not discard them. The first lookup builds the index;
Markdown filesystem changes queue a debounced, serialized background refresh.

## Memory quality audit

`memory_audit_quality` is an on-demand, source-read-only audit. TypeSafe flags likely
ingestion noise for agent investigation; it never deletes, rewrites, or suppresses
memory. Enable it with explicit approval for the corpora sent to TypeSafe:

```json5
qualityAudit: {
  enabled: true,
  corpora: ["memory", "knowledge"], // Must be configured non-skill corpora.
  minNoise: 0.8,
},
```

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
