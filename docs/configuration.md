# Configuration

[Overview](../README.md) · [Retrieval](retrieval.md) · [People](peoplesql.md) · [Response audit](response-audit.md)

All plugin settings below belong under
`plugins.entries.unblock-memory.config`, not at the top level of OpenClaw.
Unknown keys are rejected. Restart/reload the Gateway after changing plugin
settings; a rotated credential file is reread without a restart.

## Feature gates and fallbacks

| Feature | Required settings/dependencies | TypeSafe disabled / no key | Provider or unreadable-key failure |
| --- | --- | --- | --- |
| Ordinary search/get | Installed/enabled memory slot; configured corpora | Unchanged local retrieval | Unchanged; its own indexing/embedding errors still matter |
| Skill Whisperer | `skillWhisperer.enabled`, skills corpus, host hooks | Best local vector candidate meeting `minScore` | Exclude failed candidates; successful siblings may qualify; no vector fallback |
| Memory Whisperer | `memoryWhisperer.enabled`, explicit approved corpora, host hooks | No hints | Exclude failed candidates; recall/deadline failures still suppress the turn |
| Complementary hints | Enabled Memory Whisperer + `complementaryHints` | No additional judgment; base hints also require a key | Keep baseline hints unless the total deadline expires |
| People store/tools | `people.enabled` | Available; automatic save review needs primer/key or verified manual alternative | Storage/inspection still available |
| People Whisperer | People + `people.whisperer.enabled`, host hooks, eligible person/dossier, no prior thread receipt | Unchanged local lookup | Unchanged local lookup |
| People Primer / automatic dossier save review | People + `peoplePrimer.enabled`, approved corpora | No judgment; save requires source-specific manual verification | No automatic save; verify/retry instead |
| Quality audit / cluster review | `qualityAudit.enabled`, approved corpora; cluster review also needs fresh analysis | No judgment | Unavailable/partial; preserve evidence and retry as documented |
| Ordinary claim review | `evidenceReview.enabled`, approved corpora | No judgment | Unavailable; no claim verified |
| Response quality/sentiment | `responseAudit.enabled`, approved humans/chat types | No inference | Unavailable; successful assessment stages stay cached |
| Clustering | Configured local `analysis.executable` | Unchanged | Unchanged; worker failures do not disable ordinary search |

Whisperers, people storage, the primer and audits default off. `typesafe.enabled` defaults true but does not
enable any feature; `sentimentEnabled` defaults true only **within an enabled
response audit**. `peoplePrimer` controls automatic dossier-save review;
`evidenceReview` is a different advisory tool. Disabling people injection does
not disable people tools/storage or erase dossiers.

## Shared TypeSafe credentials

All plugin TypeSafe features use `plugins.entries.unblock-memory.config.typesafe`:

Candidate scoring uses **one HTTP request per candidate**, with ranking done in code.
Related questions about the same candidate can share a request (for example, quality
noise and evidence). Memory Whisperer launches all eligible candidate requests together;
the shared account's request/token limits still apply across simultaneous conversations
and nodes. There is no automatic retry in the latency-sensitive whisperers.

Not every judgment is reranking: claim verification retains the cited sources for
one claim, response auditing grades one episode, and redundancy compares one pair.
These evidence relationships are deliberately preserved, not split into unrelated scores.

```json
{
  "typesafe": {
    "enabled": true,
    "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-typesafe.env",
    "timeoutMs": 1500
  }
}
```

This is a **plugin config fragment**, not a top-level OpenClaw configuration.
The key file can contain a plaintext key or dotenv entries:

```dotenv
TYPESAFE_API_KEY="YOUR_TYPESAFE_KEY"
```

Credentials come from inline `typesafe.apiKey`, an absolute `typesafe.apiKeyFile`,
or (when neither is configured) the Gateway process's `TYPESAFE_API_KEY` environment
variable. Configure at most one of `apiKey` and `apiKeyFile`; prefer a private file
over a secret in config. Defaults are `enabled: true` and `timeoutMs: 1500`.

The file is reread when a feature resolves credentials, so replacing its contents
does not require a Gateway restart. Restart/reload the Gateway after changing the
configured path or other plugin settings. A dotenv file is not executed as shell
code and does not change the process environment. Workspace `.env` files are not
auto-discovered, and an interactive shell's exported key need not reach a managed
Gateway service.

