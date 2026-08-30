# People Whisperer: Agent-Owned Dossiers

Status: scoped for implementation  
Date: 2026-08-30

## Goal

Make People Whisperer an agent-owned memory system rather than an owner-administered
database.

When People Whisperer is enabled and an inbound Slack sender can be matched exactly to a
PeopleSQL identity, the plugin injects that person's stored dossier blurb at most once in
that Slack thread. Each person is deduplicated independently, so three people speaking in
one thread can produce three whispers.

The OpenClaw agent may inspect and update its people memory from ordinary turns, cron
runs, or isolated sessions. The plugin stores, validates, matches, and injects; it does not
decide whether the current Slack sender is allowed to let the agent remember.

## Product rules

1. Exact Slack identity is the trigger: `(account_id, sender_id)` resolves one person.
2. `dossier.blurb` is the injected snippet. There is no second snippet artifact.
3. Injection is deduplicated by `(Slack thread, person)`, not by agent session.
4. The same person may be injected again in a different thread.
5. A person-level `injection_enabled` preference remains in PeopleSQL. This lets the agent
   suppress one person's whispers without disabling People Whisperer globally.
6. `injection_enabled` defaults to `true` for newly observed people. The agent may set it
   to `false` at any time.
7. The agent owns dossier generation and refresh. The plugin does not invoke Codex or
   another model to author dossiers.
8. People tools rely on the configured agent tool surface, not `senderIsOwner`.

## Authorization by removal

### Remove

- Every `ctx.senderIsOwner` check from `memory_people_inspect`,
  `memory_people_update`, and `memory_people_sync`.
- The `refinement_enabled` person property and its policy machinery.
- The plugin-owned Codex refinement runner.
- The `people refine` CLI command.
- `people.refinement.maxPeoplePerRun`; the cron prompt owns its batch limit.
- Owner-specific tool descriptions and tests.

### Keep

- The global `people.enabled` feature toggle.
- The global `people.whisperer.enabled` injection toggle.
- The global `people.whisperer.maxChars` bound.
- The per-person `injection_enabled` preference.
- Dossier schema validation and transactional writes.
- Person status (`active`, `unavailable`, or `archived`).

This leaves two legitimate controls:

- disable People Whisperer globally;
- disable injection for one person.

Neither control depends on who caused the current agent turn.

## Agent-facing tools

### Tool availability

When `people.enabled` is true:

- `memory_people_inspect` and `memory_people_update` are normal, non-optional agent
  tools;
- `memory_people_sync` has no owner check, but may remain optional because directory sync
  is a separate external capability rather than a normal memory operation.

No OpenClaw core change is required. Isolated cron jobs can use the same tools through
their normal `toolsAllow` surface.

### Dossier replacement

Add this `memory_people_update` action:

```ts
{
  action: "replace_dossier";
  personId: string;
  dossier: PersonDossier;
  consumedEvidenceLocators?: string[];
}
```

The agent reads the current dossier, produces a complete replacement, and writes it. The
plugin retains data-integrity checks only:

- valid dossier schema;
- bounded non-empty blurb;
- unique section categories;
- transactional dossier and evidence-state update.

There are no owner tokens, leases, approval records, or scheduled-run authorization
wrappers. The last successful agent write wins.

Optionally add:

```ts
{ action: "delete_dossier"; personId: string }
```

Deleting a dossier means there is no current reliable snippet to inject. It does not
delete the person or their identities.

### Per-person injection preference

Keep the existing policy operation, narrowed to one meaningful preference:

```ts
{
  action: "set_injection";
  personId: string;
  enabled: boolean;
}
```

Remove `set_policy` and `refinementEnabled`. The agent can call `set_injection` from any
allowed turn.

## Thread-person injection

The current implementation deduplicates with an in-memory `(session, person)` map. Replace
that with exact Slack-thread deduplication.

### Resolve the thread

The `message_received` hook already receives `runId`, `threadId`, `messageId`,
`conversationId`, and `senderId`. Associate the inbound `runId` with this thread key:

```text
slack:{accountId}:{conversationId}:{threadId ?? messageId}
```

For channel threads:

- the root message uses its own Slack `messageId`;
- replies use the root `threadId`;
- both values are the same Slack root timestamp.

For an unthreaded Slack DM, use the OpenClaw session as the conversational scope rather
than treating every DM message as a new thread.

