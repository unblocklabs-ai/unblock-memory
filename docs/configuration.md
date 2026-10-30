# Configuration

[Overview](../README.md) · [Retrieval](retrieval.md) · [People](peoplesql.md) · [Response audit](response-audit.md)

All plugin settings below belong under
`plugins.entries.unblock-memory.config`, not at the top level of OpenClaw.
Unknown keys are rejected. Restart/reload the Gateway after changing plugin
settings; a rotated credential file is reread without a restart.

## Feature gates and fallbacks

| Feature | Required settings/dependencies | TypeSafe disabled / no key | Provider or unreadable-key failure |
| --- | --- | --- | --- |
| `memory_search` | Installed/enabled memory slot; configured corpora; TypeSafe key | Explicit unavailable error | Successful judged siblings returned with a partial warning; total failure is an error; no vector fallback |
| `memory_get` | Installed/enabled memory slot; configured corpora | Unchanged local indexed reads | Unchanged; its own indexing errors still matter |
| Skill Whisperer | `skillWhisperer.enabled`, skills corpus, host hooks | Best local vector candidate meeting `minScore` | Exclude failed candidates; successful siblings may qualify; no vector fallback |
| Memory Whisperer | `memoryWhisperer.enabled`, explicit approved corpora, host hooks | No hints | Exclude failed candidates; recall/deadline failures still suppress the turn |
| Complementary hints | Enabled Memory Whisperer + `complementaryHints` | No additional judgment; base hints also require a key | Keep baseline hints unless the total deadline expires |
| Safety Whisperer | `safetyWhisperer.enabled`, at least one scenario, host hooks (conversation access and prompt injection) | Could not check: the turn proceeds without safety prompts (fails open) | Fails open; recorded as could-not-check, never as no match |
| People store/tools | `people.enabled` | Available; automatic save review needs primer/key or verified manual alternative | Storage/inspection still available |
| People Whisperer | People + `people.whisperer.enabled`, host hooks, eligible person/dossier, no prior thread receipt | Unchanged local lookup | Unchanged local lookup |
| People Primer / automatic dossier save review | People + `peoplePrimer.enabled`, approved corpora | No judgment; save requires source-specific manual verification | No automatic save; verify/retry instead |
| Quality audit / cluster review | `qualityAudit.enabled`, approved corpora; cluster review also needs fresh analysis | No judgment | Unavailable/partial; preserve evidence and retry as documented |
| Ordinary claim review | `evidenceReview.enabled`, approved corpora | No judgment | Unavailable; no claim verified |
| Response quality/sentiment | `responseAudit.enabled`, approved humans/chat types | No inference | Unavailable; successful assessment stages stay cached |
| Inside Out | `insideOut.enabled`; opts in all retained channels | No inference | Failed reviews are recorded and retried; successes stay cached |
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
own overall budget. Skill Whisperer's fixed three-second total budget includes
credential resolution, retrieval and judging, even when its provider timeout is longer.

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

## Session memory extraction

See [the extraction guide](extraction.md) for source approval, host LLM policy,
single-session validation, backfill, and publication. Defaults: disabled,
`publish: false`, `chatTypes: []`, hourly, six overlap messages, five chunks per run.
`extraction.minSupport`, `minRetention`, and `minReplacement` independently accept
0–1 and default to 0.90. Settings are operator-controlled; reload/restart after edits.
Extraction always uses its own 10-second Jev deadline, not `typesafe.timeoutMs`.

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
| `corpora[sessions].maxExpandedTokens` | `500` | 1–10,000; internal host vector retrieval expands a full turn/message when it fits. Public search and Whisperer share the fixed 1,200-character complete-passage renderer with training. |
| `corpora[sessions].syncIntervalMinutes` | `60` | 0–1,440; zero manual-only; first scheduled sync after one interval; requires running Gateway |
| `keepEmbeddingModelWarm` | `true` | Retain embedding model/context after first use; false allows five-minute idle disposal |
| `analysis.executable` | Unset | Optional absolute local worker path; enables ability to recluster, not automatic scheduling |

