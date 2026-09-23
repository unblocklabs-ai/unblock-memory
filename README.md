# Unblock Memory

Workspace-native memory for OpenClaw, powered internally by `@unblocklabs/qmd`.
It keeps one warm QMD store per agent and exposes `memory_search` and `memory_get`.
Ordinary recall is local vector search over semantic chunks: no query expansion,
reranker or TypeSafe key is required.

## Start here

Install once per OpenClaw host, not once per agent:

```sh
openclaw plugins install npm:@unblocklabs/unblock-memory
```

Merge this into your OpenClaw configuration, preserving other plugins/settings:

```json
{
  "plugins": {
    "slots": { "memory": "unblock-memory" },
    "entries": {
      "unblock-memory": { "enabled": true, "config": {} }
    }
  }
}
```

The default `memory` corpus contains `MEMORY.md`, `USER.md` and
`memory/**/*.md`, relative to each agent's workspace. The first use builds its
index; Markdown changes refresh it in the background. QMD is installed as a
pinned dependency, not a separate service. A global QMD CLI is not required.

Optional installation from source:
`openclaw plugins install git:github.com/unblocklabs-ai/unblock-memory`.

## What does what?

| Capability | What it does | Default / prerequisite |
| --- | --- | --- |
| [Search and reads](docs/retrieval.md#search-and-read) | Vector recall, then exact indexed source reads | Available with the memory plugin; files only unless more corpora are configured |
| [Session indexing](docs/retrieval.md#sessions) | Makes past user/assistant exchanges searchable | Opt-in corpus; channel/group by default, DMs explicitly included |
| [Skill Whisperer](docs/retrieval.md#skill-whisperer) | Suggests one relevant skill; never invokes it | Off; explicit skills corpus; TypeSafe optional |
| [Memory Whisperer](docs/retrieval.md#memory-whisperer) | Injects up to two useful historical excerpts | Off; approved corpora + TypeSafe |
| [People dossiers](docs/peoplesql.md) | Stores agent-authored, evidence-backed recognition snippets | Off; `people.enabled` |
| [People Primer](docs/peoplesql.md#optional-people-dossier-primer) | Selects evidence and reviews proposed blurbs; never generates/saves dossiers itself | Off; people + approved corpora + TypeSafe |
| [People Whisperer](docs/peoplesql.md#injection-and-person-state) | Injects a saved blurb for an exact Slack identity | Off; separate global/per-person gates; no model call |
| [Analysis and curation](docs/retrieval.md#memory-analysis) | Clusters existing vectors; agent maintains useful knowledge | Optional local analysis worker; no plugin-owned curation schedule |
| [Quality and evidence review](docs/retrieval.md#review-and-diagnostics) | Advisory ingestion/claim checks and maintenance leads | Off; feature-specific corpora + TypeSafe |
| [Response quality/sentiment](docs/response-audit.md) | Operator-only evaluation of approved Slack exchanges | Off; approved humans + TypeSafe; no memory/dossier updates |
| [Compaction memory flush](docs/configuration.md#compaction-memory-writes) | Supplies the host an append-only daily-memory write plan | Offered unless the host's memory-flush setting is false; separate from whisperers |

**Search is not one interchangeable API:** plugin `memory_search` is vector-only;
standalone QMD `query` is hybrid vector + BM25 with TypeSafe ranking.
They have separate configuration/index boundaries. See
[search modes and the xsearch migration](docs/retrieval.md#qmd-search-modes).

## Configuration and operating guides

- [Configuration](docs/configuration.md): every setting/default, feature dependencies,
  TypeSafe credentials/data scopes, host permissions and compaction.
- [Retrieval](docs/retrieval.md): search/read workflow, sessions, whisperers,
  indexing, diagnostics, clustering and curation.
- [People](docs/peoplesql.md): dossier workflow, primer/save review, injection and
  pause/delete/restore semantics.
- [Response audit](docs/response-audit.md): operator commands, cadence, sentiment,
  evidence-linked reports and their limits.
- [Memory training](docs/memory-training.md): resumable, operator-only conversation
  collection, TypeSafe recall gating, xhigh Luna queries and conversation-only grading of historical QMD hits
  for the LFM query-generator project.

The shared TypeSafe integration defaults on, but its features are opt-in.
A key activates only features already enabled. Ordinary search and People
Whisperer's injection stay local; Skill Whisperer has a local fallback.
[Provider gates and failure behavior](docs/configuration.md#feature-gates-and-fallbacks)
differ by feature.

## For agents

Use `memory_search` to locate evidence, then `memory_get` to inspect context,
attribution and dates. Follow bounded-read continuation when present. Empty search
results are not proof of absence; old memory is not current authorization.

The package includes two focused procedures:
[people-whisperer](skills/people-whisperer/SKILL.md) and
[memory-curator](skills/memory-curator/SKILL.md).
Include them in any explicit agent skill allowlist. Read their longer references
only when needed; Skill Whisperer does not install or authorize skills.

## Storage and development

Each agent has a rebuildable `index.sqlite` and durable `unblock-memory.sqlite`.
The latter holds people/dossiers/history, curation and private response audits;
sharing a file does not make audit data searchable or prompt-visible.
Read [migration, backup and rollback](docs/configuration.md#durable-database-migration)
before upgrading from the former separate databases.

Source-checkout-only fleet key tooling, when present, is documented in
`scripts/TYPESAFE-FLEET.md` and run through `scripts/typesafe-fleet.mjs`.
It is not part of the npm package; keep populated key files private.

[Release instructions](https://github.com/unblocklabs-ai/unblock-memory/blob/main/docs/RELEASE.md)
and [product direction](https://github.com/unblocklabs-ai/unblock-memory/blob/main/docs/vision.md)
are source-repository references. Planning documents describe historical or future
designs, not the installed runtime contract.