Missing/empty files or dotenv files without `TYPESAFE_API_KEY` count as no key.
An explicit file never falls back to an unrelated environment key. Missing or
unreadable credentials do not break normal memory functionality or Gateway startup;
the feature-specific fallback/skip behavior above applies. **Unreadable files and
provider errors are not Skill Whisperer's no-key fallback:** they suppress its hint.
Use `memory_diagnostics` for credential availability; it does not verify provider
acceptance. Keep secret files mode `600`, secret directories mode `700`, and keys
out of Git, chat, shell arguments and logs.

The plugin reads only `TYPESAFE_API_KEY` from the environment. Standalone QMD also
supports `TYPESAFE_API_KEY_FILE`; these are separate credential resolvers.
`typesafe.timeoutMs` is not a universal total deadline: People Primer and dossier
save review use `peoplePrimer.timeoutMs` per request; Memory Whisperer has its
own overall budget.

## Example profiles

These are **alternative plugin config fragments**, not additive whole-host files.
Merge only the intended settings. If supplying `corpora`, preserve every desired
existing entry: the array replaces the default, and exactly one `memory` is required.
Use the README's host wrapper and [host controls](#host-controls) separately.

### Sessions, including DMs explicitly

```json
{
  "corpora": [
    { "name": "memory", "kind": "files", "paths": ["MEMORY.md", "USER.md", "memory/**/*.md"] },
    { "name": "sessions", "kind": "sessions", "chatTypes": ["channel", "group", "direct"], "syncIntervalMinutes": 60 }
  ]
}
```

Omit `direct` when DMs should not be indexed. Start `memory_sync_sessions({})`
and inspect `memory_sync_status({})` for an immediate refresh; the scheduled first
refresh waits an interval.

### Skill Whisperer, local only

```json
{
  "corpora": [
    { "name": "memory", "kind": "files", "paths": ["MEMORY.md", "USER.md", "memory/**/*.md"] },
    { "name": "skills", "kind": "skills", "paths": ["skills/**/SKILL.md", ".agents/skills/**/SKILL.md", "~/.agents/skills/**/SKILL.md", "~/.openclaw/skills/**/SKILL.md", "~/.openclaw/plugin-skills/**/SKILL.md"] }
  ],
  "typesafe": { "enabled": false },
  "skillWhisperer": { "enabled": true }
}
```

Select only desired skill locations. To use TypeSafe selection instead, enable
`typesafe` and configure credentials; the selected skill still is not auto-invoked.

### Memory Whisperer over approved knowledge

```json
{
  "corpora": [
    { "name": "memory", "kind": "files", "paths": ["MEMORY.md", "USER.md", "memory/**/*.md"] },
    { "name": "knowledge", "kind": "files", "paths": ["knowledge/**/*.md"] }
  ],
  "typesafe": { "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-typesafe.env" },
  "memoryWhisperer": { "enabled": true, "corpora": ["knowledge"] }
}
```

Create the private key file first. To recall conversation history, configure a
sessions corpus and add `sessions` to `memoryWhisperer.corpora`. Automatic recall
can then retrieve across this agent's indexed sessions. The sessions corpus's
`chatTypes` setting controls whether direct messages are included. Selected
excerpts are sent to TypeSafe and may be injected into any conversation using this agent.

### People storage, without injection

```json
{ "people": { "enabled": true, "whisperer": { "enabled": false } } }
```

### People injection and optional evidence primer

```json
{
  "people": { "enabled": true, "whisperer": { "enabled": true } },
  "peoplePrimer": { "enabled": true, "corpora": ["memory"] },
  "typesafe": { "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-typesafe.env" }
}
```

The default memory corpus exists. This separately approves its evidence for
TypeSafe; it does not create a dossier or schedule maintenance. Use the
[people workflow](peoplesql.md). Adding `sessions` to primer approval, after
configuring that corpus, approves **all indexed sessions**, as with Memory Whisperer.

### Optional analysis worker

```json
{ "analysis": { "executable": "/absolute/path/to/unblock-cluster/bin/unblock-memory-analysis" } }
```

