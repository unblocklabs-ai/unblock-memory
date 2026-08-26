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
              name: "projects",
              kind: "files",
              paths: ["/absolute/shared/**/*.md"],
            },
            {
              name: "sessions",
              kind: "sessions",
              chatTypes: ["channel", "group"],
            },
          ],
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

`memory_search` searches every configured corpus by default. Pass
`corpora: ["projects"]` to search selected corpora or `corpora: ["all"]` to
request all of them explicitly. Search results include their corpus name and
remain readable by passing the returned `qmd://` path to `memory_get`.

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
check its progress or result. Projections are private derived Markdown
under the agent's `unblock-memory/sessions` state directory and can be rebuilt
from OpenClaw at any time. Session results include provider, chat type,
conversation identity, and start time as an ISO 8601 timestamp. They participate
in the same search and clustering index as file memory. This phase does not sync
sessions at startup or on a schedule; refreshes are manual through
`memory_sync_sessions`.

Indexes live at `~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite` (or the
equivalent configured OpenClaw state directory). The first lookup builds the
index; Markdown filesystem changes queue a debounced, serialized background
refresh.

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
`--db <the agent's known index path>` and, when requested, a validated
`--config-json <clustering options>` payload. Agents cannot choose a database,
executable, shell command, or arbitrary arguments.

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
- `memory_fetch_cluster` to return up to `topK` representative QMD chunks for a
  short `clusterId` returned by `memory_list_clusters`

`memory_recluster` optionally accepts UMAP controls (`method`, components,
neighbors, and minimum distance), HDBSCAN controls (minimum cluster size,
minimum samples, selection method and epsilon, and single-cluster behavior),
and a deterministic seed. Omitting them uses the worker's defaults.

Cluster reads return at most 50 members. Member excerpts are capped at 2 KB
each and 12 KB across a response; source aliases are capped at five per member
and 50 across a response.

If indexing changes content or vectors, the previous derived analysis is kept
and marked stale. Cluster reads include the analysis timestamp, stale timestamp,
and a hint to call `memory_recluster`; unavailable chunks reduce `availableSize`
without copying canonical text into analysis tables. A no-op sync stays fresh.
A failed rebuild leaves the stale result intact, while a successful rebuild
atomically replaces it. Analysis is never scheduled automatically. If the worker
is absent or fails, `memory_search` and `memory_get` continue to work.

Existing `unblock-qmd` indexes are derived caches and may be left in place;
Unblock Memory rebuilds its own index from configured corpora.