The `before_prompt_build` hook uses `runId` to recover the inbound thread identity, then
performs the exact person lookup and injection.

### Durable injection receipts

Add a small PeopleSQL table:

```sql
CREATE TABLE person_whisper_receipts (
  thread_key TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  contribution TEXT NOT NULL,
  injected_at TEXT NOT NULL,
  PRIMARY KEY (thread_key, person_id)
);
```

Behavior:

- same thread, same person, same run: replay the stored contribution for model retry;
- same thread, same person, later run: inject nothing;
- same thread, different person: inject that person's blurb;
- same person, different thread: inject again;
- unknown identity: inject nothing;
- `injection_enabled = false`: inject nothing;
- missing or empty dossier blurb: inject nothing and create no receipt.

The receipt is durable so Gateway restarts and `/reset` do not repeat whispers in an
existing Slack thread. Once receipts replace session-scoped state, remove the People
Whisperer `session_end` cleanup.

## Agent-owned refresh workflow

Extend `memory_people_inspect` with:

```ts
{ view: "refinement_next"; evidenceLimit?: number }
```

It returns one active person with unprocessed evidence:

- person and Slack identities;
- current dossier;
- bounded unseen interaction windows;
- stable evidence locators.

Evidence windows should contain the person's exact-attributed message plus nearby
conversation turns, especially the agent response and outcome. They replace the current
latest-20 isolated-message selector.

Track processed evidence by exact `(person_id, source, locator)` receipts rather than a
wall-clock `reviewed_at` comparison. This prevents late-imported evidence from being
silently skipped.

A cron agent runs this loop:

1. Call `refinement_next`.
2. Exit immediately when no person is returned.
3. Read the current dossier as accumulated prior understanding.
4. Decide whether the dossier or blurb should change.
5. Call `replace_dossier`, including the consumed evidence locators.
6. Repeat up to the limit stated in the cron prompt.

A no-change refinement may acknowledge the evidence while retaining the current dossier.
If the cron fails before the write, the evidence remains unprocessed and is retried next
time. The previous dossier and blurb remain available throughout.

The plugin does not create, schedule, or execute the cron. It exposes deterministic
memory operations; the OpenClaw agent owns the schedule, prompt, and interpretation.

## PeopleSQL migration

The next schema migration should:

1. Remove `refinement_enabled` from the product model and candidate queries.
2. Keep `injection_enabled`, change the new-person default to `true`, and expose it as a
   direct agent-controlled preference.
3. Treat legacy `false` values as old default-deny state rather than intentional opt-outs:
   enable injection for existing active people during the migration. The agent can disable
   individual people afterward under the new semantics.
4. Add `person_whisper_receipts`.
5. Add exact processed-evidence receipts.
6. Preserve people, identities, dossiers, companies, todos, and soft-deletion state.

## Focused acceptance tests

1. People tools exist when `senderIsOwner` is missing, `false`, or `true`.
2. An agent can inspect, replace, and delete a dossier.
3. An agent can enable or disable injection for one person.
4. Disabling one person does not affect another person or the global plugin state.
5. A new active person defaults to `injection_enabled = true`.
6. An updated `dossier.blurb` is used in future eligible threads.
7. Person A messages twice in one thread: one whisper.
8. People A, B, and C message in one thread: exactly three whispers.
9. Person A messages in another thread: another whisper.
10. Gateway restart does not duplicate an existing `(thread, person)` whisper.
11. A retry of the same run receives the identical contribution.
12. An unknown Slack ID, disabled person, or missing dossier produces no whisper and no
    receipt.
13. A failed dossier update leaves the previous dossier and evidence state intact.
14. A no-change cron refinement can consume evidence without changing the blurb.

## Explicitly out of scope

- QMD person attribution;
- clustering or graph storage;
- claim arbitration or confidence math;
- plugin-owned scheduling;
- resident refinement workers;
- owner approval or scheduled-run authorization layers.

## Implementation order

1. Remove owner gates and simplify person policy to `injection_enabled`.
2. Add direct dossier replacement and deletion actions.
3. Implement durable `(thread, person)` injection receipts.
4. Add unseen interaction evidence and agent-owned refinement operations.
5. Remove plugin-owned Codex and CLI refinement code.
6. Run focused tests, full plugin preflight, and a live three-person/thread-oriented test
   on Bill.

The resulting boundary is deliberately small: **the agent owns PeopleSQL; the plugin
stores, matches, and injects.**
