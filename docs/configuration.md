# Configuration

[Overview](../README.md) · [Retrieval](retrieval.md) · [People](peoplesql.md) · [Response audit](response-audit.md)

All plugin settings below belong under
`plugins.entries.unblock-memory.config`, not at the top level of OpenClaw.
Unknown keys are rejected. Restart/reload the Gateway after changing plugin
settings; a rotated credential file is reread without a restart.

## Feature gates and fallbacks

| Feature | Required settings/dependencies | decision model disabled / no key | Provider or unreadable-key failure |
| --- | --- | --- | --- |
| My Turn | `myTurn.enabled`; conversation access and prompt injection | No hint; normal turn | No hint; normal turn |
| `memory_search` | Installed/enabled memory slot; configured corpora | Local retrieval-ranked leads with degraded warning | Successful judged siblings returned with a partial warning; total judging failure or unreadable key uses local retrieval fallback |
| `memory_get` | Installed/enabled memory slot; configured corpora | Unchanged local indexed reads | Unchanged; its own indexing errors still matter |
| Skill Whisperer | `skillWhisperer.enabled`, skills corpus, host hooks | Local vector matches meeting `minScore` | Keep active skills and matches from successful batches; no vector-only fallback |
| Memory Whisperer | `memoryWhisperer.enabled`, explicit approved corpora, host hooks | No hints | Exclude failed candidates; deadline failures still suppress the turn; v2 recall-gate failures search every approved corpus, and topic-extraction (or legacy query-API) failures fall back to deterministic local queries before decision model judging |
| Complementary hints | Enabled Memory Whisperer + `complementaryHints` | No additional judgment; base hints also require a key | Keep baseline hints unless the total deadline expires |
| Expectations Whisperer | `expectationsWhisperer.enabled` (default on), host hooks (conversation access and prompt injection) | Unchanged: local read-only lookup, no model call | Unchanged; a missing database or table whispers nothing |
| Safety Whisperer | `safetyWhisperer.enabled`, at least one scenario, host hooks (conversation access and prompt injection) | Could not check: the turn proceeds without safety prompts (fails open) | Fails open; recorded as could-not-check, never as no match |
| People store/tools | `people.enabled` | Available; automatic save review needs primer/key or verified manual alternative | Storage/inspection still available |
| People Whisperer | People + `people.whisperer.enabled`, host hooks, eligible person/dossier, no prior thread receipt | Unchanged local lookup | Unchanged local lookup |
| People Primer / automatic dossier save review | People + `peoplePrimer.enabled`, approved corpora | No judgment; save requires source-specific manual verification | No automatic save; verify/retry instead |
| Quality audit / cluster review | `qualityAudit.enabled`, approved corpora; cluster review also needs fresh analysis | No judgment | Unavailable/partial; preserve evidence and retry as documented |
| Ordinary claim review | `evidenceReview.enabled`, approved corpora | No judgment | Unavailable; no claim verified |
| Response quality/sentiment | `responseAudit.enabled`, approved humans/chat types | No inference | Unavailable; successful assessment stages stay cached |
| Inside Out | `insideOut.enabled`; opts in all retained channels | No inference | Failed reviews are recorded and retried; successes stay cached |
| Clustering | Configured local `analysis.executable` | Unchanged | Unchanged; worker failures do not disable ordinary search |
| `deep_thought` | `steward.enabled` + `steward.deepThought.enabled`; a Steward credential | Tool returns `unavailable`; inner searches use local retrieval ranking | `failed`/`timed_out` with partial usage; no answer is invented |
| People shadow | `steward.enabled` + `steward.peopleShadow.enabled`; People Learning manifests | Pass stops early; no strikes, nothing published | Item retried next pass without a strike; rejected proposals strike toward quarantine |
| Expectations pass | `steward.enabled` + `steward.expectations.enabled` | Captain's Log blockers and people todos are still mirrored (no model); session extraction and sweeps are skipped | Deterministic rows stay committed; the model stage retries within 15 minutes |
| Post-Captain's-Log expectations check | Expectations pass + `captainsLogDecisionResolve` + `decisionModel.enabled`; a decision-model credential | Skipped; new blockers are still mirrored right after the append | Warning only; Captain's Log stays appended and items stay open for the regular sweep |
| Memory Crystals pass | `steward.enabled` + `steward.crystals.enabled`; a QMD index. Synthesis needs a Steward credential and analysis clusters; reclustering needs `analysis.executable` | STM decay and LTM promotion still run (no model); no new crystals | The pass releases its lease and retries next interval; existing crystals are untouched |
| Overnight Thinking pass | `steward.enabled` + `steward.overnight.enabled`; a Steward credential. Voltaire Drift and pre-answering also need `steward.deepThought.enabled` and a QMD index | Skipped | Per-item failures are listed in `errors`; a failed pass publishes nothing and retries within 15 minutes |
| Self-writing skills pass | `steward.enabled` + `steward.skills.enabled`; a Steward credential and a `skills` corpus. Description updates also need `decisionModel` for replay | Pitfall patches and new-skill drafts still run; description updates are skipped (`description_update:*:replay_unavailable`) | Isolated failures are listed in `errors`; nothing is proposed for a failed subject, and a live `SKILL.md` is never written |
| Fleet Commons (`"fleet"` corpus) | `fleetCommons.enabled` + `endpoint` or `feedPath`; a QMD index | Unchanged: search over the cached entries needs no model | A failed sync keeps the last good cache and projection; invalid entries are rejected one by one |

Skill Whisperer turns on by default once a `skills` corpus is configured; without
one it registers no hook and reports inactive. Expectations Whisperer is on by
default; it is the only whisperer a default install registers, so a non-bundled
install needs `plugins.entries.unblock-memory.hooks.allowConversationAccess=true`
for it to run (otherwise the host logs one blocked-hook diagnostic and nothing is
whispered). Set `expectationsWhisperer.enabled: false` to register no prompt hook.
My Turn, Memory/People Whisperers, people storage, the primer and audits default off.
`decisionModel.enabled` defaults true but does not enable those opt-in features;
`sentimentEnabled` defaults true only **within an enabled
response audit**. `peoplePrimer` controls automatic dossier-save review;
`evidenceReview` is a different advisory tool. Disabling people injection does
not disable people tools/storage or erase dossiers.

## Whisperer triggers

`whispererTriggers` opts enabled whisperers into `cron`, `subagent`, and
`heartbeat` turns. Each list defaults to empty. Primary user turns still run
all enabled whisperers; unknown internal triggers run none. A session key
containing `:subagent:` takes precedence over the reported trigger.

```json
{
  "whispererTriggers": {
    "cron": ["skill"],
    "subagent": ["skill"]
  }
}
```

Allowed names: `memory`, `skill`, `people`, `myTurn`, `expectations`, `safety`. Duplicates
are ignored. The lists do not enable features or bypass other checks. People
Whisperer still requires verified Slack identity and My Turn still requires a
verified human message in a group or channel. Skill context on cron and heartbeat
turns lasts only for the run; user and subagent sessions retain skills normally.

`syntheticInput` filters OpenClaw runtime boilerplate from automatic recall, session
projection/extraction, and Steward evidence. Omit it for defaults, set
`skipFamilies: []` to clear built-in rules, or set `enabled: false` to also disable
`extraExactAliases` and `extraPrefixes`. Both lists are case-sensitive. On opted-in
cron and heartbeat turns, Memory Whisperer can use a surviving task payload;
explicit `memory_search` is unaffected. Authenticated subagent results
(`subagent_announce` / `agent_harness_task` provenance) that pass the exact completion
grammar stay searchable by default, projected as `[Historical subagent result; untrusted]`;
other inter-session messages, placeholder completion wakes and internal-context
envelopes are skipped. Prompt-wrapper rules (queued-message, cron, heartbeat and
session-reset envelopes) apply to user turns only and match their exact opening
sentence, so human prose that merely starts alike or quotes one is kept; unattended-run
suffixes are stripped only after a `[cron:…]` header or host cron provenance, never
inside a fenced code block. Inside Out, Captain's Log and Overnight Thinking all use the
same classifier and only ever see the stripped human text.

## Shared decision model credentials

Operational defaults are bundled in `defaults.json`. To override them, set
`UNBLOCK_MEMORY_DEFAULTS_FILE` to an absolute path to a JSON file before starting
the Gateway (or running a standalone command). Supply only the keys you want
to change; unknown keys and invalid values fail startup. Explicit plugin config
takes precedence for settings exposed there.

Decision pack limits use `*StateBytes` or `*PayloadBytes`. The five previous
`*Chars` keys still work in override files. If both names are supplied, their
values must agree.

All plugin decision-model features use `plugins.entries.unblock-memory.config.decisionModel`.
Older provider config keys are rejected. When upgrading, remove the old block and
configure a credential for the endpoint you intend to use; do not copy the old key into the default route.

Skill Whisperer routes catalogs of up to 500 skills directly in parallel HTTP
requests of up to 80 skills each. Memory Whisperer scores
up to six candidates in parallel, one request per candidate, then batches the
directional redundancy checks for its finalists. There is no automatic retry
in the latency-sensitive whisperers.

```json
{
  "decisionModel": {
    "enabled": true,
    "endpoint": "https://codex.unblocklabs.ai/v1/decisions",
    "model": "liquid/d1.2-ultra",
    "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-decisions.env",
    "timeoutMs": 4000
  }
}
```

This is a **plugin config fragment**, not a top-level OpenClaw configuration.
Defaults are `enabled: true`, `endpoint: "https://codex.unblocklabs.ai/v1/decisions"`,
`model: "liquid/d1.2-ultra"`, and `timeoutMs: 4000` (routed through Codex LB to OpenRouter's
`liquid/d1.2-ultra` Decisions API). For a different provider, set its
`endpoint`, `model`, and credential explicitly. Plain HTTP is allowed only on
loopback (`localhost`, `127.0.0.1`, `[::1]`).

The key file can contain a plaintext key or dotenv entries:

```dotenv
CODEX_LB_API_KEY="YOUR_CODEX_LB_KEY"
```

Inline and file credentials are sent only to the configured endpoint. A dotenv file
reads `CODEX_LB_API_KEY`, or `DECISION_MODEL_API_KEY` for a custom endpoint. Without
an explicit credential, only the Codex LB HTTPS origin can use the Gateway's
`CODEX_LB_API_KEY` environment variable.
Configure at most one of `apiKey` and `apiKeyFile`; prefer a private file over a secret in config.

The file is reread when a feature resolves credentials, so replacing its contents
does not require a Gateway restart. Restart/reload the Gateway after changing the
configured path or other plugin settings. A dotenv file is not executed as shell
code and does not change the process environment. Workspace `.env` files are not
auto-discovered, and an interactive shell's exported key need not reach a managed
Gateway service.

Missing/empty files or dotenv files without a matching key entry count as no key.
An explicit file never falls back to an unrelated environment key. Missing or
unreadable credentials do not break normal memory functionality or Gateway startup;
the feature-specific fallback/skip behavior above applies. **Unreadable files and
provider errors are not Skill Whisperer's no-key fallback:** they prevent new routing on any failed batch; active skills remain available.
Use `memory_diagnostics` for credential availability; it does not verify provider
acceptance. Keep secret files mode `600`, secret directories mode `700`, and keys
out of Git, chat, shell arguments and logs.

