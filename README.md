# Unblock Memory

Workspace-native memory for OpenClaw, powered internally by `@unblocklabs/qmd`.
It keeps one warm QMD store per agent and exposes the standard `memory_search`
and `memory_get` tools. Search uses semantic chunking v2 and direct QMD vector
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
account and sender IDs create or refresh a disabled-by-default person record.
Incomplete Slack identities create a bounded, deduplicated todo without storing
message content. Other channels are ignored.

PeopleSQL registers three optional tools when enabled:

- `memory_people_inspect` lets an owner read one exact person or bounded actionable todos;
- `memory_people_update` changes explicit policy, company, todo, deletion, or
  restoration state; and
- `memory_people_sync` manually enriches one Slack account through OpenClaw's
  authenticated directory CLI without accepting or reading a token.

Allow the tools you intend the agent to use through OpenClaw's `tools.allow`
configuration; enabling PeopleSQL alone does not expose optional tools.

Inspection, administrative updates, and directory sync require OpenClaw's
host-derived owner authorization. Dossier replacement runs only through the plugin-owned
Codex refinement command. Soft-deleted people can be restored explicitly; restoration
leaves both policies disabled. The sync is bounded to
200 normalized directory entries per call and is safe to rerun. With pinned
OpenClaw `2026.8.1-beta.3`, the directory contract supplies ID, name, and handle;
Unblock Memory ignores raw provider payloads. Slack requires the
`users:read` scope.

For weekly dossier maintenance, schedule the plugin-owned CLI with an
operator-authored OpenClaw command automation rather than adding a plugin
scheduler:

```bash
openclaw automations create "0 4 * * 0" \
  --name "People Whisperer refinement" \
  --command-argv '["openclaw","unblock-memory","people","refine","--agent","main"]' \
  --timeout-seconds 1800 \
  --no-deliver
```

`openclaw unblock-memory people refine --agent <id>` selects a bounded candidate
batch, reads exact-sender session evidence, and invokes one
ephemeral, read-only `codex exec` with structured output. It validates the
complete result set, person IDs, dossier schema, and evidence locators before
writing each dossier transactionally.
The host running the command must already have working Codex CLI authentication.
The plugin performs no model call on the prompt-injection path.

Set both `people.whisperer.enabled` and the person's injection policy to enable
prompt context. The plugin then prepends only that exact person's stored dossier
blurb, bounded by `maxChars`, once per session. Unknown, unavailable, or
incomplete identities produce no context. This non-bundled prompt hook requires
`plugins.entries.unblock-memory.hooks.allowConversationAccess: true` and remains
subject to OpenClaw's `allowPromptInjection` policy.

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
channel and group conversations; add `direct` explicitly to include DMs. Run
`memory_sync_sessions` to start a refresh, then use `memory_sync_status` to
check its progress or result. Projections are private derived Markdown under the
agent's `unblock-memory/sessions` state directory and can be rebuilt from
OpenClaw at any time. Their embedded text contains only `# Transcript` and
timestamped speaker messages; filtering metadata remains in the session
manifest. The projected file modification time matches the session start time
for meaningful chronological cluster reads. Session results include provider,
chat type, conversation identity, and start time as an ISO 8601 timestamp. They
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
