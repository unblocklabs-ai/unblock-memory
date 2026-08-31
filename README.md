# Unblock Memory

Workspace-native memory for OpenClaw, powered internally by `@unblocklabs/qmd`.
It keeps one warm QMD store per agent and exposes the standard `memory_search`
and `memory_get` tools. Search uses semantic chunking and direct QMD vector
search without query expansion or a reranker, so only the embedding model loads.

Optional memory analysis uses those same stored vectors in the same SQLite
index. It does not re-embed memory, copy vectors, or create another database.

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

### Skill Whisperer

Skill Whisperer is an optional semantic reminder for user turns. Configure one
isolated `skills` corpus, set `skillWhisperer.enabled` to `true`, and authorize
`plugins.entries.unblock-memory.hooks.allowConversationAccess`. The feature
embeds the current prompt plus the configured number of prior user/assistant
messages, compares it with each configured skill's frontmatter `name` and
`description`, and prepends at most one name/path hint when the best match
reaches `minScore`. Full skill procedures do not influence routing. The plugin
never opens or invokes a skill automatically.

The defaults use five prior messages, a calibrated score threshold of `0.5`,
and a ten-turn cooldown. A skill is cooling down after either a suggestion or a
successful direct `read` of its indexed `SKILL.md`. When the best qualifying
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

PeopleSQL is an optional agent-local people store. When `people.enabled` is
true, incoming Slack messages with a canonical agent session key and exact
account and sender IDs create or refresh an injection-enabled person record.
Incomplete Slack identities create a bounded, deduplicated todo without storing
message content. Other channels are ignored.

PeopleSQL registers three tools when enabled:

- `memory_people_inspect` lists active people, reads one exact person, reads one
  person's dossier change history, or lists bounded actionable todos;
- `memory_people_update` replaces or deletes dossiers, toggles one person's
  injection, and manages company, todo, deletion, or restoration state; and
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
is not scheduling state. The plugin performs no model call for dossier
maintenance or prompt injection.

Every `replace_dossier` and `delete_dossier` action requires a concise `reason`.
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
Use $people-whisperer to improve your understanding of this person. Search memory
and recent sessions, inspect their current PeopleSQL dossier, and update it only
if the result would make future conversations meaningfully better.
```

For an optional cron or isolated agent session, use this goal:

```text
Use $people-whisperer to improve your understanding of people you interact with.

Search recent sessions and memory for meaningful information about people. Inspect
their existing PeopleSQL dossiers when useful. Update a dossier only when doing so
would make future conversations meaningfully better. Ignore routine conversation,
repetition, and weak inference. You may update several people or nobody.
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
participate in the same search and clustering index as file memory. This phase
does not sync sessions at startup or on a schedule; refreshes are manual through
`memory_sync_sessions`.

Indexes live at `~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite` (or the
equivalent configured OpenClaw state directory). Durable agent-supplied event
dates and maintenance proposals live separately in `curation.sqlite`, so a QMD
index rebuild does not discard them. The first lookup builds the index;
Markdown filesystem changes queue a debounced, serialized background refresh.

## Memory analysis

Analysis is opt-in. Core indexing, `memory_search`, and `memory_get` need only
Unblock Memory and its automatically installed QMD dependency. To enable
clustering, install the
[`unblock-cluster`](https://github.com/unblocklabs-ai/unblock-cluster) worker once
on the same host:

```bash
git clone https://github.com/unblocklabs-ai/unblock-cluster.git
cd unblock-cluster
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
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
derived results into three namespaced tables in that same `index.sqlite`:

- `memory_analysis_runs`
- `memory_analysis_clusters`
- `memory_analysis_memberships`

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