`decisionModel.timeoutMs` is not a universal total deadline: People Primer and dossier
save review use `peoplePrimer.timeoutMs` per request; Memory Whisperer has its
own overall budget. Skill Whisperer uses a three-second request timeout instead,
bounded by a shared three-second deadline that includes credential resolution,
retrieval and judging.

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
    { "name": "sessions", "kind": "sessions", "chatTypes": ["channel", "group", "direct"], "syncIntervalMinutes": 5 }
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
  "decisionModel": { "enabled": false },
  "skillWhisperer": { "enabled": true }
}
```

Select only desired skill locations. To use decision model selection instead, enable
`decisionModel` and configure credentials; the selected skill still is not auto-invoked.

### Memory Whisperer over approved knowledge

```json
{
  "corpora": [
    { "name": "memory", "kind": "files", "paths": ["MEMORY.md", "USER.md", "memory/**/*.md"] },
    { "name": "knowledge", "kind": "files", "paths": ["knowledge/**/*.md"] }
  ],
  "decisionModel": { "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-decisions.env" },
  "memoryWhisperer": { "enabled": true, "corpora": ["knowledge"] }
}
```

Create the private key file first. To recall conversation history, configure a
sessions corpus and add `sessions` to `memoryWhisperer.corpora`. Automatic recall
can then retrieve across this agent's indexed sessions. The sessions corpus's
`chatTypes` setting controls whether direct messages are included. Selected
excerpts are sent to the configured decision endpoint (defaults to
`https://codex.unblocklabs.ai/v1/decisions` -> OpenRouter `liquid/d1.2-ultra`)
and may be injected into any conversation using this agent.

### Brightness A/B arm

Brightness is off by default. Assigning a node to an arm is one key; the arm then
labels its own Memory Whisperer exposures (`brightness:actr_v1`,
`brightness:outcome_v1`, or `brightness:emotion_v1`), so `memory-steward outcomes` reports each arm in
`byRecipe` without setting `recipeHash`:

```json
{
  "memoryWhisperer": { "enabled": true, "corpora": ["memory"], "brightness": { "recipe": "emotion_v1" } }
}
```

