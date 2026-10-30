# Unblock Memory

Long-term memory for OpenClaw agents. Unblock Memory indexes each agent's
workspace Markdown, and optionally its past conversations, so the agent can find
what it already knows with `memory_search` and check the source with `memory_get`.
Results are ranked by how useful each passage is for the question, not only by
keyword or vector similarity.

## Quick start

**Requirements:** Node.js 22+, OpenClaw 2026.8.1-beta.3 or later, and a
[TypeSafe](https://docs.typesafe.ai) API key. Search uses TypeSafe to rank results.

1. Install once per OpenClaw host, not once per agent:

   ```sh
   openclaw plugins install npm:@unblocklabs/unblock-memory
   ```

2. Save your TypeSafe key in a private file (`chmod 600`), for example
   `~/.openclaw/secrets/unblock-memory-typesafe.env`:

   ```dotenv
   TYPESAFE_API_KEY="your-key"
   ```

3. Merge this into `~/.openclaw/openclaw.json`, keeping your other settings.
   `apiKeyFile` must be an absolute path.

   ```json
   {
     "plugins": {
       "slots": { "memory": "unblock-memory" },
       "entries": {
         "unblock-memory": {
           "enabled": true,
           "config": {
             "typesafe": { "apiKeyFile": "/home/you/.openclaw/secrets/unblock-memory-typesafe.env" }
           }
         }
       }
     }
   }
   ```

4. Restart the Gateway, then ask an agent to run `memory_diagnostics`:

   ```sh
   openclaw gateway restart
   ```

   `"credential": "available"` means the key was found. It does not check that
   TypeSafe accepts the key; a test search does.

By default each agent indexes `MEMORY.md`, `USER.md` and `memory/**/*.md` in its
workspace. The index is built on first use and refreshes in the background when
those files change. QMD, the local search engine, ships inside the package, so
there is nothing else to install or run.

To install from source instead:
`openclaw plugins install git:github.com/unblocklabs-ai/unblock-memory`.

## How it works

The agent writes two queries: keywords for BM25 search and a plain-language
question for vector search. Each returns up to ten candidate passages. TypeSafe
scores how useful each complete passage is for the question, and the best ones
come back with their source location.

```json
{ "bm25Query": "staging rollout approval", "vectorQuery": "Who approved the staging rollout?" }
```

```json
{
  "results": [
    {
      "path": "qmd://source-3f9a1c2b7d4e/memory/2026-09-14.md",
      "startLine": 12,
      "endLine": 15,
      "snippet": "Priya approved the staging rollout after the load test passed.",
      "corpus": "memory",
      "score": 0.93
    }
  ]
}
```

The agent then calls `memory_get` with that `path` to read the surrounding
context, attribution and dates. Search defaults to 5 results with a usefulness
score of at least 0.7. See [search and read](docs/retrieval.md#search-and-read)
for every parameter.

**What leaves your machine:** indexing, embeddings, storage and `memory_get` run
locally. `memory_search` sends the search question and candidate passages, with
their paths and dates, to TypeSafe for scoring. Optional TypeSafe features send
only what their own settings approve; see
[TypeSafe data scope](docs/configuration.md#typesafe-data-scope).

**On by default:** search and read over the `memory` corpus, and a
[compaction memory flush](docs/configuration.md#compaction-memory-writes): before
OpenClaw compacts a long conversation, the agent is prompted to append lasting
notes to `memory/YYYY-MM-DD.md`. Turn the flush off with the host's
`agents.defaults.compaction.memoryFlush.enabled` setting.

## Optional features

Everything below is off until you configure it.

| Feature | What it does |
| --- | --- |
| [Session indexing](docs/retrieval.md#sessions) | Makes past conversations searchable. Group and channel chats by default; DMs only if you add them. |
| [Skill Whisperer](docs/retrieval.md#skill-whisperer) | Suggests one relevant skill for a user message. Never runs it. Works without TypeSafe. |
| [Memory Whisperer](docs/retrieval.md#memory-whisperer) | Adds up to two relevant past excerpts before the agent replies. Needs TypeSafe and a self-hosted query-generation API. |
| [People dossiers](docs/peoplesql.md) | Lets the agent keep a short, evidence-backed note about each person it works with. |
| [People Whisperer](docs/peoplesql.md#injection-and-person-state) | Shows the agent its note about a person once per Slack thread. Local lookup, no model call. |
| [People Primer](docs/peoplesql.md#optional-people-dossier-primer) | Gathers evidence for a person's note and reviews proposed notes before they are saved. |
| [Session memory extraction](docs/extraction.md) | Pulls lasting facts from past conversations, checks each against exact quotes, and can make them searchable. Starts in shadow mode. |
| [Clustering and curation](docs/retrieval.md#memory-analysis) | Groups related memories so the agent can spot duplicates and maintain its knowledge. Needs a local analysis worker. |
| [Quality and claim review](docs/retrieval.md#review-and-diagnostics) | Flags noisy indexed content and checks whether a claim is supported by its sources. Advisory only. |
| [Response audit](docs/response-audit.md) | Operator-only grading of reply quality and sentiment in approved Slack conversations. |
| [Inside Out](docs/configuration.md#inside-out) | Operator-only scores for six emotions in human replies, with reports. Never changes memory or prompts. |

Whisperers also need conversation-hook and prompt-injection permissions on the
plugin entry; see [host controls](docs/configuration.md#host-controls). Each
feature's requirements and failure behavior are listed in
[feature gates and fallbacks](docs/configuration.md#feature-gates-and-fallbacks).

<details>
<summary>All agent tools</summary>

| Area | Tools |
| --- | --- |
| Search and read | `memory_search`, `memory_get` |
| Sessions | `memory_sync_sessions`, `memory_sync_status` |
| Diagnostics | `memory_diagnostics` |
| Clusters | `memory_recluster`, `memory_list_clusters`, `memory_fetch_cluster` |
| Maintenance | `memory_list_maintenance_tasks`, `memory_update_maintenance_task` |
| Review | `memory_audit_quality`, `memory_review_claim`, `memory_review_cluster` |
| People (with `people.enabled`) | `memory_people_inspect`, `memory_people_update`, `memory_people_sync`, `memory_people_prime` |

</details>

## Using memory well

- Search, then read. Check context, attribution and dates with `memory_get`
  before relying on a snippet.
- Empty results do not prove something never happened. The corpus may not be
  selected, the threshold may be too high, or sessions may not have synced yet.
- Old memory is not current permission to act.
- Corpora are not access controls. Anyone who can use this agent's tools can
  search everything indexed for it, so index only what they may all see.

Two skills ship with the package:
[people-whisperer](skills/people-whisperer/SKILL.md) and
[memory-curator](skills/memory-curator/SKILL.md). Add them to any explicit agent
skill allowlist.

## Documentation

- [Configuration](docs/configuration.md): every setting and default,
  credentials, host permissions, storage and upgrades.
- [Retrieval](docs/retrieval.md): search and read, sessions, whisperers,
  diagnostics, clustering and curation.
- [People](docs/peoplesql.md): dossiers, primer, injection, and
  pause/delete/restore.
- [Session extraction](docs/extraction.md): shadow mode, backfill, thresholds
  and publishing facts to search.
- [Response audit](docs/response-audit.md): operator commands, cadence and
  reports.
- [Memory training](docs/memory-training.md): operator-only collection of
  training data for Memory Whisperer's query model.

[Vision](https://github.com/unblocklabs-ai/unblock-memory/blob/main/docs/vision.md)
describes where the project is headed. Documents in `docs/planning/` are
historical or future designs, not current behavior.

## Storage

Each agent's state lives under `~/.openclaw/agents/<agentId>/unblock-memory/`:

- `index.sqlite`: the search index. Safe to delete; it rebuilds.
- `unblock-memory.sqlite`: people, dossiers, curation and audit history. Back
  this up.

Upgrading from a version with separate `people.sqlite`, `curation.sqlite` or
`response-audit.sqlite` files? Stop the Gateway and read
[migration, backup and rollback](docs/configuration.md#durable-database-migration)
first.

## Development

```sh
npm install
npm run build
npm test            # Node and Python 3 tests
npm run preflight   # full pre-release check
```

Releases publish to npm from GitHub Releases; see
[RELEASE.md](https://github.com/unblocklabs-ai/unblock-memory/blob/main/docs/RELEASE.md).
Fleet TypeSafe key tooling for source checkouts is described in
[TYPESAFE-FLEET.md](https://github.com/unblocklabs-ai/unblock-memory/blob/main/scripts/TYPESAFE-FLEET.md);
keep populated key files private.

## License

[MIT](https://github.com/unblocklabs-ai/unblock-memory/blob/main/LICENSE)
