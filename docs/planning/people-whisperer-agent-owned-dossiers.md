# People Whisperer: Agent-Owned Dossiers

Status: implemented direction
Date: 2026-08-31

## Goal

Give an OpenClaw agent useful context about the person speaking before it has to
search memory, while keeping maintenance on autopilot and outside the interactive
path.

People Whisperer has one small boundary:

- PeopleSQL stores people, exact identities, dossiers, and injection receipts.
- The agent decides whom to investigate, what evidence matters, and whether to
  replace a dossier.
- Exact Slack identity matching injects `dossier.blurb` at most once per person
  per Slack thread.

The plugin is a store, matcher, and injector. It is not a dossier workflow engine.

## Product rules

1. `(Slack account ID, Slack sender ID)` must resolve exactly to one person.
2. `dossier.blurb` is the only injected person snippet.
3. Injection is deduplicated by `(Slack thread, person)`. Three distinct people
   speaking in one thread may therefore produce three whispers.
4. The same person may be injected again in a different thread.
5. Unthreaded Slack DMs use their OpenClaw session as the conversational scope.
6. Receipts are durable across retries and Gateway restarts. A retry of the same
   run receives the same contribution; a later run in the same thread does not.
7. Unknown, unavailable, archived, injection-disabled, or dossierless people do
   not produce a whisper.
8. New people are injection-enabled by default. The agent can disable injection
   for one person without disabling the plugin.
9. Dossier creation and maintenance are ordinary agent actions. They do not
   depend on owner authorization or a plugin-owned model runner.

The inbound hook records available Slack identity and thread information. Prompt
construction uses the matching run/session context supplied by OpenClaw. This
design does not assume that `message_received` always supplies a run ID.

## Agent-facing surface

When `people.enabled` is true, the normal tool surface includes:

- `memory_people_inspect({ view: "people", limit? })` to list active people with
  identities, `lastSeenAt`, dossier presence, and optional dossier `reviewedAt`;
- `memory_people_inspect({ view: "person", personId })` or exact Slack identity
  to read one person and current dossier;
- `memory_people_inspect({ view: "dossier_changes", personId, limit?, offset? })`
  to page through small newest-first change summaries, and `view: "dossier_change"`
  with a `changeId` to read one exact before/after snapshot and reason;
- `memory_people_inspect({ view: "todos", limit? })` for actionable data-quality
  todos;
- `memory_people_update` actions `replace_dossier`, `delete_dossier`,
  `set_injection`, `set_company`, `resolve_todo`, `soft_delete_person`, and
  `restore_person`; and
- optional `memory_people_sync` to enrich people from one configured Slack
  directory account.

`replace_dossier` writes a complete validated replacement and `delete_dossier`
removes one. Both require a short reason. Each mutation and its audit entry commit
in one transaction; the stored before/after dossier snapshots include the injected
`blurb`. Serialized dossiers are capped at 64 KiB. The last successful agent write
wins. `reviewedAt` is generated write metadata, not a cursor, due date, or freshness
policy.

## Agent-owned maintenance

The agent chooses people and evidence using the tools it already has:

1. List or inspect people when useful.
2. Search configured memory and sessions with `memory_search`.
3. Follow useful `qmd://` results with `memory_get`.
4. Compare the evidence with the current dossier.
5. Replace the dossier only when the new version would materially improve a
   future conversation. It is valid to update several people or nobody.

The dossier may retain claim-level evidence references and provenance. Those
references explain claims; they are not processed-event receipts and do not
control future work.

The plugin deliberately has no maintenance ledger, scheduling state, or review
acknowledgement. It also does not create or schedule cron jobs. An operator may
give an isolated cron agent this goal:

```text
Use $people-whisperer to improve your understanding of people you interact with.

Search recent sessions and memory for meaningful information about people. Inspect
their existing PeopleSQL dossiers when useful. Update a dossier only when doing so
would make future conversations meaningfully better. Ignore routine conversation,
repetition, and weak inference. You may update several people or nobody.
```

No deterministic coverage guarantee is required. Dossiers are maintained
understanding, not an event-processing ledger.

## Out of scope

- plugin-owned scheduling or model execution;
- QMD person attribution;
- per-person clusters or graph storage;
- automatic claim arbitration or confidence math; and
- owner approvals, leases, or scheduled-run authorization wrappers.

The intended end state is deliberately small: **the agent owns PeopleSQL; the
plugin stores, matches, and injects.**