`emotion_v1` adds unsigned salience to `outcome_v1`. It takes the strongest
Captain's Log salience recorded for a daily note (any path ending in `/YYYY-MM-DD.md`
outside a session corpus, including native QMD URIs such as
`qmd://source-…/prior-months/may-2026/2026-05-05.md`), or the strongest Inside Out grade
for a session ID in the path: a session projection's `<date>--<sessionId>.md` suffix, a
UUID, or, inside a `sessions/` corpus only, an exact path segment (so
`qmd://knowledge/private/policy.md` never matches a session named `private`). Only
grades and log entries observed within `lookbackDays` count. Inside Out salience comes from the shared
emotional-salience reader that also feeds Captain's Log and Crystals: intensity
divided by 3, blended with the person's own relative intensity percentile once they
have `insideOut.baselineMinInteractions` prior intensity grades (else the hottest
emotion's personal-deviation percentile); legacy grades without intensity use the
strongest emotion probability, discounted by 0.85. Salience extends
the 30-day outcome decay constant up to 120 days within `lookbackDays` and adds
a bounded bonus. With no salience, scores match `outcome_v1`; a confirmed
`hurt` never gets a brightness increase.

Memory Crystals are whispered from the same `<memory>` block by default once the
Steward has produced some; set `memoryWhisperer.crystalsEnabled: false` to stop.

### People storage, without injection

```json
{ "people": { "enabled": true, "whisperer": { "enabled": false } } }
```

### People injection and optional evidence primer

```json
{
  "people": { "enabled": true, "whisperer": { "enabled": true } },
  "peoplePrimer": { "enabled": true, "corpora": ["memory"] },
  "decisionModel": { "apiKeyFile": "/absolute/path/to/secrets/unblock-memory-decisions.env" }
}
```

The default memory corpus exists. This separately approves its evidence for
the configured decision endpoint; it does not create a dossier or schedule maintenance. Use the
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
`extraction.minSupport` and `minRetention` independently accept 0–1 and default to 0.90.
`extraction.minReplacement` (0–1, default 0.90) is accepted but deprecated: extraction appends
immutable dated observations and never replaces earlier ones. It still forms part of the
checkpoint policy fingerprint, so changing it rewinds sessions like any other policy change. Settings are operator-controlled; reload/restart after edits.
Extraction always uses its own 10-second decision model deadline, not `decisionModel.timeoutMs`.

## Fleet Commons

`fleetCommons` (off by default) pulls a sanitized, fleet-wide feed of tool pitfalls,
API workarounds, platform outages and procedures into each agent's
`unblock-memory.sqlite` (the authoritative cache) and projects it into QMD as the
`unblock-fleet` collection, searchable as the `"fleet"` corpus (`memory_search`,
`memory_get` paths `qmd://unblock-fleet/<id>/<revision>`, citations
`fleet:<id>@r<revision>`). Every entry is re-validated locally before it is cached:
unknown fields, secrets and credentials, email addresses, phone numbers, Slack IDs,
local filesystem paths and client/personal identifiers reject that entry only, and
the newest revision per id wins. Expired entries drop out at the next sync (and stop
being served immediately) unless `allowExpired` is true. The feed is either
`endpoint` (HTTP(S), `Authorization: Bearer` from `apiKey`/`apiKeyFile`, ETag-cached,
redirects refused) or a local `feedPath`; both return `{ "entries": [...] }`. The
Fleet Organism hub (`scripts/fleet-organism-hub.mjs`) serves exactly that shape at
`/api/v1/commons` and applies the same validation when entries are POSTed. Enabling
also adds `"fleet"` to the corpora `memory_search` and `deep_thought` may select, and
allows `"fleet"` in `memoryWhisperer.corpora`. A configured corpus named `fleet` is
then rejected. Each agent syncs once when its memory manager opens, then while the
Gateway runs every already-open agent syncs each `syncIntervalMinutes` (unused agents
are never started just to sync). The feed request and validation run outside the
manager's write queue, so a slow feed never delays search or indexing; only the SQLite
replace and QMD projection are queued. Gateway shutdown aborts in-flight requests, and
rejected entries are logged with their sanitized id and reasons. If the projected
`unblock-fleet` collection lost documents (for example a rebuilt `index.sqlite`), the
next sync re-projects the cache even when the feed is unchanged or answers `304`.
Entries longer than a caller's snippet budget return their matched passage, bounded to
that budget, with line numbers into the `memory_get` document (title, blank line, body,
provenance). A cached `deep_thought` synthesis that cites a Fleet entry which has since
expired or been retired is treated as stale. Hygiene is tuned against operational prose:
status-code lists (`500 502 503`), versions, dates, epoch timestamps, all-caps error
codes (`UNAVAILABLE`), hex digests and placeholders (`Authorization: Bearer <token>`,
`token: must be refreshed`) pass, while real tokens, `+`-prefixed or 3-3-4 phone
numbers, emails, digit-bearing Slack IDs and local paths are rejected.
`openclaw memory-steward fleet-commons --agent main [--sync]` prints the cached
entries read-only, or syncs now.

```json
{
  "fleetCommons": {
    "enabled": true,
    "endpoint": "https://fleet-hub.example.com/api/v1/commons",
    "apiKeyFile": "/etc/unblock-memory/fleet-hub-token"
  },
  "memoryWhisperer": { "enabled": true, "corpora": ["memory", "fleet"] }
}
```

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `fleetCommons.enabled` | `false` | Sync and search the Fleet Commons feed; requires `endpoint` or `feedPath` |
| `fleetCommons.endpoint` | Unset | HTTP(S) feed URL without embedded credentials (`@` is allowed in the path, never before the host) |
| `fleetCommons.feedPath` | Unset | Absolute path to a local JSON feed file (takes precedence over `endpoint`) |
| `fleetCommons.apiKey` / `apiKeyFile` | Unset | Bearer token for `endpoint`, inline or from an absolute file path; never sent to a local feed |
| `fleetCommons.syncIntervalMinutes` | `15` | `> 0` minutes between background syncs |
| `fleetCommons.timeoutMs` | `10000` | `1..2147483647` ms per feed read or request |
| `fleetCommons.maxEntries` | `0` | `>= 0` entries kept after validation, most severe then most recently updated first (`0` = unlimited) |
| `fleetCommons.maxFeedBytes` | `5242880` | `>= 0` feed bytes streamed before JSON parsing; a larger feed fails the sync and keeps the last good cache (`0` = unlimited) |
| `fleetCommons.allowExpired` | `false` | Keep and serve entries past `expiresAt` |

### Fleet Organism telemetry and Morning Brief

Fleet telemetry is pull-based and read-only: nothing leaves a node unless an operator
runs a command (or their own scheduler) that pushes it.
`openclaw memory-steward fleet-telemetry --agent main [--node <alias>] [--agent-alias <alias>] [--since-hours <n>] [--format json|prometheus] [--push <url> [--token-file <path>] [--push-timeout-ms <n>]]`
prints an anonymous aggregate snapshot (outcome KPIs by recipe, crystal and
expectation counts, derived-observation hits, pending skill proposals by kind,
flagged sentiment-drift count, quarantined work items). It carries no text, names,
paths or ids beyond the operator-assigned `--node` alias (default `local`) and
`--agent-alias` (default `default`); the local `--agent` id only selects the store and
is never exported, so a client-named agent never becomes a Prometheus label. Aliases
are at most 64 characters. `openclaw memory-steward fleet-brief --agent main [--node <alias>] [--agent-alias <alias>] [--due-soon-hours <n>] [--limit <n>] [--format json|markdown] [--push <url> ...]`
prints the **operator-only** Morning Brief: open blockers, overdue and due-soon
expectations, sentiment drift, pending skill proposals (highest replay recall gain
first) and quarantined work. It does contain private text, so never route it to a
metrics system. Neither command creates or migrates a database. `--push` POSTs the
JSON snapshot to that exact hub endpoint (`/api/v1/telemetry` or `/api/v1/brief`)
with `Authorization: Bearer` from `--token-file`, refuses redirects, and requires
`https://` unless the host is loopback; `--push-timeout-ms` defaults to `10000`
(`0` = none). The optional hub,
`node scripts/fleet-organism-hub.mjs [--host 127.0.0.1] [--port 8787] [--db <path>] [--token-file <path>] [--read-token-file <path>] [--ingest-token-file <path>] [--ingest-tokens-file <path>] [--operator-token-file <path>] [--private-metrics] [--max-body-bytes <n>] [--max-clock-skew-ms <n>] [--snapshot-ttl-ms <n>] [--max-alias-length <n>] [--forbidden-terms-file <path>]`
(run `npm run build` first in a source checkout), stores the latest snapshot per
node/agent. It serves `/metrics` (Prometheus; public unless `--private-metrics`),
`/api/v1/ab-leaderboard`, `/api/v1/brief[?format=markdown]` and the Commons feed.

Hub bearer tokens are split by role. The **read** token (`--read-token-file`) may
`GET /api/v1/commons` (and `/metrics` when private); the **ingest** token
(`--ingest-token-file`) may `POST /api/v1/telemetry` and `POST /api/v1/brief` for any
node, while `--ingest-tokens-file` (a JSON object of node alias to token) binds each
token to snapshots carrying its own `nodeId` (`403` otherwise); the **operator** token
(`--operator-token-file`) may `POST /api/v1/commons`, `GET /api/v1/brief` and
`GET /api/v1/ab-leaderboard`. `--token-file` is an all-roles fallback used only for
roles given no token of their own. A role with no token is open, which the hub allows
only on loopback: binding beyond loopback needs a token for every role. Every POST
must send `Content-Type: application/json` (`415` otherwise), so a browser page cannot
post to a tokenless loopback hub with a simple form.

The hub rejects snapshots collected more than `--max-clock-skew-ms` in the future
(default `300000`, `0` = no check) with `400`, and answers `409` instead of silently
dropping a snapshot older than the stored one. Telemetry older than
`--snapshot-ttl-ms` (default `172800000`, 48 hours; `0` = never) leaves `/metrics` and
both leaderboards. `--max-alias-length` caps node/agent aliases (default `64`, `0` =
unlimited). The A/B leaderboard keeps snapshots with different `sinceHours` windows in
separate rows, each with `coverageFromMs` (`null` = all history) and `coverageToMs`.
Commons revisions are immutable: re-posting an identical revision returns `200`,
retiring it (`status: "retired"`) returns `200`, but reactivating a retired revision or
changing a stored revision's content returns `409`. Post a higher revision instead.

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
| `corpora[sessions].maxExpandedTokens` | `500` | 1–10,000; internal host vector retrieval expands a full turn/message when it fits. Public search and Whisperer share the 1,200-character complete-passage renderer. |
| `corpora[sessions].syncIntervalMinutes` | `5` | 0–1,440; zero manual-only; first scheduled sync after one interval; requires running Gateway |
| `keepEmbeddingModelWarm` | `true` | Retain embedding model/context after first use; false allows five-minute idle disposal |
| `analysis.executable` | Unset | Optional absolute local worker path; enables ability to recluster, not automatic scheduling |

## Decision model and whisperers

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `decisionModel.enabled` | `true` | Shared provider gate; does not opt in any feature |
| `decisionModel.endpoint` | `https://codex.unblocklabs.ai/v1/decisions` | HTTPS or loopback HTTP, without credentials, query, or fragment |
| `decisionModel.model` | `liquid/d1.2-ultra` | Requested model alias; dated `liquid/d1.2-ultra-*` snapshots are rejected on the default route |
| `decisionModel.apiKey` | Unset | Explicit inline key; mutually exclusive with key file; prefer file |
| `decisionModel.apiKeyFile` | Unset | Absolute plaintext-key or dotenv file; reread at credential resolution. If missing, no fallback |
| `decisionModel.timeoutMs` | `4000` | 1–10,000 per request for Memory Whisperer, quality/claim/cluster review and response audit; Skill Whisperer uses its own 3-second budget, primer and dossier save use `peoplePrimer.timeoutMs`, and Safety Whisperer uses `safetyWhisperer.timeoutMs` |
| `skillWhisperer.enabled` | `true` with a `skills` corpus, else `false` | Needs appropriate host hook access; fixed 3-second total deadline; `false` opts out. An explicit `true` without a skills corpus logs a warning and stays inactive |
| `skillWhisperer.historyMessages` | `5` | Nonnegative integer; prior visible messages used for routing |
| `skillWhisperer.minScore` | `0.5` | 0–1, **local vector fallback only**, ignored for decision model shortlist admission |
| `skillWhisperer.cooldownTurns` | `10` | Legacy nonnegative integer, accepted for compatibility; no longer used |
| `skillWhisperer.recipeHash` | `"default"` | Non-empty label (trimmed) stamped on every skill routing exposure for A/B experiments; reported per arm by `memory-steward outcomes` (`byRecipe`, `--recipe`) |
| `memoryWhisperer.enabled` | `false` | Requires explicit approved non-skill corpora, decision model key and host hooks |
| `memoryWhisperer.corpora` | `[]` | Explicit known corpus names; required nonempty when enabled; no `all` or skills. `"extracted"` is accepted only when `extraction.enabled` and `extraction.publish` are both true; it then whispers published extracted facts, plus derived observations and crystals grounded in `extracted`. `"fleet"` is accepted only when `fleetCommons.enabled` is true; it then whispers cached Fleet Commons entries |
| `memoryWhisperer.mode` | `"v2"` | `"v2"`: decision-model recall gate + corpus router and grounded topic extraction (up to three topics), run in parallel within `min(2 s, timeoutMs / 2)`; never calls a query-model API. `"legacy"`: opt-in rollback to one query pair per turn from `api` (or deterministic local queries). See [Memory Whisperer](retrieval.md#memory-whisperer) |
| `memoryWhisperer.api.endpoint` | Empty | **Legacy mode only.** Optional query-model API URL; unset or empty uses deterministic local queries. Still accepted in v2 so existing configs load, but ignored there (one `query_api_ignored` startup log note). |
| `memoryWhisperer.api.apiKeyFile` | unset | **Legacy mode only.** Absolute path to a file containing the API bearer token. Missing credentials, timeouts, or API failures fall back to deterministic local queries before decision model judging. |
| `memoryWhisperer.mlx` | unset | Deprecated: old absolute `{pythonPath, modelPath}` values are accepted but ignored for upgrade compatibility. Remove after configuring `api`. |
| `memoryWhisperer.minUsefulness` | `0.5` | 0–1, minimum Noul yes-probability per candidate; explicit overrides are preserved |
| `memoryWhisperer.maxHints` | `3` | 1–3 |
| `memoryWhisperer.cooldownTurns` | `10` | 0–1,000; recently injected evidence |
| `memoryWhisperer.timeoutMs` | `5000` | 1–10,000 total whisper deadline, not just the provider timeout. v2 planning (gate + extraction) uses at most half of it |
| `memoryWhisperer.complementaryHints` | `false` | Optional extra redundancy judgment; does not expand retrieval or enable the feature |
| `memoryWhisperer.derivedObservations` | `true` | Within an enabled Memory Whisperer, also whisper fresh, citation-verified `deep_thought` syntheses (`verified_synthesis` entries, listed first in the same `<memory>` block) whose question matches the turn. Matching is local (no model call), limited to the turn's `deep_thought` audience and approved corpora, and a synthesis is retired as soon as any QMD collection it searched changes. A multiplexed (non group/channel) session without a verified sender has no audience, so `deep_thought` neither reads nor writes its cache there |
| `memoryWhisperer.derivedMaxHints` | `2` | `>= 0` verified syntheses whispered per turn (`0` = unlimited) |
| `memoryWhisperer.derivedMinTokenOverlap` | `0.45` | `0..1` minimum share of a stored question's meaningful tokens the turn must cover |
| `memoryWhisperer.derivedMinSharedTokens` | `2` | `>= 1` minimum shared meaningful tokens for a non-exact question match |
| `memoryWhisperer.brightness.recipe` | `"off"` | Reorders usefulness-qualified finalists: `"off"` (no lookup), `"actr_v1"` (decayed reads and delivered hits), `"outcome_v1"` (outcomes, core memories, and linked surprise), or `"emotion_v1"` (outcomes plus emotional salience). Memory Whisperer labels active arms `brightness:<recipe>` unless `recipeHash` is set. `memory_search` does not apply Brightness |
| `memoryWhisperer.brightness.weight` | `0.08` | `>= 0` score added per unit of normalized brightness (`-1..1`); `0` disables re-ordering |
| `memoryWhisperer.brightness.decayRate` | `0.5` | `> 0` `actr_v1` decay exponent per hour since each read or hit |
| `memoryWhisperer.brightness.lookbackDays` | `90` | `>= 0` evidence window in days (`0` = unlimited) |
| `memoryWhisperer.brightness.maxBoost` | `0.15` | `>= 0` absolute cap on the brightness adjustment |
| `memoryWhisperer.brightness.emotionDecayStretch` | `3` | `0..3`; `emotion_v1` multiplies the outcome decay constant by `1 + salience × emotionDecayStretch` |
| `memoryWhisperer.brightness.emotionMaxBonus` | `0.35` | `0..0.35` additive `emotion_v1` bonus at peak salience |
| `memoryWhisperer.crystalsEnabled` | `true` | Within an enabled Memory Whisperer, also whisper active Memory Crystals whose title and summary match the turn (`{ source: "memory_crystal:<id>", tier, title, summary, revision }` entries, after verified syntheses and before raw chunks). Local and read-only (no model call, never creates the database). Only `workspace` crystals or crystals of the turn's own audience qualify, and every corpus a crystal draws on must be in `memoryWhisperer.corpora`; stale STM crystals never match. Each whispered crystal is suppressed for `cooldownTurns` in that session, and its `hit_count` (STM → LTM promotion evidence) is bumped best-effort after the turn |
| `memoryWhisperer.crystalMaxHints` | `2` | `>= 0` crystals whispered per turn (`0` = unlimited) |
| `memoryWhisperer.crystalMinTokenOverlap` | `0.35` | `0..1` minimum overlap coefficient between the turn and a crystal's title + summary tokens |
| `memoryWhisperer.crystalMinSharedTokens` | `2` | `>= 1` minimum shared meaningful tokens for a crystal match |
| `memoryWhisperer.crystalLtmRankBoost` | `0.01` | `>= 0` additive rank boost for long-term (`ltm`) crystals: breaks ties without beating a clearly better `stm` match |
| `memoryWhisperer.recipeHash` | `"default"` | Non-empty label (trimmed) stamped on Memory Whisperer and `memory_search` recall-ledger exposures for A/B experiments; reported per arm by `memory-steward outcomes` |
| `expectationsWhisperer.enabled` | `true` | Appends an `<expectations>` block of open commitments, predictions, blockers, decision outcomes and todos that match the turn (channel, person, keywords, or a due/overdue date). Read-only on the agent's memory database; no model call. Workspace items (Captain's Log blockers, active people todos) are visible on every eligible turn; a channel or group item only inside that exact conversation (`provider` + account + native channel id), and a direct-message item only to that exact provider + account + sender. People-derived items surface only for an `active`, injection-enabled person. Surfaces beyond user turns follow `whispererTriggers` |
| `expectationsWhisperer.maxHints` | `5` | `>= 0` expectations per turn (`0` = unlimited); overdue first, then active blockers, due soon, person and channel matches |
| `expectationsWhisperer.cooldownTurns` | `10` | `>= 0` turns an expectation stays suppressed in a session after it is shown (`0` = no cooldown); one that becomes overdue resurfaces early |
| `expectationsWhisperer.dueLeadMs` | `86400000` | `>= 0` ms before its due time an expectation counts as `due_soon` (`0` = only overdue). Per-row `dueLeadMs` written by the Steward takes precedence |
| `expectationsWhisperer.maxPayloadChars` | `0` | `>= 0` characters for the whole block; entries are skipped, never sliced (`0` = unlimited) |
| `expectationsWhisperer.includeWorkspaceBlockers` | `true` | Surface every open workspace-audience blocker on each eligible turn, not only on turns whose channel matches it. Never widens a channel or group blocker beyond its own conversation |
| `safetyWhisperer.enabled` | `false` | Requires at least one scenario, decision-model credentials and host hooks; see [Safety Whisperer](#safety-whisperer) |
| `safetyWhisperer.historyMessages` | `6` | 0–20 earlier visible messages, whole messages only, for resolving follow-ups |
| `safetyWhisperer.timeoutMs` | `3000` | 1–10,000 total deadline (credential and request); the host hook timeout must exceed the slowest enabled whisperer |
| `safetyWhisperer.excludedChannels` | `[]` | Up to 500 `{ provider, accountId, channelId, name? }`, matched case-insensitively; skips every scenario there |
| `safetyWhisperer.scenarios` | `[]` | Up to 20; unique `id` of letters, digits, `.`, `_` or `-` |
| `safetyWhisperer.scenarios[].instructions` | Required | Up to 2,000 characters: what the scenario covers, with exclusions; sent to the configured decision endpoint |
| `safetyWhisperer.scenarios[].flaggedPrompt` | Required | Up to 2,000 characters, appended for matching unapproved requests; never sent to the decision endpoint |
| `safetyWhisperer.scenarios[].minProbability` | `0.4` | 0–1 minimum yes-probability that the current request is covered |
| `safetyWhisperer.scenarios[].approvedRequestors` | `[]` | Up to 500 `{ provider, accountId, senderId, name? }`; `senderId` must match exactly; skip this scenario for them |
| `safetyWhisperer.scenarios[].excludedChannels` | `[]` | Up to 500 channels where only this scenario is skipped |
| `safetyWhisperer.scenarios[].agentIds` | Unset (every agent) | Non-empty list limits the scenario to these agents when one config serves several; normalized like OpenClaw agent IDs (lowercase) |
| `safetyWhisperer.scenarios[].enabled` | `true` | Disabled scenarios are never sent to the decision endpoint |

## People

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `people.enabled` | `false` | Store, Slack identity observation, people tools; independent of injection |
| `people.whisperer.enabled` | `false` | Exact-identity prompt injection; requires people enabled |
| `people.whisperer.maxChars` | `1200` | 1–4,000; combined identity/preferences context limit even when injection is off; the identity blurb retains its independent 70-word ceiling |
| `people.todos.maxOpen` | `1000` | 1–10,000; bounded open data-quality todos with overflow accounting |
| `people.learning.enabled` | Follows People Whisperer | Private nightly learning and complete weekly validation; [configuration, migration and rollout](people-learning.md) |
| `people.learning.nightlySchedule` | `10 3 * * *` | Previous completed local day, all conversation types |
| `people.learning.weeklySchedule` | `0 4 * * 0` | Every assertion for people active in the completed local week, plus legacy bootstrap |
| `people.learning.agents.<id>` | Inherit | Per-agent opt-outs, schedules and timezone |
| `peoplePrimer.enabled` | `false` | Requires people enabled + explicit approved corpora; controls evidence primer and automatic save review |
| `peoplePrimer.corpora` | `[]` | Explicit configured non-skill evidence approvals; sessions means all indexed sessions |
| `peoplePrimer.hitsPerQuestion` | `30` | 1–40 vector results for each of five identity/interaction questions, before provider grading |
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
| `responseAudit.enabled` | `false` | Operator-only response evaluation; requires approved senders and decision model |
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
`forceFlushTranscriptBytes` (default 2 MiB). The plugin
plan has a fixed 20,000-token reserve floor and supplies its own prompts; custom
host `memoryFlush.prompt` / `systemPrompt` are not used by this resolver.

OpenClaw 2026.11.5 and later use the session model and its normal fallbacks
for flushes. If you previously set `memoryFlush.model` to keep flushes local,
check that the session model and fallbacks are local before upgrading. On older
hosts, the plugin still honors a configured flush model.

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
selectors are not audience ACLs. Per-feature decision model approvals constrain that
feature's remote processing, not general retrieval access. This is an agent/fleet
boundary, not multi-tenant authorization. Approve sources for the agent's audiences.

## Decision model data scope

| Feature | Evidence sent when explicitly enabled/approved |
| --- | --- |
| Skill selection | Bounded visible current/recent conversation + shortlisted skill names/descriptions; not skill procedures or source-path fields |
| Memory hints | v2: the budgeted conversation (whole current request and recent whole messages, up to 4,096 tokens and 24,000 bytes by default), evaluation time and approved corpus names go to the decision endpoint for the recall gate, corpus routing and topic extraction. Legacy: the visible conversation (up to 8,192 `o200k_base` tokens and 24,000 bytes) goes to the configured query API (when available). Decision model passage judging receives the whole current request and recent whole messages (up to 4,096 tokens and 24,000 bytes by default) plus one complete excerpt (up to 1,200 characters), corpus/source path, represented-message timestamps (or an extracted observation's date) and evaluation time per candidate, capped at the top 6 RRF-fused eligible passages from at most 10 BM25 + 10 vector candidates across the approved scope. All indexed sessions in approved corpora are eligible; `chatTypes` controls DMs. |
| Complementarity | Up to 4 already-qualified excerpts, shared by up to 6 directional redundancy checks per request |
| People primer | Person identity, agent name, and up to 4 approved retrieved excerpts with their source/session metadata per request (16,000 serialized state bytes); all indexed sessions eligible if approved, not just the current chat |
| Dossier save/draft review | Proposed blurb, person/agent names and 1–3 exact approved indexed evidence ranges, at most 6,000 characters total; existing dossier is not evidence |
| Chunk quality | Up to 6 complete chunks of at most 6,000 characters each, with source kinds (18,000 serialized state bytes per request); no conversation or source-path fields |
| Ordinary claim review | One proposed claim + up to 3 approved indexed ranges, at most 6,000 characters total |
| Cluster review | Up to 6 eligible complete sampled chunks, each at most 2,000 characters; conclusions only concern the sample |
| Response audit | Approved visible request/answer/context/feedback and bounded later response evidence, separated by assessment stage; optional current-index whole-short-document evidence from approved file corpora |
| Inside Out | Target human reply, nearest assistant text and bounded preceding visible history; channel-scoped speaker identity keys |
| Safety check | The complete current human message without OpenClaw's conversation-info header; the thread starter, replied-to message and channel messages since the last reply that arrived with it, which can include other people's names and message IDs; up to `historyMessages` earlier visible messages; and each eligible scenario's `instructions`. No sender, account or channel IDs from that header, approval lists or flagged prompts. A message wrapper Safety Whisperer does not recognize (anything other than Slack's) is sent whole, minus that header. |
| Standalone QMD query | Query, optional intent, selected excerpts, source paths and evaluation time; separate process/SDK credentials and collection scope |

Omitting tool-result/thinking/system fields does not remove their content if it
was quoted in ordinary visible text. Provider judgments are advisory; probability
or score is not proof. Enabling a feature approves only that feature's documented processing.


## My Turn

An optional advisor for group/channel conversations. Before an incoming-message
turn reaches the main model, the configured decision model (default `liquid/d1.2-ultra`
via `https://codex.unblocklabs.ai/v1/decisions`) judges whether this particular agent should
respond. It uses the agent's configured identity name (falling back to its ID),
the triggering message, and recent visible conversation text. The agent always
retains the final say; this does not prevent wakes or guarantee silence.

```json
{
  "myTurn": {
    "enabled": true,
    "historyMessages": 10,
    "channels": {
      "slack": { "enabled": true },
      "imessage": { "enabled": false }
    }
  }
}
```

- Default off. Once enabled, omitted providers are enabled. Each channel entry's
  `enabled` also defaults true. Keys are canonical lowercase OpenClaw provider
  IDs (`imessage`, not the `imsg` CLI name), not individual room IDs.
- The session key must confirm a group/channel. DMs (including threaded DMs),
  unknown or shared-main routes, and internal/inter-session input are skipped.
  On an opted-in non-user surface, the host must explicitly attest to external
  user input. Without a run ID, My Turn skips rather than duplicate a decision
  on prompt rebuilds.
- `historyMessages` is 1–50, default 10, **including the trigger**. Only
  host-confirmed human messages are sent, oldest first, with available sender labels.
  Assistant/agent/bot replies, internal/inter-session input, runtime carriers,
  context-excluded entries, tools, system messages, images and thinking are excluded.
  Human authorship requires host `__openclaw.senderIdentity.senderKind: "human"`
  or `senderIsOwner: true`; explicit bot/agent identity always wins over owner status.
  Text and the `user` role alone never establish human authorship.
  Content comes from the visible message body, never storage-only
  `__openclaw.upstreamUserText` replay prompts, for both the trigger and history.
- Opaque bundled channel history is omitted because it cannot be filtered reliably
  by author type. There are no separate Slack/iMessage history fetches. The decision model is told
  that agent replies are absent, so it must not treat their absence as proof that
  nobody answered a question.
- The trigger must match the newest transcript message and its host-confirmed
  human sender. If a host does not expose that metadata at prompt-build time,
  **My Turn skips the decision entirely**. The original message still reaches
  the agent normally; unknown authorship never becomes a silence hint.
- Enabling the feature opts in to external decision model processing of recent text
  from every enabled provider, including providers added later. Disable providers
  whose group conversations should not be sent. No other sessions are retrieved.
- One Noul asks whether the named agent should respond **now**, favoring directed
  requests, unanswered follow-ups, and expected contributions. Only a response
  probability `<= 0.2` emits this plugin context, without changing the human message:

  > Your internal Decision API determined that you probably don’t need to respond
  > to this conversation. If you agree, return exactly NO_REPLY. If it missed a
  > request or obligation directed at you, respond normally.

- Respond/uncertain results leave the prompt unchanged. The initial threshold is
  conservative, not a guarantee of classifier accuracy; evaluate it on real chats.
- Uses shared `decisionModel` credentials and enablement. Missing/unreadable key,
  exhausted credits, any HTTP/network error, invalid result, or timeout leaves the
  turn unchanged. No retries. The fixed **1.5-second total deadline** also covers
  credential lookup; a shorter `decisionModel.timeoutMs` can end the HTTP request sooner.
- Input has a conservative 24,000-token estimated budget. Oversized current
  messages skip inference rather than silently truncate the
  trigger. Whole older messages are included only while they fit.
- Prompt rebuilds reuse a run's decision. Newer runs, session teardown, or Gateway
  shutdown cancel pending work; late results cannot inject a hint into a newer run.
  Decisions are process-local and bounded, not persisted.
- Content-free outcome counts appear under `whisperers.myTurn` in
  `memory_diagnostics`. The hint is ordered before Safety Whisperer context.

Requires `hooks.allowConversationAccess: true` and prompt injection not disabled;
see [host controls](#host-controls). Host hook timeouts still apply. Messages
steered into an already-running turn do not rebuild its prompt and are not checked.

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
4. If none remain, no request is made. Otherwise one decision model request asks one
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
with no safety prompt. A decision model outage or missing key therefore turns the
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
| `missing_key` / `decision_disabled` | Could not check: no credential, or decision model disabled |
| `input_too_large` | Not checked: the current message exceeds the roughly 24k-token budget. It is never truncated; every eligible `flaggedPrompt` is added |
| `timed_out` / `failed` | Could not check: deadline, provider error or no usable answer |
| `partial_response` | Counted with `flagged`: some answers were unusable, and the confident matches were still added |
| `missing_identity` | Counted with the turn's outcome: the host passed no provider, account or sender ID |
| `cancelled` | The session ended or the Gateway stopped during the check |

Warnings include the outcome, error code, HTTP status and scenario count, never
message text; a missing key is logged once until it returns.
`memory_diagnostics` also reports `safety.active: false` with a `reason` when
settings or host controls prevent checks (`decision_disabled`,
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
    "maxContextTokens": 30000,
    "baselineMinInteractions": 20
  }
}
```

Defaults: disabled; daily cadence; at most 100 attempted reviews per run; estimated
30,000-token context budget, leaving room for questions under a 32k
state-plus-longest-question limit. `intervalMinutes: 0` makes inference manual-only;
local baselines still refresh daily and on Gateway startup when Inside Out is enabled.
`baselineMinInteractions` defaults to 20 (1–10,000) for each comparison population.
The shared `decisionModel` settings supply the decision endpoint, model, credentials, and request timeout.

**Enabling this approves sending visible human/assistant conversation text across
all retained channels to the configured decision endpoint (defaults to
`https://codex.unblocklabs.ai/v1/decisions` → OpenRouter `liquid/d1.2-ultra`).** System messages, tool bodies, thinking blocks,
known bots, delivery mirrors, and recognized automated inputs are omitted. The
state includes human identity keys for speaker attribution. Probabilities describe
expressed emotion, not intensity; several emotions can be present, and they need
not sum to one. High sadness need not mean the agent caused it.

Each request contains chronological visible `history` and a separate `target`
human reply. Both use visible message content, never storage-only
`__openclaw.upstreamUserText` replay prompts. Recognized transport envelopes are
unwrapped; ambiguous envelopes are excluded and break the history chain.
Existing grades remain cached; this does not automatically regrade historical
successes or retry oversized failures. Six Noul questions judge only `target.text`,
using history to interpret tone and speaker attribution. Short yes/no criteria define each emotion; subtle
emotion counts without requiring explicit emotion words. Raw tool-result messages
and tool-call blocks never enter either field; visible assistant text explaining a
tool's findings remains conversation text. New routes use the rubric
`emotion-presence-v2@<canonical-endpoint>`; `inside_out.model` stores the requested alias.

```bash
openclaw memory-emotions run --agent main
openclaw memory-emotions report --agent main --sender U123 --bucket week
openclaw memory-emotions export --agent main --emotion anger --min 0.8
openclaw memory-emotions run --agent main --retry
openclaw memory-emotions link-people --agent main
openclaw memory-emotions link-people --agent main --repair-identities
openclaw memory-emotions run --agent main --session SESSION_ID
openclaw memory-emotions export --agent main --session SESSION_ID
openclaw memory-emotions baseline-refresh --agent main
openclaw memory-emotions baselines --agent main --person PERSON_ID
openclaw memory-emotions baselines --agent main --person PERSON_ID --with-drift
openclaw memory-emotions export --agent main --person PERSON_ID --deviation-history
openclaw memory-emotions baseline-refresh --agent main --recompare
openclaw memory-emotions drift --agent main --flagged-only
openclaw memory-emotions drift --agent main --person PERSON_ID --recent-weeks 4 --anchor-weeks 6 --threshold anger=0.1 --level valence=off
```

**Intensity (absolute and relative).** The same decision request also asks one
anchored `0..3` Score question, `intensity` (0 calm/routine, 1 mild, 2 clear,
3 strong: a major milestone or deep grief/crisis, including quietly stated grief).
It is unsigned, so mixed joy+grief keeps its weight even when valence nets to ~0.
Additive columns on `inside_out` hold the expected score (`intensity`), its
distribution (`intensity_probs_json`), the separately versioned `intensity_rubric`
(`emotion-intensity-v1`) and derived `valence` (`joy - max(sadness, fear, anger,
disgust)`, backfilled for existing grades). The presence `rubric` is unchanged, so
per-person 6-emotion history and cached grades stay valid. Grades from before
intensity existed keep `intensity = NULL` (unknown, never 0); a missing or malformed
intensity answer never fails the six presence grades. `export` adds
`personal_intensity`: the absolute `0..3` level plus a one-sided upper-tail position
among that person's prior intensity grades (`intensityMean`, midrank
`intensityPercentile`, `intensitySpike = max(0, intensity - intensityMean)`), so a
stoic person's rare 2 reads as a spike while an expressive person's 2 is routine.

**Long-term drift ("boiling frog").** `drift` (read-only, no inference) compares
each person's recent window (default 3 weeks) with an anchored baseline of their
earliest stable weeks (default 4, each with at least `--min-weekly-samples`), never a
rolling window that would absorb a slow decline. Metrics: absolute valence and
anger from Inside Out, plus agent-directed frustration (max of Response Audit
annoyance/frustration) and dissatisfaction intensity when `response_results` lives
in the same store; audit sessions are attributed only when their graded replies name
exactly one person. Each entry reports `anchoredMean`, `recentMean`,
`absoluteDelta`, `recentAbsoluteLevel`, `rollingWeeklyDelta` (what a week-over-week
view would see), `weeksObserved`, `flagged` and `reason` (`anchored_drift` and/or
`sustained_level`). Every window, sample minimum and per-metric threshold is a flag;
`--threshold metric=off` or `--level metric=off` disables one. `baselines` still
prints its original array of weekly snapshots; `baselines --with-drift` prints
`{ baselines, intensity, drift }` instead: the weekly snapshots, each person's absolute
intensity profile and the flagged drift summary (the drift flags above apply only
with `--with-drift`). Drift is derived on demand, so
`purge --grades` (which also nulls intensity and valence) removes its inputs.

`run` handles backfill and new interactions through the same bounded pass. Repeat
it until `reviewed` and `failed` are zero to finish backfill. With automatic inference
enabled, Gateway startup also runs one pass, then repeats at the configured interval. Successful results are
cached; new interactions take priority over retries. Request failures retry after
an hour when the pass has remaining capacity, or immediately with `--retry`.
Oversized context failures require explicit `--retry`, for example after increasing
the context budget. Source read failures appear in the run's `errors` list.
Each agent's pass is guarded by a cross-process `WorkStore` lease (the
`inside_out_grade` row in `work_items`): a scheduled pass, a hot-replaced Gateway
instance and a manual `run` never overlap, and a lost lease fences out late writes.
Scheduled passes re-arm one interval after they **start**, so the configured cadence
holds even for long passes; a manual `run` keeps the existing schedule. A Gateway
stop aborts the pass and releases the lease without a strike.

