# unblock-qmd

OpenClaw memory plugin backed by the `@unblocklabs/qmd` fork. It keeps one warm,
in-process QMD store per agent and exposes the standard `memory_search` and
`memory_get` tools. Search uses semantic chunking v2 and QMD vsearch without a
reranker.

## Installation

From npm:

```bash
openclaw plugins install @unblocklabs/openclaw-unblock-qmd
```

Or directly from GitHub:

```bash
openclaw plugins install git:github.com/unblocklabs-ai/unblock-qmd
```

## Configuration

Select the plugin as the memory provider and list any exact Markdown files,
directories, or globs to index:

```json5
{
  plugins: {
    slots: { memory: "unblock-qmd" },
    entries: {
      "unblock-qmd": {
        config: {
          paths: [
            "MEMORY.md",
            "USER.md",
            "memory/**/*.md",
            "/absolute/shared/**/*.md",
          ],
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

Indexes live at `~/.openclaw/agents/<agentId>/unblock-qmd/index.sqlite` (or the
equivalent configured OpenClaw state directory). The first lookup builds the
index; Markdown filesystem changes queue a debounced, serialized background
refresh.

Session transcripts are intentionally out of scope for this first version.
