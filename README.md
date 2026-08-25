# Unblock Memory

Workspace-native memory for OpenClaw, powered internally by `@unblocklabs/qmd`.
It keeps one warm QMD store per agent and exposes the standard `memory_search`
and `memory_get` tools. Search uses semantic chunking v2 and QMD vsearch without
a reranker.

Optional memory analysis uses those same stored vectors in the same SQLite
index. It does not re-embed memory, copy vectors, or create another database.

## Installation

From npm:

```bash
openclaw plugins install @unblocklabs/unblock-memory
```

Or directly from GitHub:

```bash
openclaw plugins install git:github.com/unblocklabs-ai/unblock-memory
```

## Configuration

Select the plugin as the memory provider and list any exact Markdown files,
directories, or globs to index:

```json5
{
  plugins: {
    slots: { memory: "unblock-memory" },
    entries: {
      "unblock-memory": {
        config: {
          paths: [
            "MEMORY.md",
            "USER.md",
            "memory/**/*.md",
            "/absolute/shared/**/*.md",
          ],
          analysis: {
            executable: "/absolute/path/to/unblock-memory-analysis",
          },
        },
      },
    },
  },
}
```

Relative entries resolve from each agent workspace. Absolute paths and `~/`
paths are supported. A directory means recursive Markdown. When `paths` is
omitted, the defaults are `MEMORY.md`, `USER.md`, and `memory/**/*.md`; an
explicit array replaces those defaults.

Indexes live at `~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite` (or the
equivalent configured OpenClaw state directory). The first lookup builds the
index; Markdown filesystem changes queue a debounced, serialized background
refresh.

## Memory analysis

Analysis is opt-in and requires the separately installed local analysis worker.
Set `analysis.executable` to its absolute path. The plugin invokes that file
directly with `--db <the agent's known index path>` and, when requested,
`--config-json <validated clustering options>`. Agents cannot choose a database,
executable, shell command, or arbitrary arguments.

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

Session transcripts are intentionally out of scope for this first version. Existing
`unblock-qmd` indexes are derived caches and may be left in place; Unblock Memory
rebuilds its new index from the configured workspace Markdown.