`--session` limits `run`, `report`, and `export` to one exact session ID. For a
manual canary, keep `intervalMinutes: 0` and run/export that session; this still
requires `insideOut.enabled: true` and sends its eligible interactions to the configured decision endpoint.
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
records an error and nothing is uploaded. This is an estimate, not decision model's tokenizer.

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
Neither mode calls decision model or changes scores, timestamps, review IDs or checkpoints.
Unmatched identities stay null. Exports include `person_id` and `personal_deviation`.
`export` emits all matching rows as JSON, including errors. `report` averages
successful rows by human, UTC day/week, rubric, and model; counts are the denominator.
Both accept `--person`, `--session`, `--sender`, `--since YYYY-MM-DD`, `--emotion`, and `--min`. `--sender`
matches exact sender IDs across channels; use exported `human_key` for precise
account-specific analysis. These commands are read-only and never invoke decision model.

### Person-relative baselines and deviations

Inside Out keeps analytics beside PeopleSQL in the same `unblock-memory.sqlite`,
linked by its existing `person_id`. `person_emotion_baselines` holds one snapshot
per person, rubric, model and completed week; `inside_out_deviations` holds
individual assessments. They are separate from dossier fields, recognition blurbs
and searchable memory. PeopleSQL identities must already exist; Inside Out does not
create people or guess links. Statistics are per agent's retained grades, not
fleet-wide aggregates.