## TypeSafe and whisperers

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `typesafe.enabled` | `true` | Shared plugin provider gate; no feature is opted in merely by adding a key |
| `typesafe.apiKey` | Unset | Explicit inline key; mutually exclusive with key file; prefer file |
| `typesafe.apiKeyFile` | Unset | Absolute raw-key or dotenv file, reread at credential resolution; explicit missing file never falls back to a different key |
| `typesafe.timeoutMs` | `1500` | 1–10,000 per request for Skill/Memory Whisperer, quality/claim/cluster review and response audit; **primer and dossier save use `peoplePrimer.timeoutMs` and Safety Whisperer uses `safetyWhisperer.timeoutMs` instead** |
| `skillWhisperer.enabled` | `false` | Requires explicit skills corpus and appropriate host hook access; fixed 3-second total deadline |
| `skillWhisperer.historyMessages` | `5` | Nonnegative integer; prior visible messages used for routing |
| `skillWhisperer.minScore` | `0.5` | 0–1, **local vector fallback only**, ignored for TypeSafe shortlist admission |
| `skillWhisperer.cooldownTurns` | `10` | Nonnegative user-turn count; no fallback to weaker cooling-down alternatives |
| `memoryWhisperer.enabled` | `false` | Requires explicit approved non-skill corpora, TypeSafe key and host hooks |
| `memoryWhisperer.corpora` | `[]` | Explicit known corpus names; required nonempty when enabled; no `all` or skills |
| `memoryWhisperer.api.endpoint` | `http://192.168.1.191:18087` | Resident V2 query-model API base URL. Override with `http://127.0.0.1:18087` for a node hosting its own API (e.g. Theo). |
| `memoryWhisperer.api.apiKeyFile` | unset | Absolute path to a file containing the API bearer token. Missing credentials/API failure skips the hint; no local-model fallback. |
| `memoryWhisperer.mlx` | unset | Deprecated: old absolute `{pythonPath, modelPath}` values are accepted but ignored for upgrade compatibility. Remove after configuring `api`. |
| `memoryWhisperer.minUsefulness` | `0.7` | 0–1, minimum Noul yes-probability per candidate; explicit overrides are preserved |
| `memoryWhisperer.maxHints` | `2` | 1–2 |
| `memoryWhisperer.cooldownTurns` | `10` | 0–1,000; recently injected evidence |
| `memoryWhisperer.timeoutMs` | `3000` | 1–10,000 total whisper deadline, not just the provider timeout |
| `memoryWhisperer.complementaryHints` | `false` | Optional extra redundancy judgment; does not expand retrieval or enable the feature |
| `safetyWhisperer.enabled` | `false` | Requires at least one scenario, a TypeSafe key and host hooks; see [Safety Whisperer](#safety-whisperer) |
| `safetyWhisperer.historyMessages` | `6` | 0–20 earlier visible messages, whole messages only, for resolving follow-ups |
| `safetyWhisperer.timeoutMs` | `3000` | 1–10,000 total deadline (credential and request); the host hook timeout must exceed the slowest enabled whisperer |
| `safetyWhisperer.excludedChannels` | `[]` | Up to 500 `{ provider, accountId, channelId, name? }`, matched case-insensitively; skips every scenario there |
| `safetyWhisperer.scenarios` | `[]` | Up to 20; unique `id` of letters, digits, `.`, `_` or `-` |
| `safetyWhisperer.scenarios[].instructions` | Required | Up to 2,000 characters: what the scenario covers, with exclusions; sent to TypeSafe |
| `safetyWhisperer.scenarios[].flaggedPrompt` | Required | Up to 2,000 characters, appended for matching unapproved requests; never sent to TypeSafe |
| `safetyWhisperer.scenarios[].minProbability` | `0.4` | 0–1 minimum yes-probability that the current request is covered |
| `safetyWhisperer.scenarios[].approvedRequestors` | `[]` | Up to 500 `{ provider, accountId, senderId, name? }`; `senderId` must match exactly; skip this scenario for them |
| `safetyWhisperer.scenarios[].excludedChannels` | `[]` | Up to 500 channels where only this scenario is skipped |
| `safetyWhisperer.scenarios[].agentIds` | Unset (every agent) | Non-empty list limits the scenario to these agents when one config serves several; normalized like OpenClaw agent IDs (lowercase) |
| `safetyWhisperer.scenarios[].enabled` | `true` | Disabled scenarios are never sent to TypeSafe |

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
| Memory hints | Same 8,192-token/24,000-byte visible conversation as training goes to the configured query API and recall gate; one complete excerpt (up to 1,200 characters), corpus/source path, represented-message timestamps and evaluation time per passage judgment. V2 retrieves at most 10 BM25 + 10 vector candidates across the approved scope. All indexed sessions in approved corpora are eligible; `chatTypes` controls DMs. |
| Complementarity | Up to 4 already-qualified excerpts for pairwise redundancy checks |
| People primer | Person identity, agent name, approved retrieved excerpts and source/session metadata; all indexed sessions eligible if approved, not just the current chat |
| Dossier save/draft review | Proposed blurb, person/agent names and 1–3 exact approved indexed evidence ranges, at most 6,000 characters total; existing dossier is not evidence |
| Chunk quality | Up to 4 complete chunks of at most 6,000 characters each per request + source kinds; no conversation or source-path fields |
| Ordinary claim review | One proposed claim + up to 3 approved indexed ranges, at most 6,000 characters total |
| Cluster review | Up to 6 eligible complete sampled chunks, each at most 2,000 characters; conclusions only concern the sample |
| Response audit | Approved visible request/answer/context/feedback and bounded later response evidence, separated by assessment stage; optional current-index whole-short-document evidence from approved file corpora |
| Inside Out | Target human reply, nearest assistant text and bounded preceding visible history; channel-scoped speaker identity keys |
| Safety check | The complete current human message without OpenClaw's conversation-info header; the thread starter, replied-to message and channel messages since the last reply that arrived with it, which can include other people's names and message IDs; up to `historyMessages` earlier visible messages; and each eligible scenario's `instructions`. No sender, account or channel IDs from that header, approval lists or flagged prompts. A message wrapper Safety Whisperer does not recognize (anything other than Slack's) is sent whole, minus that header. |
| Standalone QMD query | Query, optional intent, selected excerpts, source paths and evaluation time; separate process/SDK credentials and collection scope |

