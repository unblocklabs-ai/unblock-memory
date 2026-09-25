# People dossiers and whispering

[Overview](../README.md) · [Configuration and credentials](configuration.md)

PeopleSQL stores identity, dossier and change history. The agent authors a brief
recognition snippet; People Whisperer injects only its saved blurb. Enable the
store with `people.enabled`; enable injection separately with
`people.whisperer.enabled`. The optional `peoplePrimer` approves evidence preparation
and automatic save review, not a maintenance scheduler. For independent setup
examples, see the [configuration profiles](configuration.md#example-profiles).

## Optional People Dossier Primer

`memory_people_prime({ personId, agentName? })` prepares evidence for an existing person;
it does **not** generate claims, update dossiers, or inject context. With
`people.enabled: true`, opt in separately:

```json
{
  "peoplePrimer": {
    "enabled": true,
    "corpora": ["memory", "knowledge", "sessions"],
    "hitsPerQuestion": 30,
    "minScore": 0.35,
    "minUsefulness": 0.8,
    "maxEvidencePerQuestion": 3,
    "timeoutMs": 30000
  }
}
```

This is a plugin config fragment. List only configured, approved non-skill corpora. The feature is **off by
default** and requires shared TypeSafe credentials. Disabled TypeSafe or missing/
unreadable credentials safely skip the primer; agents can still research normally.
Enabling it approves sending the person's identity, retrieved excerpts and optional
draft snippet to TypeSafe. Existing dossiers are not sent as grading evidence.
Sessions includes all indexed conversations;
results are available to the agent's tool callers, so scope approval accordingly.
Primer and dossier-save requests use `peoplePrimer.timeoutMs`, not
`typesafe.timeoutMs`; the total tool deadline is two minutes.

Three default questions cover explicit role/organization, enduring organizational
background, and the person's relationship to the agent (not its business mission).
Preferences, working styles, priorities, feedback and task history are excluded.
Each uses QMD vector search (no query expansion) for up to 30 hits, configurable
up to 40. All unique eligible hits above the vector threshold are graded, not just
the final top three. Complete excerpts over 6,000 characters are counted and skipped,
not silently truncated. Duplicate source spans across questions share a request;
Independent attribution, explicit-background, durability, recognition-value and
question-usefulness judgments run together; every dimension must pass the threshold.
Every candidate is graded against all three questions, regardless of which search
found it. Mixed excerpts may supply a useful background fact without making their
surrounding behavioral content eligible for the snippet.
Provider concurrency is four, with a two-minute overall tool deadline.

Supply the agent's human-facing name when no identity name is configured; otherwise
questions use "the assistant", never an internal routing ID such as `main`.
The output includes a deduplicated source-linked excerpt list referenced by each
question's evidence IDs, a bounded uncertain-review shortlist,
and retrieval/cache/failure counts. Coverage is `evidence_found`, `uncertain` or
`unknown`, not a claim that a question has been definitively answered. Partial
provider failures are explicit; absence of selected hits does not prove absence of
evidence. The agent must verify dates, speakers and contradictions before writing.
Memory evidence never grants permissions or establishes that an old request is
still open.

`memory_people_update({ action: "replace_dossier", personId, dossier, reason,
agentName? })` automatically checks the proposed blurb before saving. Exact
`qmd://path#Lstart-Lend` claim evidence locators supply up to three indexed ranges
from the primer's approved corpora (120 lines each, 6,000 characters total).
Support confidence and background-only/explicit-support probabilities must all
be >=0.9. `needs_review` or `review_unavailable` leaves the dossier and history
unchanged; missing keys and failures never count as approval. A concurrent dossier
edit/deletion returns `conflict` instead of overwriting the newer change.

After independently verifying every assertion and background eligibility, an agent
can supply a source-specific `manualVerification` explanation (up to 400 characters)
for direct human corrections, non-indexed evidence or disabled/unavailable/incorrect
reviews. This explicit path skips TypeSafe, records manual provenance in change
history and keeps all structural limits. It is not a provider pass. Normal success
returns `status: "ok"`, `saved: true` and `verification: "typesafe" | "manual"`.
The skill documents when to use each path. Sources outside approved corpora are
rejected before egress; no separate `evidenceReview` toggle is needed.

For optional read-only diagnostics, `memory_people_prime({ personId, agentName?,
draft: { blurb, citations: [{ path, from, lines }] } })` still reviews a snippet
without writing. Agents do not need this extra call in the normal update workflow.

Judgments are cached privately in `unblock-memory.sqlite` (maximum 2,000 entries), keyed
by person, agent, exact evidence/context, questions,
and judge version. No source text or credentials are stored in the cache.
Retrieval reruns against the current index; unchanged judgments are reused.
This is on-demand preparation, not a new scheduler or incremental session scanner.
Use it from an existing People Whisperer maintenance cron. Refresh stale session
indexes with `memory_sync_sessions` before priming when needed.

## People store and maintenance

PeopleSQL is an optional agent-local people store. When `people.enabled` is
true, incoming Slack messages with a canonical agent session key and exact
account and sender IDs create or refresh an injection-enabled person record.
Incomplete Slack identities create a bounded, deduplicated todo without storing
message content. Other channels are ignored.

PeopleSQL registers these tools when enabled:

- `memory_people_inspect` lists active people, reads one exact person, reads one
  person's dossier change history, or lists bounded actionable todos;
- `memory_people_update` replaces or deletes dossiers, toggles one person's
  injection, and manages company, todo, deletion, or restoration state;
- `memory_people_prime` prepares evidence when the separately opted-in primer is
  enabled, otherwise returns disabled; and
- the optional `memory_people_sync` enriches one active OpenClaw Slack account;
  its tool input accepts an account ID, not a token.

The inspect and update tools are part of the normal agent tool surface; they do
not depend on sender-owner authorization. Directory sync remains optional and
may need to be allowed explicitly through `tools.allow`. The sync is bounded to
200 normalized directory entries per call and is safe to rerun. Unblock Memory
keeps normalized ID, name, handle, avatar, bot and deactivation fields. Slack requires the
`users:read` scope. Each invocation starts at the beginning of the directory;
there is no caller-visible continuation cursor. Repeating a capped call does not
guarantee coverage beyond 200 entries, and sync does not reactivate unavailable people.

The agent owns dossier generation and refresh. It can list people, inspect one
person's current dossier, search ordinary memory and sessions with
`memory_search`/`memory_get`, and replace the dossier when that would improve a
future conversation. The plugin owns no dossier-maintenance workflow or refresh
schedule. A dossier's `reviewedAt` value records its last successful write; it
is not scheduling state. Dossier generation belongs to the agent; prompt injection
performs no model call. The optional primer grades evidence and reviews draft snippets.
The goal is recognition, not a behavioral profile: one short paragraph of at most
70 words identifying the person and their enduring organization/agent relationship.
New writes allow only `role`/`relationship` sections and explicit `observed`/`reported`
claims; priorities, preferences and inferred profiles belong outside dossiers.
Legacy dossiers remain readable, but must be deliberately rewritten by the agent
before replacement. No automatic destructive migration or blanket deletion occurs.

Every `replace_dossier` and `delete_dossier` action requires a concise `reason`
(up to 500 characters for replacements, 1,000 for deletions). Replacement history
also records whether TypeSafe checks passed or a manual attestation was used.
The plugin transactionally records that reason with its authoritative before and
after dossier snapshots. List small newest-first summaries with
`memory_people_inspect({ view: "dossier_changes", personId, limit?, offset? })`,
then fetch one exact diff with
`memory_people_inspect({ view: "dossier_change", personId, changeId })`. List
responses include `nextOffset`, so all history remains reachable without loading
many dossiers into one tool result. Because the injected snippet is the dossier's
`blurb`, its changes are included in the same history. A complete new serialized
dossier is capped at 64 KiB; larger legacy dossiers remain readable and repairable.

## Injection and person state

Set `people.whisperer.enabled` to inject context. For each exact Slack sender,
the plugin appends that person's stored dossier blurb inside `<people>` in the
shared `<unblock_memory>` block, after memory and skill hints when present. The
blurb is bounded by `maxChars` and injected
once per `(Slack thread, person)`. Receipts are durable across retries and
Gateway restarts, while different people in one thread are handled independently.
Unthreaded DMs use their OpenClaw session as the conversational scope. Unknown,
unavailable, disabled, or dossierless people produce no context. Injection
remains subject to OpenClaw's `allowPromptInjection` policy.

The package includes a `$people-whisperer` skill with the canonical agent
procedure and dossier shape. For a manual refresh, ask:

```text
Use $people-whisperer to maintain this person's brief background snippet.
```

For an optional cron or isolated agent session, use this goal:

```text
Use $people-whisperer to maintain brief background snippets for people you interact
with. Follow the packaged skill, including source verification and write results.
Update only when useful; several people or nobody is fine. Report changes and gaps.
```

Choose any cadence appropriate for the agent; the plugin does not require or
track one. If session transcripts are a source, configure a `sessions` corpus
(including `direct` when DMs matter) and refresh it with
`memory_sync_sessions`. Ordinary `memory_search` calls accept targeted queries,
corpora, session metadata filters, score thresholds, and up to 20 results per
call; People Whisperer itself imposes no evidence-window limit.

### Pause, correct, delete or restore

| Action | Effect | Preserved / follow-up |
| --- | --- | --- |
| `set_injection` with `enabled:false` | Pause future injection for this person | Person, dossier and history remain |
| `replace_dossier` | Save a verified full replacement | Prior snapshot/reason remain in history; existing thread receipts are not reset |
| `delete_dossier` | Remove the current dossier | Person and transactional before/after history remain; no new blurb injection |
| `soft_delete_person` | Mark unavailable and turn injection off | Identity/dossier/history remain; creates a review todo |
| `restore_person` | Mark active again | Injection stays **off**; inspect and explicitly re-enable if appropriate |
| `set_injection` with `enabled:true` | Enable the person-level injection gate | Still needs global whispering, host permissions, a dossier and an unserved thread |

Slack deactivation marks the **whole linked person** unavailable and disables
injection, even when other identities are linked. Directory sync skips unavailable
people rather than automatically restoring them.

Tool inputs for a deliberate pause and later restore/re-enable, using an actual ID:

```json
{ "action": "set_injection", "personId": "PERSON_ID", "enabled": false }
```

```json
{ "action": "restore_person", "personId": "PERSON_ID" }
```

`restore_person` is for an unavailable person, not a paused active person. After
inspection, use `set_injection` with `enabled:true` for either one when wanted.
None of these operations erases raw memory or dossier history.

`memory_people_inspect`'s `injectionEligible` and `contribution` are a
**record-level preview**, not proof that a hook will inject: they do not account
for the global whisperer switch, host permissions or an existing thread receipt.
Changing a dossier or restarting the Gateway does not re-inject it in an already
served thread. A same-run retry replays its saved contribution; a different thread
can receive the current blurb. Do not delete receipts as routine troubleshooting.

For agent research/write steps and the dossier schema, use the packaged
[People Whisperer skill](../skills/people-whisperer/SKILL.md). If the agent has a
skill allowlist, include `people-whisperer`. General [search and session filtering](retrieval.md)
are shared memory features, not people-specific controls.