Weeks run Monday 00:00 UTC to the next Monday, with an exclusive end. Each stored
week keeps, per emotion, the exact sample count, sum, minimum and maximum, plus the
distribution in 0.01-wide bins (at most 101 values), so a snapshot stays small
however much history accumulates. Reports show weekly and cumulative sample counts,
mean, minimum, maximum, p10, median, p90 and the binned distribution; cumulative
values are computed from all earlier stored weeks when read. Means, minimums and
maximums are exact; quantiles use bin values. Completed empty weeks are logged with
zero weekly observations. Rubrics and models have separate populations.

For each graded reply, `personal_deviation` compares its raw probabilities to that
person's **preceding completed weeks**, excluding the reply's entire current week
and future interactions. Both cumulative history and the immediately preceding
week are reported. Each emotion includes:

- `delta`: signed difference from the person's exact baseline mean.
- `percentile`: empirical rank from 0 to 1 within 0.01-wide bins; grades in the
  same bin are ties and take the midpoint.
- `unusualness`: `abs(2 * percentile - 1)`, from 0 at the middle to 1 at the extremes.
  This is a rank-derived signal, **not a probability or emotional intensity**.

For example, a joy probability of 0.8 can be routine for someone whose prior grades
are consistently 0.8, and unusual for someone whose prior grades are 0.1. This does
not establish their personality, mental state, or the agent's quality. Counts below
`baselineMinInteractions` produce `insufficient_history` with null emotion metrics,
independently for weekly and cumulative comparisons. Unlinked people, missing or
future timestamps and failed grades have explicit statuses; they are never neutral
scores. Exports before the first local assessment show `not_compared`.

`run` refreshes snapshots after grading new replies. Both grading and daily local
refreshes update exact PeopleSQL links before aggregating or assessing new replies.
Historical aggregation runs in a worker thread and commits in short batches, so the
Gateway event loop stays responsive and other writers to `unblock-memory.sqlite`
wait for one batch at most, never a whole refresh. Gateway shutdown cancels an
active refresh; the next one resumes, and repeating a refresh never duplicates
records. The Gateway skips a refresh when nothing it reads (grades, links, people,
stored results, the current week or settings) has changed since its previous one.
People links are matched with a read, and only changed links are written, in short
batches. If the refresh after grading fails, `run` still returns its counts with a
`baselineError` (the Gateway logs a warning); saved grades are unaffected.
`link-people` also refreshes analytics. `baseline-refresh` does this without loading
transcripts, calling decision model, or requiring decision model credentials. `baselines` reads
weekly snapshots, newest first, with optional `--person`, `--since YYYY-MM-DD`
(weeks whose last day, a Sunday, is on or after that UTC date) and `--limit`
(1–1,000 weeks, default 100). It reads from one consistent snapshot, even while a
refresh is writing.

Snapshots always reflect the currently linked grades. A late historical grade, a
retry, a relink or removed identity evidence rewrites the affected week and every
later week of that population in place, and a population with no linked grades left
loses its snapshots; earlier revisions are not kept. A snapshot `id` addresses its
whole cumulative population, so returning to an earlier population restores the
earlier `id`.

Normal refreshes preserve an existing assessment of the same grade. Late historical
grades change snapshots but do not silently rewrite earlier comparisons.
Use `baseline-refresh --recompare` to append changed assessments after backfill,
identity or sample-policy changes; `export --deviation-history` includes the earlier
results and marks which match the current grade. Repeating an unchanged refresh
adds no duplicate records. A `future_time` assessment is redone automatically once
the reply's time has passed. Previously sparse assessments need explicit
re-comparison after backfill adds earlier history.

`computed_at` and `assessedAt` record when these calculations actually occurred.
A backfilled comparison uses retained evidence from earlier interaction weeks, but
does not pretend that evidence had already been graded at the historical send time.
Baseline calculation requires no additional model calls and changes no raw emotion
judgments, dossiers, prompt injection, clustering or memory creation.

### Deleting a person's emotion data

```bash
openclaw memory-emotions purge --agent main --person PERSON_ID
openclaw memory-emotions purge --agent main --person PERSON_ID --grades
```

`purge` deletes one person's weekly snapshots and their whole assessment history,
including assessments recorded while a reply was linked to them, and prints what it
removed. It makes no decision model calls.

- **Without `--grades`**, their raw grades stay, so the next refresh rebuilds
  current snapshots and assessments from replies still linked to them. Use this
  after correcting a misattributed identity.
- **With `--grades`**, it also erases the six probabilities of every reply currently
  linked to that person and unlinks it. Each row stays as a tombstone with the error
  `Purged by operator`, so `run` (including `--retry`) never sends that reply to the decision endpoint
  again, `link-people` never relinks it, and refreshes skip it. Purge refreshes
  People links first, so replies linked since the last refresh are included. It also
  scrubs emotion values derived from those replies: Captain's Log entries grounded on
  a purged message lose their salience fields (the log text stays), and Outcome Ledger
  rows in an affected session lose `insideOutValence`, `insideOutIntensity`,
  `insideOutDelta` and `sharpDrop` (verdicts stay); the counts are reported as
  `captainsLogEntries` and `outcomes`. Response Audit drift is attributed to a person
  only when every graded reply in the session is theirs and none was purged. This
  cannot be undone.

A refresh already running when `purge` commits rechecks every grade before writing,
so it cannot restore the purged data.

Purging removes existing data only. While Inside Out stays enabled and the person's
identity remains in PeopleSQL, their new replies are graded and start a new
baseline. Soft-deleting a person in PeopleSQL does not remove Inside Out data.

## Steward

The Steward is an embedded sub-agent with independent features (`deep_thought`,
People Learning, Captain's Log, the Outcome Ledger, Expectations, Memory Crystals and
Overnight Thinking), all **enabled by default**.
Fleet configs without a `steward` section load cleanly and automatically get every
feature; set `steward.enabled: false` (or disable any sub-feature individually) to opt out.

```json
{
  "steward": {
    "enabled": true,
    "deepThought": { "enabled": true },
    "peopleShadow": { "enabled": true, "intervalMinutes": 60, "maxItemsPerRun": 10 }
  }
}
```

- **`deep_thought` tool**: a read-only, multi-hop memory curator. It searches and
  reads with exactly the calling agent's corpora, request context and account
  (plus `lookup_person` when People is enabled), then returns one synthesis whose
  citations are kept only if the curator actually opened the cited source and the
  quote is grounded in the text that source returned. If the turn or tool budget
  runs out first, one final submit-only turn asks for the best cited answer from
  the evidence already gathered. It never writes to memory. Jobs persist in
  `unblock-memory.sqlite`, so a `jobId` stays collectible after a Gateway restart
  (orphaned running jobs become `cancelled`); a job can only be collected by the
  caller that started it (agent, session key, channel, account, sender and native
  channel). A complete answer with at least one verified citation, none dropped,
  and no `lookup_person` call (People dossiers can change without a collection
  generation change) is stored as a derived observation keyed by question,
  corpora and caller audience (agent + session key + provider + account, plus the
  requesting sender in any session that is not a shared group/channel conversation,
  so a DM answer is never served to another person even when `dmScope=main` shares
  one session key) and stamped
  with the QMD generation of every searched collection. A repeat question returns it
  instantly with `cached: true` until any of those collections changes; pass
  `fresh: true` to re-investigate. Reading those generations (which may wait on a
  cold index) counts against `syncWaitMs`, so a slow index still hands off a `jobId`
  on time. The same audience key is computed from the `before_prompt_build` hook
  context, so with `memoryWhisperer.derivedObservations` the Memory Whisperer can
  surface the synthesis on a later matching turn in that conversation. (v0.20.0
  changed the key: answers cached by earlier versions are simply re-investigated.)