Set this only after [installing the worker](retrieval.md#memory-analysis). No
clustering or curation schedule is created. Response-audit setup and a dry-run-first
workflow are in [its own guide](response-audit.md).

## Settings reference

The tables show resolved defaults. For source-specific entries,
`corpora[sessions]` means the array entry with `name: "sessions"`, not a literal
configuration key. The manifest schema and config resolvers are the machine
contract; these tables explain their effects.

## Sources and base runtime

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `corpora` | One files corpus `memory`: `MEMORY.md`, `USER.md`, `memory/**/*.md` | Explicit array replaces defaults; must contain exactly one `memory`; `all` is a search selector, not a corpus name |
| `corpora[].name` | Required for explicit entries | Unique name; `sessions` and `skills` reserved for corresponding kinds |
| `corpora[].kind` | Required for explicit entries | `files`, `sessions`, or `skills` |
| `corpora[].paths` | Required for files/skills | Nonempty exact-file/directory/glob list; workspace-relative, absolute or `~/`; directory means recursive Markdown; does not grant host write trust |
| `corpora[sessions].chatTypes` | `['channel','group']` | Nonempty subset of channel/group/direct; DMs require `direct` |
| `corpora[sessions].maxExpandedTokens` | `500` | 1–10,000; use full turn/message when it fits, otherwise preserve full matched chunk; not a total result-size hard cap |
| `corpora[sessions].syncIntervalMinutes` | `60` | 0–1,440; zero manual-only; first scheduled sync after one interval; requires running Gateway |
| `keepEmbeddingModelWarm` | `true` | Retain embedding model/context after first use; false allows five-minute idle disposal |
| `analysis.executable` | Unset | Optional absolute local worker path; enables ability to recluster, not automatic scheduling |

## TypeSafe and whisperers

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `typesafe.enabled` | `true` | Shared plugin provider gate; no feature is opted in merely by adding a key |
| `typesafe.apiKey` | Unset | Explicit inline key; mutually exclusive with key file; prefer file |
| `typesafe.apiKeyFile` | Unset | Absolute raw-key or dotenv file, reread at credential resolution; explicit missing file never falls back to a different key |
| `typesafe.timeoutMs` | `1500` | 1–10,000 per request for Skill/Memory Whisperer, quality/claim/cluster review and response audit; **primer and dossier save use `peoplePrimer.timeoutMs` instead** |
| `skillWhisperer.enabled` | `false` | Requires explicit skills corpus and appropriate host hook access |
| `skillWhisperer.historyMessages` | `5` | Nonnegative integer; prior visible messages used for routing |
| `skillWhisperer.minScore` | `0.5` | 0–1, **local vector fallback only**, ignored for TypeSafe shortlist admission |
| `skillWhisperer.cooldownTurns` | `10` | Nonnegative user-turn count; no fallback to weaker cooling-down alternatives |
| `memoryWhisperer.enabled` | `false` | Requires explicit approved non-skill corpora, TypeSafe key and host hooks |
| `memoryWhisperer.corpora` | `[]` | Explicit known corpus names; required nonempty when enabled; no `all` or skills |
| `memoryWhisperer.historyMessages` | `5` | 0–50, retrieval history count, not judge-history limit |
| `memoryWhisperer.minUsefulness` | `0.7` | 0–1, minimum Noul yes-probability per candidate; explicit overrides are preserved |
| `memoryWhisperer.maxHints` | `2` | 1–2 |
| `memoryWhisperer.cooldownTurns` | `10` | 0–1,000; recently injected evidence |
| `memoryWhisperer.timeoutMs` | `3000` | 1–10,000 total whisper deadline, not just the provider timeout |
| `memoryWhisperer.complementaryHints` | `false` | Optional extra redundancy judgment; does not expand retrieval or enable the feature |

No configured plugin credential means fallback to **`TYPESAFE_API_KEY` only** in
the Gateway environment. Unlike QMD's resolver, the plugin does not read a
`TYPESAFE_API_KEY_FILE` environment variable. Do not conflate these contracts.
Missing/empty key and unreadable/erroring key are different for Skill Whisperer:
the former allows vector fallback; the latter suppresses the hint.

## People

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `people.enabled` | `false` | Store, Slack identity observation, people tools; independent of injection |
| `people.whisperer.enabled` | `false` | Exact-identity prompt injection; requires people enabled |
| `people.whisperer.maxChars` | `1200` | 1–4,000; also the **stored new-dossier blurb character limit even when injection is off**; independent 70-word ceiling remains |
| `people.todos.maxOpen` | `1000` | 1–10,000; bounded open data-quality todos with overflow accounting |
| `peoplePrimer.enabled` | `false` | Requires people enabled + explicit approved corpora; controls evidence primer and automatic save review |
| `peoplePrimer.corpora` | `[]` | Explicit configured non-skill evidence approvals; sessions means all indexed sessions |
| `peoplePrimer.hitsPerQuestion` | `30` | 1–40 vector results for each of three questions, before provider grading |
| `peoplePrimer.minScore` | `0.35` | 0–1 vector admission threshold |
| `peoplePrimer.minUsefulness` | `0.8` | 0.5–1; all background eligibility dimensions must pass |
| `peoplePrimer.maxEvidencePerQuestion` | `3` | 1–10 selected evidence references per question, **not** a cap on grading work |
| `peoplePrimer.timeoutMs` | `30000` | 1–60,000 per provider request, also used for draft/save review; tool's overall limit is 120 seconds |

## Audits and advisory reviews

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `qualityAudit.enabled` | `false` | On-demand chunk-quality and sampled-cluster review |
| `qualityAudit.corpora` | `[]` | Explicit non-skill approval; nonempty when enabled; sessions means all indexed sessions |
| `qualityAudit.minNoise` | `0.8` | 0–1 threshold for model noise flags; deterministic empty/encoding indicators have separate rules |
| `evidenceReview.enabled` | `false` | Ordinary atomic-claim review tool; does not turn on dossier save review |
| `evidenceReview.corpora` | `[]` | Explicit non-skill approval; nonempty when enabled |
| `responseAudit.enabled` | `false` | Operator-only response evaluation; requires approved senders and TypeSafe |
| `responseAudit.sentimentEnabled` | `true` | Within opted-in audit; false removes emotion questions without disabling quality judgments |
| `responseAudit.senderIds` | `[]` | Up to 50 approved Slack sender IDs; nonempty when enabled; trusted human/owner metadata also required, explicit bots excluded |
| `responseAudit.chatTypes` | `['direct']` | Nonempty approved subset of direct/group/channel |
| `responseAudit.historyMessages` | `6` | 0–20 preceding visible messages |
| `responseAudit.lookbackDays` | `30` | 1–90 days |
| `responseAudit.maxEpisodes` | `20` | 1–100 per run; a run need not clear the backlog |
| `responseAudit.intervalMinutes` | `60` | 0–1,440; zero manual-only; persisted per-agent due time, bounded catch-up |
| `responseAudit.memoryCorpora` | `[]` | Optional file-only corpus approvals for current-index memory-gap investigation; separate from response transcript approval |


## Host controls

These are **outside** `plugins.entries.unblock-memory.config`:

- `plugins.slots.memory: "unblock-memory"` selects the memory owner. Installation,
  plugin enablement and any host allowlists remain separate.
- `plugins.entries.unblock-memory.hooks.allowConversationAccess` allows the
  non-bundled plugin's conversation hooks. `allowPromptInjection` controls prompt
  mutation. For whisperers, configure the plugin entry with this fragment:

```json
{
  "plugins": {
    "entries": {
      "unblock-memory": {
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true }
      }
    }
  }
}
```

Host hook timeouts may bound work independently of the plugin's internal deadline.
The flags do not enable any whisperer by themselves.

Optional `memory_people_sync` may need `tools.allow`; agent skill allowlists must
include `people-whisperer` and/or `memory-curator` when used. Indexing a skill for
routing neither authorizes nor installs it.

### Compaction memory writes

The plugin supplies OpenClaw a pre-compaction memory-flush plan unless
`agents.defaults.compaction.memoryFlush.enabled` is false. This is a
**host-triggered agent write**, not an independent plugin timer. It is separate
from session sync, all whisperers and dossier maintenance.

Its prompt writes durable information only to `memory/YYYY-MM-DD.md`, appending
if the file exists, never overwriting it or bootstrap files. When nothing merits
storage, `NO_REPLY` is appropriate. The date uses
`agents.defaults.userTimezone`, otherwise the system timezone.

Supported host settings: `enabled`, `softThresholdTokens` (default 4,000),
`forceFlushTranscriptBytes` (default 2 MiB), and optional `model`. The plugin
plan has a fixed 20,000-token reserve floor and supplies its own prompts; custom
host `memoryFlush.prompt` / `systemPrompt` are not used by this resolver.

Disable this plan with this **host config fragment**:

```json
{ "agents": { "defaults": { "compaction": { "memoryFlush": { "enabled": false } } } } }
```

Or customize its supported thresholds and date timezone:

```json
{
  "agents": {
    "defaults": {
      "userTimezone": "America/New_York",
      "compaction": {
        "memoryFlush": { "enabled": true, "softThresholdTokens": 6000, "forceFlushTranscriptBytes": "3mb" }
      }
    }
  }
}
```

### Agent and audience scope

Per-person injection state, dossier existence, availability and thread receipts
are stored state, not config switches. See [people lifecycle](peoplesql.md#injection-and-person-state).

Normal memory tools can access the agent's configured non-skill corpora. Corpus
selectors are not audience ACLs. Per-feature TypeSafe approvals constrain that
feature's remote processing, not general retrieval access. This is an agent/fleet
boundary, not multi-tenant authorization. Approve sources for the agent's audiences.

## TypeSafe data scope

| Feature | Evidence sent when explicitly enabled/approved |
| --- | --- |
| Skill selection | Bounded visible current/recent conversation + shortlisted skill names/descriptions; not skill procedures or source-path fields |
| Memory hints | Bounded visible conversation + up to 8 complete excerpts, corpus names and matched-message timestamps when available; all indexed sessions in the selected corpora are eligible, with DM inclusion controlled by `chatTypes` |
| Complementarity | Up to 4 already-qualified excerpts for pairwise redundancy checks |
| People primer | Person identity, agent name, approved retrieved excerpts and source/session metadata; all indexed sessions eligible if approved, not just the current chat |
| Dossier save/draft review | Proposed blurb, person/agent names and 1–3 exact approved indexed evidence ranges, at most 6,000 characters total; existing dossier is not evidence |
| Chunk quality | Up to 4 complete chunks of at most 6,000 characters each per request + source kinds; no conversation or source-path fields |
| Ordinary claim review | One proposed claim + up to 3 approved indexed ranges, at most 6,000 characters total |
| Cluster review | Up to 6 eligible complete sampled chunks, each at most 2,000 characters; conclusions only concern the sample |
| Response audit | Approved visible request/answer/context/feedback and bounded later response evidence, separated by assessment stage; optional current-index whole-short-document evidence from approved file corpora |
| Standalone QMD query | Query, optional intent, selected excerpts, source paths and evaluation time; separate process/SDK credentials and collection scope |

Omitting tool-result/thinking/system fields does not remove their content if it
was quoted in ordinary visible text. Provider judgments are advisory; probability
or score is not proof. Enabling a feature approves only that feature's documented processing.


## Storage, upgrades and recovery

Each agent's state lives under the configured OpenClaw state directory, normally
`~/.openclaw/agents/<agentId>/unblock-memory/`. `index.sqlite` is rebuildable;
`unblock-memory.sqlite` holds durable people, curation and response-audit state.
Disabling a feature does not delete its data.

### Durable database migration

Each agent has two active plugin databases: rebuildable `index.sqlite` and durable
`unblock-memory.sqlite`. The latter uses WAL, private permissions and component
schema versions. Store modules and tool access remain separate: consolidating files
does not expose operator response audits to memory searches or whisperers.

When upgrading from separate `curation.sqlite`, `people.sqlite` and
`response-audit.sqlite` files, **stop the Gateway and any plugin CLI writers first**.
On first durable-store access, the plugin imports all existing files, even for
disabled features, in one transaction. It includes committed WAL data, verifies
row counts/values and foreign keys, and records completion. Missing stores are
normal; unsupported or invalid data aborts the import without a partial cutover.
Restarting retries an incomplete import. QMD and transcript databases are untouched.

The old files remain untouched as **inert recovery copies**, not active stores.
Completed migration never reimports them or writes to them. Do not run old and new
plugin versions together: old writers can continue changing their separate files.
Back up the new database with SQLite's online backup API (or with all writers
stopped and WAL safely checkpointed); copying only a live `.sqlite` file is unsafe.

To roll back before any new writes, stop all writers, preserve the new database and
its WAL/SHM sidecars, and restore the old plugin against the retained legacy files.
**After new writes, those files are stale**: an old-version rollback requires an
explicit reverse data migration or accepting the loss of post-upgrade changes.
Keep recovery files until the upgrade has been verified; cleanup is a separate step.