Omitting tool-result/thinking/system fields does not remove their content if it
was quoted in ordinary visible text. Provider judgments are advisory; probability
or score is not proof. Enabling a feature approves only that feature's documented processing.


## Safety Whisperer

An optional, interim guardrail for agents that serve several people. Before the
main model runs on a human turn, it checks the current message against scenarios
you define, such as questions about one person's salary. When a requestor who is
not approved for a scenario asks something it covers, that scenario's
`flaggedPrompt` is appended next to their message for that turn.

**This is a prompt-level guardrail, not access control.** The classifier can miss
a request and the agent can ignore an injected instruction. It does not remove
sensitive information already available in context, memory or tools. An approved
requestor is not an approved audience: asking in a shared channel can still expose
an answer to everyone there. Use separate agents and real data-access controls for
hard boundaries.

```json
{
  "safetyWhisperer": {
    "enabled": true,
    "excludedChannels": [
      { "name": "#leadership", "provider": "slack", "accountId": "work", "channelId": "C_LEADERSHIP" }
    ],
    "scenarios": [
      {
        "id": "individual-salaries",
        "instructions": "Requests about a specific individual employee's salary, pay or compensation, including colloquial phrasing such as how much someone makes or earns. Exclude vendors and contractors.",
        "approvedRequestors": [
          { "name": "Dani", "provider": "slack", "accountId": "work", "senderId": "U_DANI" }
        ],
        "excludedChannels": [
          { "name": "#people-ops", "provider": "slack", "accountId": "work", "channelId": "C_PEOPLE_OPS" }
        ],
        "flaggedPrompt": "This requestor is not approved to access this information. Kindly tell them that; do not disclose the requested information."
      }
    ]
  }
}
```