- **People shadow**: a background, proposal-only reviewer of People Learning
  manifests. Verified proposals are stored only in `work_items`; dossiers, learning
  runs and cron jobs are never touched. Compare with the cron using
  `openclaw memory-steward shadow-report --agent main`; `memory-steward status`
  lists backlog and quarantined items, and `memory-steward requeue --scope <scope>`
  re-drives one item (`--kind people_interactions`, `captains_log`,
  `outcome_ledger`, `expectations`, `memory_crystals`, `overnight_thinking` or `steward_skills` for other work kinds). Leases are renewed during model calls; a
  Gateway stop releases them without strikes. On nightly manifests, interaction
  learning (`people_interactions`) also proposes net-new dossier claims; it is on by
  default in `publish` mode and off in `shadow` mode unless
  `includeInteractionLearning` is set. Each person's item is keyed on the evidence it
  reads (roster entry and session export fingerprints), so appending a learned claim
  to the manifest never re-learns an unchanged person; pause/opt-out is rechecked
  right before each model call, and an interaction-only person contributes only the
  claims Steward published to the manifest, never their verified dossier.
- **Captain's Log**: entries are also recorded in `captains_log_entries`. With
  `includeEmotionalSalience` (default on), human messages whose Inside Out grade is
  high-salience (joy or grief alike; `minSalienceScore`, `minAbsoluteIntensity`,
  `minRelativeIntensity`) reach Steward with a neutral cue such as `joy/milestone`
  (never a number), and an entry citing one stores `salience_score`,
  `emotional_intensity`, `relative_salience` and `salience_signals_json`; those
  columns are never rendered into `memory/YYYY-MM-DD.md`;
  `openclaw memory-steward blockers --agent main [--limit <n>]` lists open
  `[BLOCKED]` entries, newest first. `blockers` and `outcomes` open the database
  read-only and never create or migrate it.
- **Outcome Ledger**: a deterministic background pass (no model call, so it runs
  without a Steward credential) that scores each delivered memory hit, whispered
  skill and person whisper as `helped`, `ignored` or `hurt` from reads, skill opens
  and Response Audit outcomes, into `memory_outcomes`. Only an agent-attributed
  Response Audit `reported_shortfall` makes a turn negative (`hurt`, and
  `shortfallsPer100Turns`). The human's Inside Out reply is recorded as telemetry
  only (`insideOutDelta`, `insideOutValence`, `insideOutIntensity`, `baselineCount`,
  `sharpDrop` in `signals_json`): grief, bad news or a crisis says nothing about
  whether a recalled memory hurt. Rows that earlier versions marked `hurt` for a
  valence drop alone are restated idempotently on the next pass (`attributionRepair`).
  Memory candidates that were neither delivered nor read (`below_threshold`,
  `rank_limit`, `cooldown`, …) are not scored, so `whisperUsedRate` is used hits
  over delivered hits. Response Audit evidence is attached only when Response Audit
  is enabled, and only from its configured cohort. The first sweep covers
  `lookbackMs`; later sweeps resume from the watermark and re-score at most the
  previous two days (bounded by `lookbackMs`; tune with `lateEvidenceRescanMs`) to
  pick up late audit results and Inside Out grades. Every memory hit and skill route
  carries the `recipeHash` its whisperer was configured with (`"default"` unless set).
  `openclaw memory-steward outcomes --agent main [--since-hours <n>] [--recipe <hash>]`
  prints `whisperUsedRate`, `skillOpenRate`, `shortfallsPer100Turns` and per-recipe
  breakdowns.
- **Expectations** (the 6th primitive, memory of the future): an hourly pass that
  keeps one `expectations` row per open commitment, prediction, blocker,
  decision-outcome hypothesis or todo. It always mirrors open Captain's Log
  `[BLOCKED]` entries (recurring captures of one normalized topic collapse into one
  row that tracks every linked entry, and auto-expire after
  `blockerAutoExpireMinutes` without a fresh capture) and open, user-facing people
  todos (administrative todos such as `soft_delete_review` / `needs_enrichment`, and
  todos about a soft-deleted or injection-disabled person, are skipped), and resolves
  them as `kept` when their source resolves. This step needs no model and runs even
  without a Steward credential. With a credential it also extracts explicit
  commitments, predictions, blockers and decision outcomes from new sessions
  (excluding `excludeChatTypes`). Every conversation is its own audience — a channel
  or group as `channel|group:<provider>:<account>:<nativeChannelId>`, an opted-in DM
  as `direct:<provider>:<account>:<sender>` — and a session missing any of those
  parts is skipped, never pooled into `workspace`. Message timestamps go to the model
  so relative deadlines anchor to when they were said. A pass capped by
  `maxSessionsPerRun` resumes the unread sessions next time. It then sweeps open
  items that are overdue, due soon, older than `sweepAfterMinutes`, or whose own
  channel/group/DM conversation has new messages in this pass (activity-triggered:
  a reply in that conversation sweeps its items immediately; quiet conversations
  add no model call) against
  evidence from their own audience (workspace items: conversations whose chat type is
  in `workspaceSweepChatTypes`, default channels only)
  recorded since the item opened or was last swept, recording
  `kept`/`broken`/`right`/`wrong`/`expired` with a surprise score (a clock-only
  `expired` requires a due date that has passed). A swept Captain's Log blocker
  resolved `kept` or `expired` also closes its ledger entries. Right after each
  Captain's Log append (background or `memory-steward captains-log`, never a dry
  run), with `captainsLogDecisionResolve` and `decisionModel.enabled`, one batched
  d1.2 `choice` call checks every open `workspace`/`channel` expectation against the
  new entries (`still_open`/`resolved`/`broken`) and applies only explicit
  `resolved` (→ `kept`/`right`, surprise 0.1) or `broken` (→ `broken`/`wrong`,
  surprise 0.85) answers at `>= captainsLogResolveMinConfidence`, closing a mirrored
  blocker's ledger entries too. Group and DM expectations are never sent; a blocker
  whose topic the same pass re-captured as `[BLOCKED]` is never judged; no new
  entries or no candidates means no call; a failed check only logs a warning. The
  new blockers are then mirrored immediately. Open pre-0.20
  Steward rows whose audience cannot be proven (group/channel sessions pooled into
  `workspace`, DMs keyed without a provider) are retired as `dismissed`. `openclaw memory-steward expectations --agent main [--status <status>] [--limit <n>]`
  prints `{ agentId, summary, expectations }` read-only (an absent database is never
  created or migrated); add `--run` to run one pass for that agent now and print its
  result. A pass that is not due reports `not_due`; `memory-steward requeue --kind
  expectations --scope <agent>` makes it due immediately.
- **Memory Crystals** (STM/LTM synthesis and core memories): every
  `intervalMinutes`, the pass reads the QMD analysis clusters (reclustering missing
  or stale analysis first only when `analysis.executable` is configured and at most
  every `reclusterMinIntervalMinutes`), inspects every member of each cluster of at
  least `minClusterSize` chunks, and skips a cluster outright if any member comes
  from a corpus outside `allowedCorpora` or an unresolved collection (checked against
  every active collection holding the chunk, not only the displayed aliases).
  `allowedCorpora` is the only source of truth: the default `["memory", "knowledge"]`
  excludes session transcripts, and listing `"sessions"` (for example on a 1:1
  personal-assistant node) opts them in, so their syntheses become `workspace`
  crystals. After these checks, salience prioritizes evidence slots and gives
  clusters a small priority boost when the pass has a synthesis budget. The Steward model
  distills up to `maxMembersPerCluster` excerpts into one titled summary that cites
  only opaque handles; it is stored as a `workspace`-audience `stm` crystal in
  `memory_crystals` with its exact evidence chunks (document hash, chunk span, quote
  sha256) in `memory_crystal_members`. Unchanged evidence only re-verifies a crystal
  (no model call) and renews its `stmStaleAfterMinutes` window. A model failure on
  one cluster is reported in the pass's `errors` and never blocks the other clusters,
  promotion or decay (a missing credential stops further model calls for that
  pass). The pass and its memory index start only on a tick where it is due. When new evidence changes a crystal's summary, its revision is
  bumped and the evidence that was new to that revision is recorded once in
  `core_memories` (the shared `recordCoreMemory` writer). Without a model call, the
  same pass promotes an `stm` crystal to `ltm` after `ltmPromoteMinHits` whispered
  hits or `ltmPromoteMinHelped` `helped` outcomes on its member sources, and retires
  `stm` crystals not re-verified within `stmStaleAfterMinutes`. Without a Steward
  credential only decay and promotion run (and no recluster is attempted).
  `openclaw memory-steward crystals --agent main [--tier stm|ltm] [--limit <n>]`
  prints `{ agentId, summary, crystals }` read-only (counts by tier/status and
  core memories by kind; an absent database is never created or migrated); add
  `--run` to run one pass for that agent now, ignoring the schedule.
- **Overnight Thinking**: every `intervalMinutes` (optionally only inside the local
  `[quietHoursStartHour, quietHoursEndHour)` window, which may wrap midnight), one
  fenced pass runs three phases, each in the candidate's own audience and corpora:
  *Voltaire Drift* re-investigates (fresh `deep_thought`, cache bypassed) questions
  whose stored synthesis is behind its QMD collections or that recur at least
  `minRecurrence` times in `recallChatTypes` conversations, has the Steward model
  compare the old and new conclusions, and records real shifts at `>= minConfidence`
  in `voltaire_shifts`. Only a complete answer with at least one citation and no
  unverified citation is saved, compared or published, and the new derived
  observation supersedes the prior one inside the same fenced commit as the shift.
  Focused `deep_thought` observations are never re-investigated. A shift whose
  audience kind is in `dailyLogChatTypes` (default `workspace` and `channel`) and
  whose corpora are all in `dailyLogCorpora` (default `memory` and `knowledge`) also
  anchors one `voltaire_shift` row in `core_memories` and, with `writeDailyLogNotes`,
  appends a ❔ was / ✅ now note to `<workspace>/memory/YYYY-MM-DD.md`. By default
  `group` (MPDM) and DM shifts and shifts over `sessions` or `extracted` reach
  neither; add them to those lists to opt in. An audience's kind comes from every
  `recall_queries` chat type it was seen in (all of them must be listed), and an
  audience never seen in recall is never eligible. *Shortfall Post-Mortems* diagnose each new `hurt` Outcome Ledger verdict
  once into `shortfall_postmortems` (root cause plus one concrete fix).
  *Anticipatory Pre-Answering* investigates questions asked in the coming
  `lookaheadMinutes` weekday/hour slot on at least `minRecurrence` distinct days, so a
  verified answer already waits as a derived observation. Investigations need
  `steward.deepThought.enabled`; without it only post-mortems run.
  `openclaw memory-steward overnight --agent main [--limit <n>]` prints
  `{ agentId, summary, shifts, postmortems }` read-only (never creating a database);
  add `--run` to run one pass now, ignoring both the schedule and quiet hours.
- **Self-writing skills** (review-only): every `intervalMinutes` (default daily), one
  fenced pass per agent drafts `pending` rows in `skill_proposals` and **never
  writes a live `SKILL.md`**. The pass has three phases. *Description updates* cover
  skills with missed activations (opened without a whisper) or poor precision
  (whispered, then ignored or hurt). Each gets a candidate routing description, and
  only a candidate that beats the live one on a replay of real historical prompts
  through the production `scoreSkillCatalog` router (`decisionModel` credentials) is
  proposed. It must gain at least `minRecallGainPp` recall, add at most
  `maxFalseActivationPp` false activations and cause at most `maxCriticalRegressions`
  regressions, on at least `minPositivesEvaluated` positives, `minNegativesEvaluated`
  negatives and `minSamplesPerSkill` examples that were actually scored; otherwise the
  replay is `indeterminate`, never a pass. Labels are reconciled per skill and run
  first, so a `hurt` turn is a negative even when the skill was opened. *Pitfall patches* add grounded `## Pitfalls` bullets from at least
  `minPitfallEvidence` `hurt` outcomes and shortfall post-mortems, and every bullet
  must cite the supplied evidence; each `hurt` item carries the failing turn's redacted,
  bounded queries (from `allowedChatTypes` only). *New skills* draft complete `SKILL.md` files from
  procedural memory crystals (LTM, or a not-yet-stale STM crystal with `newSkillMinHits`
  hits or `newSkillMinBrightness`) that no catalog skill already covers. Every corpus a
  crystal cites must be in `allowedCorpora` and its audience in `allowedAudiences`.
  Only prompts from `allowedChatTypes` are replayed or quoted. Identical inputs are
  never re-sent to the model (a description input is keyed on the live file and the
  skill's own missed/imprecise exposures, so new unrelated prompts never re-open it),
  a replay lost to a scorer outage is retried on the next pass, and an operator
  rejection is never re-raised. Catalog skills outside every configured `skills`
  source are skipped before any model call, and without a `skills` corpus neither the
  pass nor `--run` runs.
  `openclaw memory-steward skills --agent main [--status <status>] [--kind <kind>] [--limit <n>]`
  lists proposals read-only (`--run` runs one pass now).
  `memory-steward skill-review <id> [--agent main] --approve|--reject [--by <name>] [--note <text>]`
  records the decision. `memory-steward skill-apply <id> [--agent main] [--dry-run] [--target-dir <dir>]`
  writes one **approved** proposal's file, atomically, and only where a configured
  `skills` source admits it: inside its root and matching its glob, both lexically
  and after resolving symlinks (symlinks and `..` cannot escape). An existing file must
  still match the SHA-256 it was drafted from, and a new skill is created with an
  atomic no-clobber link, so it never overwrites a file that appeared meanwhile. If
  the file already holds exactly the proposed bytes (an earlier apply crashed before
  recording it), the proposal is simply marked applied. Description rewrites keep a
  UTF-8 BOM and the file's line endings, replace a `|`/`>` block scalar whole, and must
  read back as the reviewed description; pitfall bullets never land inside fenced code.
  New skills land in `--target-dir` (default: the first skills root), which must
  itself be admitted by a skills source. `--dry-run` reads through a read-only
  connection.

| Setting | Default | Meaning / supported range |
| --- | --- | --- |
| `steward.enabled` | `true` | Master switch; set `false` to disable all Steward features |
| `steward.model` | `gpt-6.2-sol` | Responses model id |
| `steward.reasoning` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `steward.endpoint` | `https://codex.unblocklabs.ai/v1/responses` | HTTPS (or loopback HTTP) Responses endpoint without credentials, query or fragment |
| `steward.apiKey` / `steward.apiKeyFile` | Unset | Explicit Steward credential (`apiKeyFile` must be an absolute path). When unset, the `decisionModel` credential is reused **only** when both endpoints share an origin |
| `steward.maxActiveBackground` | `1` | `>= 1` concurrent background Steward passes per Gateway process |
| `steward.deepThought.enabled` | `true` | Registers `deep_thought` |
| `steward.deepThought.maxTurns` | `0` | `>= 0` model turns (`0` = unlimited); when `> 0`, a call's `maxHops` can only narrow it |
| `steward.deepThought.maxToolCalls` | `0` | `>= 0` tool calls per investigation (`0` = unlimited) |
| `steward.deepThought.maxConcurrent` | `0` | `>= 0` in-flight investigations per process (`0` = unlimited); when `> 0`, extra calls return `busy` |
| `steward.deepThought.timeoutMs` | `0` | `>= 0` ms wall clock per investigation (`0` = unlimited; caller cancellation still aborts) |
| `steward.deepThought.syncWaitMs` | `65000` | `>= 0` ms each `deep_thought` call waits synchronously before returning `{ status: "running", jobId }` while the investigation keeps running in the background (`0` = wait until completion) |
| `steward.deepThought.jobRetentionMs` | `1800000` | `>= 0` ms finished background `deep_thought` jobs remain collectible in memory (`0` = keep until process exit) |
| `steward.deepThought.wrapUpReserveMs` | `20000` | `>= 0` ms reserved before a finite `timeoutMs` expires to force a final wrap-up submission (`0` = disabled) |
| `steward.deepThought.reasoning` | Unset | Optional reasoning effort override for `deep_thought` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; defaults to `steward.reasoning`) |
| `steward.deepThought.maxToolResultChars` | `0` | `>= 0` characters per tool result returned to the model (`0` = unlimited) |
| `steward.deepThought.maxInputTokens` | `0` | `>= 0` client-side input tokens per model request (`0` = unlimited; retries are not double-charged) |
| `steward.deepThought.searchRanking` | `"retrieval"` | `"retrieval"` (fast local BM25 + vector hybrid RRF) or `"decision"` (decision-model reranking) |
| `steward.deepThought.searchMinUsefulness` | `0` | `0`–`1` minimum usefulness threshold when `searchRanking` is `"decision"` |
| `steward.deepThought.defaultSearchResults` | `10` | `>= 1` default results returned per `search_memory` call when the curator omits `maxResults` |
| `steward.deepThought.maxSnippetChars` | `0` | `>= 0` characters per `search_memory` snippet (`0` = unlimited) |
| `steward.deepThought.maxQuoteChars` | `0` | `>= 0` characters per citation quote (`0` = unlimited) |
| `steward.deepThought.maxPeopleMatches` | `0` | `>= 0` matches returned by `lookup_person` (`0` = unlimited) |
| `steward.peopleShadow.enabled` | `true` | Starts the background People Learning loop on Gateway start |
| `steward.peopleShadow.mode` | `"publish"` | `"publish"` (applies verified dossier updates & retires legacy people-learning crons) or `"shadow"` (proposal-only) |
| `steward.peopleShadow.intervalMinutes` | `60` | `>= 1` minutes between passes |
| `steward.peopleShadow.maxItemsPerRun` | `0` | `>= 0` model calls per agent per pass (`0` = unlimited) |
| `steward.peopleShadow.timeoutMs` | `0` | `>= 0` ms per item (`0` = unlimited) |
| `steward.peopleShadow.minConfidence` | `"medium"` | Lowest confidence (`"high"`, `"medium"`, `"low"`) that may mutate/verify a dossier in publish mode |
| `steward.peopleShadow.maxHandles` | `0` | `>= 0` evidence handles per packet (`0` = unlimited) |
| `steward.peopleShadow.maxExcerptChars` | `0` | `>= 0` characters per evidence excerpt (`0` = unlimited; an interaction packet that clips an excerpt never completes a person review) |
| `steward.peopleShadow.maxExportBytes` | `0` | `>= 0` bytes read per approved export file (`0` = unlimited) |
| `steward.peopleShadow.includeInteractionLearning` | Unset | Net-new claim discovery on nightly manifests; unset = on in `"publish"`, off in `"shadow"` |
| `steward.peopleShadow.maxNewClaimsPerPerson` | `0` | `>= 0` new claims published per person per manifest, highest confidence first (`0` = unlimited) |
| `steward.peopleShadow.maxInteractionHandles` | `0` | `>= 0` evidence handles per interaction packet (`0` = unlimited; a packet that drops excerpts never completes a person review) |
| `steward.peopleShadow.includeResponseAudit` | `true` | Annotate interaction excerpts with Response Audit outcome signals when available |
| `steward.captainsLog.enabled` | `true` | Starts the background Captain's Log distillation loop on Gateway start |
| `steward.captainsLog.intervalMinutes` | `180` | `>= 1` minutes between Captain's Log passes (a transient failure retries after at most 15 minutes) |
| `steward.captainsLog.lookbackMinutes` | `190` | `>= 1` minutes of recent session activity examined per pass, extended back to the last capture after a failed pass or downtime (deduplicated via watermark) |
| `steward.captainsLog.maxSessionsPerRun` | `0` | `>= 0` eligible sessions distilled per pass (`0` = unlimited) |
| `steward.captainsLog.maxCharsPerSession` | `0` | `>= 0` transcript characters per session (`0` = unlimited) |
| `steward.captainsLog.maxExistingLogChars` | `0` | `>= 0` characters from existing `memory/YYYY-MM-DD.md` passed for dedup (`0` = unlimited) |
| `steward.captainsLog.timeoutMs` | `0` | `>= 0` ms model timeout (`0` = unlimited) |
| `steward.captainsLog.excludeChatTypes` | `["direct"]` | Chat types (`"channel"`, `"group"`, `"direct"`) excluded from workspace `memory/YYYY-MM-DD.md` |
| `steward.captainsLog.includeEmotionalSalience` | `true` | Cue emotionally salient human messages (from Inside Out grades in the same database) to Steward, store the grounded salience privately in `captains_log_entries`, and rank high-salience entries right behind blockers. Missing or late grades never block a capture; `false` skips the lookup |
| `steward.captainsLog.minSalienceScore` | `0.7` | `0`–`1` salience score at which a graded message is cued as high-salience |
| `steward.captainsLog.minAbsoluteIntensity` | `2.2` | `0`–`3` Inside Out intensity at which a message is high-salience regardless of the person's history |
| `steward.captainsLog.minRelativeIntensity` | `1.5` | `0`–`3` absolute intensity a message needs before a person-relative spike counts, so a rare-but-trivial blip stays quiet |
| `steward.outcomeLedger.enabled` | `true` | Starts the deterministic Outcome Ledger loop on Gateway start (needs no Steward credential) |
| `steward.outcomeLedger.intervalMinutes` | `60` | `>= 1` minutes between passes |
| `steward.outcomeLedger.lookbackMs` | `604800000` | `>= 1` ms of history scored on the first sweep and used for Inside Out personal baselines; later sweeps resume from the watermark, re-scoring at most `min(lookbackMs, 2 days)` behind it for late evidence |
| `steward.outcomeLedger.maxRowsPerPass` | `0` | `>= 0` exposures scored per pass; a capped pass resumes from its cursor (`0` = unlimited) |
| `steward.outcomeLedger.matchWindowMs` | `1800000` | `>= 1` ms after an exposure during which use and outcome evidence may arrive |
| `steward.outcomeLedger.retentionDays` | `0` | `>= 0` days `memory_outcomes` rows are kept (`0` = unlimited) |
| `steward.outcomeLedger.lateEvidenceRescanMs` | Unset | `>= 0` ms re-scored behind the watermark each sweep for late Response Audit / Inside Out evidence (`0` = the full `lookbackMs`; unset = `min(lookbackMs, 2 days)`) |
| `steward.expectations.enabled` | `true` | Starts the Expectations loop on Gateway start; deterministic ingestion needs no Steward credential |
| `steward.expectations.intervalMinutes` | `60` | `>= 1` minutes between passes (a transient model failure retries after at most 15 minutes) |
| `steward.expectations.lookbackMinutes` | `70` | `>= 1` minutes of session activity read per pass, extended back to the last capture after downtime (deduplicated via watermark) |
| `steward.expectations.dueLeadMinutes` | `60` | `>= 0` minutes ahead of its due time an open expectation is swept (overdue ones always are) |
| `steward.expectations.sweepAfterMinutes` | `1440` | `>= 0` minutes after which an open expectation is swept even without a due date |
| `steward.expectations.maxSessionsPerRun` | `0` | `>= 0` eligible sessions read for extraction per pass (`0` = unlimited); unread sessions are picked up by the next pass |
| `steward.expectations.maxCharsPerSession` | `0` | `>= 0` transcript characters per session (`0` = unlimited) |
| `steward.expectations.maxSweepItems` | `0` | `>= 0` open expectations judged per pass (`0` = unlimited) |
| `steward.expectations.timeoutMs` | `0` | `>= 0` ms per model call (`0` = unlimited) |
| `steward.expectations.excludeChatTypes` | `["direct"]` | Chat types (`"channel"`, `"group"`, `"direct"`) excluded from session extraction |
| `steward.expectations.workspaceSweepChatTypes` | `["channel"]` | Session chat types (`"channel"`, `"group"`, `"direct"`) whose conversations are evidence when sweeping `workspace`-audience expectations; the default is the safe multi-user choice, a 1:1 assistant can add `"group"` and `"direct"` (those sessions must also not be in `excludeChatTypes`); `[]` = workspace items are never swept from sessions |
| `steward.expectations.extract` | `true` | Model-backed extraction from sessions; `false` keeps deterministic ingestion and sweeps only |
| `steward.expectations.sweep` | `true` | Model-backed due/resolution sweep; `false` never resolves rows by model |
| `steward.expectations.blockerAutoExpireMinutes` | `4320` | `>= 0` minutes a mirrored Captain's Log blocker stays open without a fresh capture of its topic before it auto-expires (closing its ledger entries); `0` = never auto-expire |
| `steward.expectations.captainsLogDecisionResolve` | `true` | After each Captain's Log append, close open expectations (matching `captainsLogResolveChatTypes`) its new entries explicitly resolve or break (batched d1.2 calls; needs `decisionModel.enabled`) |
| `steward.expectations.captainsLogResolveChatTypes` | `["workspace", "channel"]` | Expectation chat types (`"workspace"`, `"channel"`, `"group"`, `"direct"`) evaluated by the post-Captain's-Log d1.2 check; add `"group"` or `"direct"` to opt in |
| `steward.expectations.captainsLogResolveMinConfidence` | `0.85` | `0`–`1` minimum probability of the chosen `resolved`/`broken` option before the post-Captain's-Log check applies it |
| `steward.expectations.captainsLogResolveTimeoutMs` | `15000` | `>= 0` ms for the post-Captain's-Log d1.2 request (`0` = no plugin-side limit; the decisions SDK still caps one request at 60 s, and larger values are clamped to it) |
| `steward.crystals.enabled` | `true` | Starts the Memory Crystals loop on Gateway start; decay and promotion need no Steward credential |
| `steward.crystals.intervalMinutes` | `360` | `>= 1` minutes between passes |
| `steward.crystals.reclusterMinIntervalMinutes` | `720` | `>= 0` minutes between automatic reclusters |
| `steward.crystals.autoRecluster` | `true` | Recluster missing or stale analysis before synthesis (only with `analysis.executable` and a Steward credential) |
| `steward.crystals.minClusterSize` | `3` | `>= 1` minimum available chunks in a cluster |
| `steward.crystals.maxClustersPerRun` | `0` | `>= 0` synthesis model calls per pass (`0` = unlimited); unchanged, private or ineligible clusters never count |
| `steward.crystals.maxMembersPerCluster` | `12` | `>= 0` evidence excerpts sent per synthesis (`0` = the 50-member analysis page) |
| `steward.crystals.stmStaleAfterMinutes` | `20160` | `>= 0` minutes an `stm` crystal survives without re-verification (`0` = never retire) |
| `steward.crystals.ltmPromoteMinHelped` | `3` | `>= 0` `helped` outcomes on member sources that promote `stm` to `ltm` |
| `steward.crystals.ltmPromoteMinHits` | `5` | `>= 0` whispered hits that promote `stm` to `ltm` |
| `steward.crystals.allowedCorpora` | `["memory", "knowledge"]` | Corpora crystals may cite — the only source of truth, nothing else is hardcoded. The default excludes `sessions`; add `"sessions"` to opt session transcripts in (e.g. on a 1:1 personal-assistant node). Unresolved native `source-…` collections are never eligible |
| `steward.crystals.timeoutMs` | `0` | `>= 0` ms per model call (`0` = unlimited) |
| `steward.crystals.prioritizeEmotionalSalience` | `true` | Let high-salience (Flashbulb) evidence — the same `highSalience` gate Captain's Log cues on — take a bounded share (at most a quarter, at least one) of a cluster's member slots and nudge synthesis order. Representative members keep the remaining slots in native order, so a new grade cannot churn the crystal input. `false` sends the representative sample only and reads no salience |
| `steward.overnight.enabled` | `true` | Starts the Overnight Thinking loop on Gateway start (needs a Steward credential) |
| `steward.overnight.intervalMinutes` | `720` | `>= 1` minutes between passes |
| `steward.overnight.quietHoursStartHour` / `quietHoursEndHour` | Unset | `0..23`, set both or neither: run only inside `[start, end)` local hours (`22`/`6` wraps midnight; equal values = all day) |
| `steward.overnight.voltaireEnabled` / `postmortemsEnabled` / `preAnswerEnabled` | `true` | Toggle each phase |
| `steward.overnight.lookbackDays` | `30` | `>= 0` days of recall history and `hurt` outcomes considered (`0` = unlimited) |
| `steward.overnight.minRecurrence` | `2` | `>= 1` repeats for a recurring question, or distinct days for a pre-answer rhythm |
| `steward.overnight.lookaheadMinutes` | `720` | `>= 0` pre-answer window (`0` = every weekday/hour slot) |
| `steward.overnight.maxVoltairePerRun` / `maxPostmortemsPerRun` / `maxPreAnswersPerRun` | `5` / `5` / `3` | `>= 0` per-run caps (`0` = unlimited) |
| `steward.overnight.minConfidence` | `"medium"` | Lowest diff confidence (`high`, `medium`, `low`) that records a shift |
| `steward.overnight.recallChatTypes` | `["channel", "group"]` | `recall_queries` chat types mined for recurring questions; add `"direct"` to also re-investigate DM questions (kept in their own audience). Rows recorded without a chat type infer it from the session key: a `:direct:`/`:group:`/`:channel:` segment, `:dm:` (direct), or the untyped main DM session `agent:<id>:main` / `main` (direct); synthetic keys such as `:cron:` or `:subagent:` stay untyped and are skipped |
| `steward.overnight.saveDerivedObservations` | `true` | Persist complete investigations as derived observations for instant whispers |
| `steward.overnight.writeDailyLogNotes` | `true` | Append shift notes allowed by `dailyLogChatTypes` and `dailyLogCorpora` to `<workspace>/memory/YYYY-MM-DD.md` |
| `steward.overnight.dailyLogChatTypes` | `["workspace", "channel"]` | Audience kinds (`"workspace"`, `"channel"`, `"group"`, `"direct"`) whose Voltaire shifts may reach the daily log or an audience-less `core_memories` anchor; add `"group"` or `"direct"` to opt in |
| `steward.overnight.dailyLogCorpora` | `["memory", "knowledge"]` | Corpora a Voltaire shift must draw all of its evidence from to reach the daily log or an audience-less `core_memories` anchor; add `"sessions"` or `"extracted"` to opt in |
| `steward.overnight.timeoutMs` | `0` | `>= 0` ms per model call and per investigation (`0` = unlimited) |
| `steward.skills.enabled` | `true` | Starts the review-only self-writing skills loop on Gateway start (needs a Steward credential and a `skills` corpus) |
| `steward.skills.intervalMinutes` | `1440` | `>= 1` minutes between passes |
| `steward.skills.lookbackDays` | `30` | `>= 0` days of routing, opens, outcomes and post-mortems considered (`0` = unlimited) |
| `steward.skills.enableDescriptionOptimizer` / `enablePitfallPatches` / `enableNewSkills` | `true` | Toggle each phase |
| `steward.skills.minSamplesPerSkill` | `5` | `>= 0` labelled replay samples before a skill's description is optimized |
| `steward.skills.minRecallGainPp` / `maxFalseActivationPp` | `3` / `1` | `-100..100` percentage-point replay gates |
| `steward.skills.maxCriticalRegressions` | `0` | `>= 0` previously-routed positives a candidate may lose |
| `steward.skills.minPositivesEvaluated` / `minNegativesEvaluated` | `1` / `1` | `>= 0` successfully replayed positives / negatives before the recall / false-activation gates can pass; fewer (or fewer than `minSamplesPerSkill` evaluated in total) is `indeterminate`, never a vacuous pass (`0` = no minimum) |
| `steward.skills.maxReplayFailureRate` | `0.25` | `0..1` share of replay examples whose scorer judgment may fail before the replay is `indeterminate:scorer_failures`; a scorer outage leaves the input unattempted so the next pass retries it (`1` = tolerate any) |
| `steward.skills.maxDescriptionsPerRun` / `maxPitfallsPerRun` / `maxNewSkillsPerRun` | `3` / `3` / `2` | `>= 0` model calls per phase per pass (`0` = unlimited) |
| `steward.skills.maxReplayExamples` | `40` | `>= 0` positive + negative prompts replayed per candidate (`0` = unlimited) |
| `steward.skills.replayConcurrency` | `4` | `>= 0` concurrent replay judgments (`0` = all at once) |
| `steward.skills.replayTimeoutMs` | `0` | `>= 0` ms per replay judgment (`0` = the decision model's unbounded default) |
| `steward.skills.replayMinUsefulness` | Skill Whisperer threshold | `0..1` replay activation threshold |
| `steward.skills.minPitfallEvidence` | `2` | `>= 1` hurt outcomes + post-mortems before a pitfall patch is drafted |
| `steward.skills.maxEvidencePerSkill` / `maxEvidenceChars` / `maxSkillBodyChars` / `maxDescriptionChars` | `12` / `1200` / `8000` / `0` | `>= 0` model input and output budgets (`0` = unlimited) |
| `steward.skills.allowedCorpora` | `["memory", "knowledge"]` | Corpora every cited crystal member must come from; add `"sessions"` or `"extracted"` to opt in |
| `steward.skills.allowedAudiences` | `["workspace"]` | Crystal audiences allowed into new-skill mining (`"*"` = any) |
| `steward.skills.allowedChatTypes` | `["workspace", "channel"]` | `recall_queries` chat types (`workspace`, `channel`, `group`, `direct`, `unknown`) whose prompts may be replayed or quoted. Rows recorded without a chat type infer it from the session key (as `steward.overnight.recallChatTypes` does), else count as `unknown`; a run with any disallowed row is skipped whole. Every quoted prompt is redacted and bounded by `maxEvidenceChars` before the drafter or the replay scorer sees it |
| `steward.skills.newSkillMinHits` / `newSkillMinBrightness` | `3` / `0.75` | An STM crystal qualifies for new-skill mining at either threshold (LTM always qualifies) |
| `steward.skills.coverageMinOverlap` | `0.5` | `0..1` token overlap at which an existing skill already covers a crystal's theme |
| `steward.skills.timeoutMs` | `0` | `>= 0` ms per model call (`0` = unlimited) |

**Enabling `deep_thought` approves sending the question plus the memory excerpts it
opens to the Steward endpoint. Enabling the People shadow approves sending one
dossier assertion and up to 16 approved, account-fenced excerpts per item. Enabling
Expectations extraction or sweeps approves sending eligible session excerpts (one
audience per request) and the open expectations of that audience. Leaving
`captainsLogDecisionResolve` on approves sending each new Captain's Log section's
entries plus the open workspace/channel expectations (never group or DM ones) to the
`decisionModel` endpoint. Enabling Memory Crystals approves sending up to
`maxMembersPerCluster` workspace memory excerpts per cluster; enabling Overnight
Thinking approves `deep_thought` investigations of recurring questions in their own
audience, sending both conclusions to compare, and sending each `hurt` outcome's
subject and signals. Leaving self-writing skills on approves sending each candidate
skill's `SKILL.md`, its missed or falsely-activated request prompts (from
`allowedChatTypes` only), its `hurt` outcome signals and post-mortems, and eligible
crystal titles, summaries and source paths to the Steward endpoint. It also approves
replaying those prompts against both descriptions through the `decisionModel`
endpoint.** Both
features call `steward.endpoint` directly (`stream: false`, `store: false`) with
OpenAI strict JSON schemas; the host LLM runtime is not used, because it denies
plugin model overrides by default and would ignore the Steward endpoint and key.
Transient failures (HTTP 408/429/5xx, interrupted streams, connection resets) are
retried a bounded number of times; context overflow and HTTP 400/401/403 are not.
Outbound prompts and tool results are scanned for bearer tokens and common API key
formats before they are sent. A People shadow pass stops early on credential,
rate-limit or provider outages; an item that keeps timing out strikes toward quarantine.

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