The plugin entry also needs `hooks.allowConversationAccess: true`, and
`allowPromptInjection` must not be `false`; see [host controls](#host-controls).

### How each turn is checked

1. Only user-triggered turns are checked, every time: there is no cooldown. A
   prompt rebuild for the same run reuses that run's result. Messages steered
   into a run that is already working are not checked; see
   [messages sent while the agent works](#messages-sent-while-the-agent-works).
2. A global `excludedChannels` match skips every scenario. A scenario's own
   `excludedChannels` skip only that scenario. Thread replies and forum topics
   use their channel.
3. Disabled scenarios, scenarios limited to other `agentIds`, and scenarios that
   approve this requestor are dropped.
4. If none remain, no request is made. Otherwise one TypeSafe request asks one
   independent yes/no question per remaining scenario. It includes the complete
   current message, the channel context that arrived with it (thread starter,
   replied-to message, chat history since the agent's last reply) and up to
   `historyMessages` earlier visible messages. A follow-up like "What about
   Sally?" or "answer the question above" is therefore judged in context, while
   the current message is judged, not whether an earlier one mentioned the topic.
5. Every scenario scoring at least its `minProbability` adds its `flaggedPrompt`
   in `<safety>` tags, last in the shared `<unblock_memory>` block after the
   human message.

### Messages sent while the agent works

OpenClaw's default queue mode, `steer`, adds a message sent during an active run
to that run without building a new prompt, so the message is never checked. The
same applies when a person types `/queue steer` in a session. For agents that
rely on Safety Whisperer, set `messages.queue.mode` (and any
`messages.queue.byChannel` entries) to `followup` or `collect`; `memory_diagnostics`
and the Gateway log warn with `queue_mode_steer` until then. In `collect` mode,
queued messages from different people carry no single sender, so none of them is
approved.

### Identity

Approval and exclusions compare `provider`, `accountId`, and `senderId` or
`channelId` values from the host's trusted turn metadata. `senderId` must match
exactly. `provider`, `accountId` and `channelId` match case-insensitively, because
OpenClaw lowercases them in places. Names are labels only; display names, message
text and identity claims never count. Missing identity never approves anyone and
never excludes a channel, so turns without a sender ID, such as CLI or webchat,
are treated as unapproved. Email-based approval is not supported.

For Slack:

- `provider` is `slack`.
- `accountId` is the OpenClaw Slack account key, or `default` when the channel
  has one account.
- `senderId` is the person's member ID (`U…`): in their Slack profile, choose
  **Copy member ID**.
- `channelId` is the channel's ID (`C…` or `G…`), shown at the bottom of the
  channel details.

Some runtimes do not pass sender identity to plugins; OpenClaw's Codex
app-server harness is one. There, every requestor is treated as unapproved,
exclusions may not apply, and `memory_diagnostics` counts `missing_identity`;
the first such turn is also logged.

### When the check cannot run

Safety Whisperer **fails open**: if the check cannot complete, the turn proceeds
with no safety prompt. A TypeSafe outage or missing key therefore turns the
guardrail off. The exception is a message too large to check: the requestor
controls its size, so every eligible scenario's `flaggedPrompt` is added instead.
`memory_diagnostics` reports each outcome under `whisperers.safety`, keeping
could-not-check separate from no match:

| Outcome | Meaning |
| --- | --- |
| `flagged` | At least one scenario matched; `matchedScenarios` counts matches by scenario ID |
| `no_match` | Checked; no scenario matched |
| `excluded` / `no_scenarios` | Skipped by a global exclusion, or nothing remained after filtering; no request |
| `empty_request` | The current message had no text, such as an attachment alone; not checked |
| `missing_key` / `typesafe_disabled` | Could not check: no credential, or TypeSafe disabled |
| `input_too_large` | Not checked: the current message exceeds the roughly 24k-token budget. It is never truncated; every eligible `flaggedPrompt` is added |
| `timed_out` / `failed` | Could not check: deadline, provider error or no usable answer |
| `partial_response` | Counted with `flagged`: some answers were unusable, and the confident matches were still added |
| `missing_identity` | Counted with the turn's outcome: the host passed no provider, account or sender ID |
| `cancelled` | The session ended or the Gateway stopped during the check |

Warnings include the outcome, error code, HTTP status and scenario count, never
message text; a missing key is logged once until it returns.
`memory_diagnostics` also reports `safety.active: false` with a `reason` when
settings or host controls prevent checks (`typesafe_disabled`,
`conversation_access_not_allowed`, `prompt_injection_not_allowed`,
`no_enabled_scenarios`), and a `warnings` list:

- `host_hook_timeout_below_whisperer_timeouts`: the host's `before_prompt_build`
  timeout is shorter than the slowest enabled whisperer (`slowestWhispererMs`).
  The host times out the plugin's whole contribution, so a slow Memory Whisperer
  turn can drop a safety prompt even after diagnostics counted it as `flagged`.
- `queue_mode_steer`: see
  [messages sent while the agent works](#messages-sent-while-the-agent-works).

The Gateway logs this status at startup when the feature is inactive or has a
warning.

### Writing scenarios

`instructions` are the classifier's entire definition of a scenario. Name the
subject, its synonyms and colloquial phrasing, and what is excluded. In the
source checkout's `eval/safety-whisperer/` cases, adding "pay … including how much
someone makes or earns" raised a compound request ("What does Bob make, and is he
on medical leave?") from 0.06 to 0.45–0.48 and lowered "When is payday?" from 0.45
to 0.18–0.21. With that wording, the 0.4 default `minProbability` made no errors
across 22 cases, while 0.5 missed the compound request. Lower it to catch more
borderline requests, or raise it for fewer false refusals. Test your own scenarios
there before relying on them.

## Inside Out

Inside Out records six independent emotion-presence probabilities for each human
reply following assistant text, including consecutive follow-ups and replies to
progress updates. It is channel agnostic and does not grade agent quality or
change memories, retrieval, prompts, or dossiers.

```json
{
  "insideOut": {
    "enabled": true,
    "intervalMinutes": 1440,
    "maxInteractions": 100,
    "maxContextTokens": 30000
  }
}
```

Defaults: disabled; daily cadence; at most 100 attempted reviews per run; estimated
30,000-token context budget, leaving room for questions under Jev's 32k
state-plus-longest-question limit. `intervalMinutes: 0` is manual-only. The shared
`typesafe` settings supply Jev credentials and request timeout.

**Enabling this approves sending visible human/assistant conversation text across
all retained channels to TypeSafe.** System messages, tool bodies, thinking blocks,
known bots, delivery mirrors, and recognized automated inputs are omitted. The
state includes human identity keys for speaker attribution. Probabilities describe
expressed emotion, not intensity; several emotions can be present, and they need
not sum to one. High sadness need not mean the agent caused it.

Each request contains chronological visible `history` and a separate `target`
human reply. Six Noul questions judge only `target.text`, using history to interpret
tone and speaker attribution. Short yes/no criteria define each emotion; subtle
emotion counts without requiring explicit emotion words. Raw tool-result messages
and tool-call blocks never enter either field; visible assistant text explaining a
tool's findings remains conversation text. The rubric is `emotion-presence-v2`.

```bash
openclaw memory-emotions run --agent main
openclaw memory-emotions report --agent main --sender U123 --bucket week
openclaw memory-emotions export --agent main --emotion anger --min 0.8
openclaw memory-emotions run --agent main --retry
openclaw memory-emotions link-people --agent main
openclaw memory-emotions link-people --agent main --repair-identities
openclaw memory-emotions run --agent main --session SESSION_ID
openclaw memory-emotions export --agent main --session SESSION_ID
```

`run` handles backfill and new interactions through the same bounded pass. Repeat
it until `reviewed` and `failed` are zero to finish backfill. Gateway startup also
runs one pass, then repeats at the configured interval. Successful results are
cached; new interactions take priority over retries. Request failures retry after
an hour when the pass has remaining capacity, or immediately with `--retry`.
Oversized context failures require explicit `--retry`, for example after increasing
the context budget. Source read failures appear in the run's `errors` list.
Run one writer per agent: pause the
background cadence during concurrent operator backfills. There is no cross-process
lease or persistent scheduling infrastructure.

`--session` limits `run`, `report`, and `export` to one exact session ID. For a
manual canary, keep `intervalMinutes: 0` and run/export that session; this still
requires `insideOut.enabled: true` and sends its eligible interactions to Jev.
Files are scoped by their session filename, with a header-only check for legacy
names that differ from the session ID; unrelated transcript bodies are not parsed.

A small `inside_out_checkpoints` table skips unchanged sources before loading or
decompressing transcript bodies. SQLite uses the rewrite generation and persisted
event sequence; files use inode, size, and modification/change time. Discovery
still checks source metadata each pass. Changed sessions load earlier history for
context, but completed SQLite event sequences do not trigger review/cache lookups.
Queued replies with older send timestamps remain discoverable by persisted sequence.
Only exhausted snapshots advance checkpoints. Bounded or interrupted passes resume
through the review cache. Failures do not rewind checkpoints; retries load only
the source that owns the failed review, after their cooldown.
`sources` counts loaded sources, and `skippedSources` counts unchanged ones skipped.

The reader scans SQLite active transcripts, retained reset/delete archive blobs,
and JSONL files in the agent's sessions directory, including zstd archives. There
is no age cutoff. Files resolve their selected branch; duplicate copies with the
same session/message IDs produce one result. Each copy supplies its own context;
this version does not stitch archive prefixes onto live tails or reconcile edits,
deletions, forks, or identity changes. A cached review is an observation of that
snapshot, not a continuously revalidated claim. Future rubric changes use a new
version to distinguish results.

Queued messages use their original send timestamps when available; missing times
fall back to retained transcript order rather than excluding interactions. Context
keeps the target and nearest assistant whole and drops older messages to fit an
estimated token budget. If that essential pair alone exceeds the budget, the row
records an error and nothing is uploaded. This is an estimate, not Jev's tokenizer.

The `inside_out` results table and its checkpoints live in `unblock-memory.sqlite`.
Results store source
references, channel-scoped human keys, timestamps, rubric/model, six probabilities,
and errors—not conversation text. Missing account or sender identity stays
session-scoped; identities are not guessed or automatically linked across channels.
Each new review also stores a nullable `person_id`, resolved from PeopleSQL's
existing `(provider, account_scope, external_id)` mapping. Human keys remain
session-scoped when the account is missing, but `person_id`
can resolve by provider and external ID if all matching People identities point to
one person. Known accounts must match exactly; ambiguous IDs stay unlinked. Modern
sender metadata takes precedence over legacy message-level `sourceChannel` and
`senderId`, which take precedence over session/owner fallbacks. Names and text
envelopes are not identity evidence.
`link-people` upgrades older results and refreshes their person links, including
changed or removed mappings; by default it never reads transcripts. Its explicit
`--repair-identities` option reads sources owning unlinked reviews and repairs
their channel, sender ID and human key from persisted metadata before linking.
Neither mode calls Jev or changes scores, timestamps, review IDs or checkpoints.
Unmatched identities stay null. Exports include `person_id`.
`export` emits all matching rows as JSON, including errors. `report` averages
successful rows by human, UTC day/week, rubric, and model; counts are the denominator.
Both accept `--session`, `--sender`, `--since YYYY-MM-DD`, `--emotion`, and `--min`. `--sender`
matches exact sender IDs across channels; use exported `human_key` for precise
account-specific analysis. These commands are read-only and never invoke Jev.

## Storage, upgrades and recovery

Each agent's state lives under the configured OpenClaw state directory, normally
`~/.openclaw/agents/<agentId>/unblock-memory/`. `index.sqlite` is rebuildable;
`unblock-memory.sqlite` holds durable people, curation, response-audit and Inside Out state.
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
