# PeopleSQL: People, Dossiers, Refinement, and Injection

## Status

Product and architecture direction. This document narrows the broader relationship-memory
and `platform.sqlite` planning to one useful loop:

```text
Observed person identity
        -> source-backed dossier refinement
        -> bounded person context at the next interaction
```

The first implementation should prove that loop before adding channel summaries,
projects, clients, a general organizational ontology, or a memory UI.

## Goal

Unblock Memory should maintain a private, agent-specific understanding of people the agent
actually interacts with or deliberately imports from its company directory. For a known
person, it should be able to answer:

- Who is this person, when the inbound platform supplies an exact supported identity?
- Which company are they associated with, and what is their role?
- What do they care about, prefer, and consider a successful outcome?
- How do they work best with this agent and with other people?
- What feedback has been exchanged or observed?
- What concise context would help the agent respond well right now?

This is relationship memory, not a sales pipeline. It combines deterministic identity
mapping with a source-backed dossier that Codex periodically refines.

## Product loop

```text
Exact-attributed sessions + verified directory identities
                              |
                              v
                  Attribute evidence to people
                              |
                              v
              Periodic, bounded Codex refinement
                              |
                              v
                        people.sqlite
                              |
                              v
Inbound sender -> exact identity lookup -> bounded dossier blurb once per session
```

The interactive path performs no model call. Codex analysis happens asynchronously and
the prompt-time whisperer performs only an exact local lookup.

## Slack discovery and enrichment

The Slack MVP has two deliberately separate paths:

### Real-time discovery

When a Slack message arrives, use the exact tuple `(slack, accountId, senderId)` supplied
by OpenClaw:

1. If the identity is known, update lightweight `last_seen_at` and display metadata.
2. If the tuple is complete but unknown, create a minimal person and Slack identity with
   both refinement and injection disabled by default.
3. If the new record lacks useful directory metadata, upsert one deduplicated
   `needs_enrichment` todo.
4. If the tuple is incomplete, do not guess or create a person. Upsert a bounded diagnostic
   todo using only the safe metadata that is available.
5. Continue the agent turn normally. Discovery never performs a Slack API call and never
   blocks on enrichment.

An exact Slack identity is sufficient to create a local person record; it is not sufficient
to merge that person with another record. Cross-account duplicates remain separate until a
human explicitly links or merges them in later tooling.

### Manual directory sync

An explicit agent or administrator action may reconcile an OpenClaw Slack account with the
Slack user directory. The sync should:

1. list users through OpenClaw's authenticated Slack directory adapter;
2. upsert people and identities by exact `(slack, accountId, slackUserId)`, with new people
   disabled for refinement and injection by default;
3. refresh only normalized profile fields supplied by the supported OpenClaw directory
   contract, plus the sync timestamp;
4. leave `needs_enrichment` todos open for deliberate resolution; and
5. report created, updated, unchanged, skipped, and failed counts.

The MVP sync is manual, bounded, and safe to rerun. In pinned OpenClaw
`2026.8.1-beta.3`, the CLI contract supplies ID, name, and handle. Real name, title,
bot classification, and deactivation state remain empty until a public runtime directory
contract exposes them without requiring the plugin to parse a raw provider payload.
Scheduling sync is later work. It must not
overwrite explicitly curated canonical names with empty or lower-quality Slack values, and
it must not store the entire raw Slack profile merely because Slack returned it.
An explicitly deactivated directory identity updates directory availability and may create
a review todo; it does not autonomously soft-delete or merge a canonical person. Absence
from a bounded or failed sync is not evidence that a person is unavailable.
The sync performs no model analysis and does not infer company relationships from names,
email domains, or Slack profile text. A company association must come from explicit local
configuration or a later reviewed action.

Slack directory reads require `users:read`. Email requires the additional
`users:read.email` scope and is not needed for Slack-only identity resolution, so importing
email is deferred until there is a concrete cross-provider mapping need.

Unblock Memory must not read, resolve, copy, or persist the agent's raw Slack token. Tokens
may be secret references, and OpenClaw should remain responsible for authentication. The
preferred integration is a supported OpenClaw runtime directory-read API. In pinned
OpenClaw `2026.8.1-beta.3`, external plugins do not yet receive that API; the existing
`openclaw directory peers list --channel slack --account <accountId> --json` command can be
used as a bounded interim worker if implementation begins before the runtime surface exists.

## Storage boundary

Use a separate per-agent database:

```text
~/.openclaw/agents/<agentId>/unblock-memory/
├── index.sqlite       # QMD-owned, derived, and rebuildable
├── curation.sqlite    # Current memory-maintenance state
└── people.sqlite      # Unblock Memory-owned people and relationship state
```

Do not create `platform.sqlite` for this first slice. A broad platform schema invites
client-specific tables and migrations before the stable shared model is understood.
`people.sqlite` is an intentional scope boundary and may remain separate permanently.

The database is owned by one agent and scoped to that agent's company context. Agents do
not synchronize or share PeopleSQL records. Cross-agent maintenance, when explicitly
needed, operates on each agent's store independently rather than creating a shared people
database that could expose company-sensitive information.

The dossier is not a QMD corpus and must not enter the normal embedding path. Exact-attributed
session events are the sole MVP evidence source. A prior dossier may be supplied for comparison
during refinement, but it is not independent evidence for its own claims.

## Schema policy

Every installation runs the same plugin-owned schema. Client customization changes rows,
configuration, evidence sources, and registered dossier categories; it never executes
custom DDL.

Do not add provider- or customer-specific columns such as:

```text
hibob_employee_id
harvest_hours_required
asana_user_id
linear_user_id
```

Provider identities are rows. Customer-specific operational fields remain in their
source systems or customer-owned registries. PeopleSQL may retain a source reference and
turn relevant meaning into a standard, evidence-backed dossier claim.

Core migrations should be identical across installations, transactional, small, and
preferably additive. Migration tests should cover representative older database fixtures,
and the database should be backed up before an upgrade.

## Conceptual data model

This is a design model, not committed SQL. The first migration should include only fields
required by the initial end-to-end behavior.

### `companies`

Canonical companies provide a stable home for company-specific categories and identity
scopes without putting company-specific concepts in the schema.

Suggested fields:

- internal UUID;
- canonical name;
- optional primary domain;
- active or archived status; and
- created and updated timestamps.

### `people`

One canonical record per known person:

- internal UUID;
- display name and optional preferred name;
- active, unavailable, or archived status;
- optional primary company reference;
- last-seen timestamp; and
- created and updated timestamps.

The MVP never autonomously merges people.

### `person_companies` (later, if needed)

A person may have more than one company relationship over time. Keep that mapping
separate from the person record:

- person and company IDs;
- general relationship type, such as employee, contractor, client, partner, or other;
- optional role title;
- primary relationship flag;
- optional start and end dates; and
- source and freshness.

Avoid adding company-specific HR or billing policy here.

The MVP uses the optional `people.company_id` reference. Do not add this join table until
one person genuinely needs multiple simultaneous or historical company relationships.

### `person_identities`

External identities resolve an inbound sender or external-system user to a canonical
person:

- person ID;
- provider, starting with `slack`;
- account scope, which for Slack is the configured OpenClaw account ID or alias rather
  than the Slack workspace/team ID;
- external ID;
- normalized directory display name, real name, handle, avatar URL, and optional title;
- bot or human classification;
- explicit provider deactivation state; and
- first-seen, last-seen, and last-synced timestamps.

These are normalized identity/profile fields, not a copy of the provider response. The MVP
does not persist Slack status text, arbitrary custom profile fields, or a raw profile blob.

The stable lookup key is:

```text
(provider, account_scope, external_id)
```

Provider values are data, not a SQL enum that requires a migration whenever a new system
is supported. Adding email, Asana, Linear, or other provider mappings is explicitly later
work; it is not part of the People Whisperer MVP. A later provider may add a normalized
address, such as a case-normalized verified email, without changing the exact Slack lookup
contract.

The MVP links identities only through:

1. an exact scoped provider identity already associated with a person;
2. explicit administrator configuration; or
3. an explicit human-approved merge.

Exact verified shared email or phone linking may be considered with a later provider-mapping
feature and an explicit policy. It is not an MVP fallback.

Never merge people from display-name similarity or model inference. A conflicting exact
identity fails closed for administrator review.

### Dossier selection policy

Not every observed person should be periodically analyzed. Selection is explicit and
queryable without parsing model-authored JSON.

Suggested relational controls:

```ts
type DossierPolicy = {
  refinementEnabled: boolean;
  injectionEnabled: boolean;
};
```

`refinementEnabled` should default to `false`. An operator or explicit agent action may
enable a person. The scheduled refinement job selects only enabled people whose latest
interaction is newer than their dossier's `reviewed_at` timestamp.

These controls should not live inside the model-authored `PersonDossier`. Codex must not
be able to silently expand the set of people it analyzes or injects.

### Dossier categories

The MVP hardcodes useful baseline categories:

Baseline categories:

```ts
const BASELINE_DOSSIER_CATEGORIES = [
  "role",
  "priorities",
  "preferences",
  "successCriteria",
  "workingStyle",
  "relationship",
  "openLoops",
] as const;

type BaselineDossierCategory = typeof BASELINE_DOSSIER_CATEGORIES[number];
```

Custom `custom:<slug>` categories remain part of the product direction, but are not in the
first implementation. Add a small local category catalog only after a real agent or company
needs a category that the baseline cannot express. A refinement response must never invent
an unregistered category.

### Claims and dossiers

Each dossier is a current, bounded understanding rather than an append-only biography.
Claims should retain their epistemic status and evidence:

```ts
type EvidenceRef = {
  source: "session" | "memory" | "directory" | "manual";
  locator: string;
  observedAt?: string;
};

type Claim = {
  statement: string;
  evidence: EvidenceRef[];
  epistemicType: "observed" | "reported" | "inferred" | "agent_assessment";
  confidence?: "low" | "medium" | "high";
};

type DossierSection = {
  category: BaselineDossierCategory;
  claims: Claim[];
};

type PersonDossier = {
  schemaVersion: 1;
  blurb: string;
  sections: DossierSection[];
};
```

The application validates the dossier at every write boundary. The `blurb` is the
already-budgeted prompt contribution; the interactive path should not summarize the full
dossier again.

The MVP stores one current validated dossier per person. The database row owns the person
ID and `reviewed_at` timestamp. Immutable revision history, model-run history, and no-change
records are deferred until there is a demonstrated review or rollback need.

### `feedback` (after MVP)

Feedback deserves a separate table because it has direction, participants, time, and
provenance. It may later support a dossier claim, but it is not itself the dossier.

Support three common directions:

```text
person -> agent
agent  -> person
person -> person
```

When implemented, start with:

- source actor type (`agent` or `person`) and optional source person ID;
- target actor type (`agent` or `person`) and optional target person ID;
- kind: `works_well`, `could_be_more_helpful`, `preference`, `concern`, or `other`;
- a concise statement;
- basis: `explicit`, `observed`, or `inferred`;
- evidence references;
- occurred timestamp; and
- created and updated timestamps.

Examples:

```text
Person -> agent / works_well
"They value a recommendation that opens with the decision."

Agent -> person / could_be_more_helpful
"Sharing the target deadline with requests would reduce clarification rounds."

Person -> person / observed
"They respond well when their manager gives written acceptance criteria."
```

Explicit feedback must remain distinguishable from an agent's behavioral observation. Do
not infer sensitive personal attributes or make feedback stronger merely because an earlier
dossier repeated it. Do not add supersession or resolution state until correction history is
actually needed.

### Operational tables

Keep the remaining state small. The MVP needs only `people_todos` for incomplete sender
identities, enrichment needs, and soft-deletion reviews. Do not add
separate `mapping_exceptions`, `refinement_runs`, or evidence-watermark tables yet. Those
can be introduced later if the bounded todo inbox and dossier timestamps stop being enough.

`people_todos` is a bounded operational inbox, not another memory corpus. A todo has a
stable deduplication key, kind, safe structured context, status, occurrence count, first
and last-seen timestamps, and optional resolution metadata. Repeated observations upsert
one row and increment its count rather than creating duplicates. Do not store message
content merely to make a todo more descriptive.

The implementation must impose a configurable maximum number of open rows. Once at the
limit, additional unique observations increment a single overflow counter instead of
growing the database without bound. Start with a default cap of 1,000 open rows per agent.
Do not add an automated pruning job in the MVP.

## Refinement workflow

Refinement is asynchronous and bounded:

1. Select only people with `refinementEnabled = true` and new evidence.
2. Resolve attributed sessions through exact structured identity metadata.
3. Load the current dossier for comparison, not as independent corroboration.
4. Ask Codex to confirm, revise, retract, or make no change.
5. Validate the typed dossier and evidence references.
6. Atomically replace the current dossier only when it changed, then update `reviewed_at`.

The MVP rejects non-baseline dossier categories. Identity merges and changes to refinement
or injection policy require an explicit validated action outside the refinement response.

Company-specific refinement guidance may influence which questions Codex asks, but all
output must fit the shared dossier and claim contract. A client-specific prompt must not
create a client-specific SQL schema.

## Person context injection

The People Whisperer mirrors Skill Whisperer but uses exact identity resolution:

```text
Inbound message
    -> provider + account scope + sender ID
    -> canonical person
    -> current dossier blurb
    -> inject once for that person in the session
```

Requirements:

- globally configurable and disabled by default for initial rollout;
- requires `injectionEnabled = true` for the resolved person;
- exact identity lookup only;
- no Codex call or QMD search on the hot path;
- a deterministic contribution cap, initially 1,200 characters (roughly a few hundred
  tokens);
- at most one contribution per person per session;
- group conversations may inject once for each distinct participant when they first
  speak;
- no additional context when identity or policy cannot be established; and
- failure degrades to a normal agent turn.

The contribution tells the model to use the information only when relevant, distinguish
inference from verified facts, and avoid presenting uncertain claims as settled. The
precomputed blurb is the only dossier content injected into the prompt.

## Configuration direction

The plugin configuration should control policy and budgets, while OpenClaw owns the
automation schedule:

```json5
{
  people: {
    enabled: false,
    refinement: {
      maxPeoplePerRun: 10,
    },
    whisperer: {
      enabled: false,
      maxChars: 1200,
    },
    todos: {
      maxOpen: 1000,
    },
  },
}
```

Session evidence is the sole refinement source in the MVP and is not configurable.

A weekly operator-authored OpenClaw command automation should invoke
`openclaw unblock-memory people refine --agent <id>`. OpenClaw owns scheduling,
timeouts, run history, retries, and failure alerts; the plugin owns the bounded
refinement command and one structured `codex exec` call. Do not add a competing
plugin scheduler. Slack directory enrichment is manual in the MVP and has no
schedule setting.

## Initial MVP

**MVP boundary:** Slack-only exact identity discovery, manual directory enrichment,
explicitly opt-in dossier refinement, and one bounded exact-match injection path. No
cross-provider CRM, automatic identity inference, or customer-specific schema.

Include:

1. `people.sqlite` with versioned plugin-owned migrations.
2. Companies, people with one optional company reference, and scoped Slack identities.
3. Real-time creation of a disabled-by-default minimal person for each new exact Slack
   identity encountered.
4. A manual, idempotent Slack directory sync that creates or enriches records without
   exposing Slack credentials to Unblock Memory.
5. A bounded, deduplicated todo inbox for incomplete identities, enrichment needs, and
   admin review.
6. Explicit, independent per-person refinement and injection controls.
7. Hardcoded baseline dossier categories.
8. Source-backed dossier refinement from exact-attributed sessions; configured Markdown
   evidence remains deferred.
9. One precomputed, bounded dossier blurb injected once per person per session through an
    exact local lookup.
10. The minimal inspection and update actions needed to review people, enable policies,
    assign a company, and resolve todos.
11. Graceful no-context behavior for incomplete, unavailable, or disabled records.

Defer:

- channel and audience summaries;
- semantic prior-thread injection;
- project, client, and product ontologies;
- company relationship history;
- scheduled Slack directory synchronization;
- automatic cross-provider identity merging;
- non-Slack provider identity ingestion;
- email import and email-based identity linking;
- provider-specific operational fields;
- raw Slack profile retention;
- custom dossier categories and a category catalog;
- structured directional feedback records;
- dossier revision history, injection audits, and refinement-run logs;
- separate mapping-exception and evidence-watermark tables;
- a full CRM interface;
- arbitrary customer SQL extensions; and
- a general `platform.sqlite` migration.

## Lean implementation plan

### Observe

The repository already has the needed primitives:

- strict hand-written config parsing in `src/config.ts` and matching manifest schema;
- a per-agent state root at `agents/<agentId>/unblock-memory/`;
- synchronous SQLite through Node's built-in `node:sqlite`;
- tool factories in `src/plugin.ts` with trusted `requesterSenderId` and
  `senderIsOwner` context;
- observation-only `message_received`, plus `before_prompt_build` and `session_end` hook
  support;
- a tested Skill Whisperer pattern for bounded prompt contribution and session cleanup.

The missing OpenClaw surface is a public external-plugin directory API. The existing
`openclaw directory peers list ... --json` command is the temporary Slack-directory seam.

### Orient

Build one thin vertical slice around exact identity lookup. Keep PeopleSQL independent of
QMD and make every feature optional and disabled by default.

Use:

- one `PeopleStore` backed by `people.sqlite`;
- `PRAGMA user_version` with a transactional `0 -> 1` migration;
- TypeBox validation at config, tool, and dossier write boundaries;
- SQLite uniqueness and upserts for identity and todo deduplication; and
- OpenClaw hooks and command automation rather than a plugin scheduler.

The first schema contains only:

1. `companies`;
2. `people`, including `company_id`, status, and the two policy booleans;
3. `person_identities`, with the exact provider/account/external-ID unique key and the
   normalized Slack profile fields;
4. `person_dossiers`, storing one validated dossier JSON document, its precomputed blurb,
   and `reviewed_at`;
5. `people_todos`, with a unique deduplication key and bounded open-row policy.

Do not add an ORM, repository interfaces for every table, a general event system, a worker
queue, a scheduler, a cross-process lock, or QMD collections for people data.

### Decide: ordered slices

Each slice must work end to end before starting the next.

#### 1. Storage and configuration

- Add the `people` config block to `src/config.ts` and `openclaw.plugin.json`, defaulting the
  feature and whisperer to off.
- Add `src/people-store.ts` using `node:sqlite`, file mode `0600`, WAL, a busy timeout, and
  the single version-1 migration.
- Keep one lazily opened store per agent and close stores at gateway shutdown.
- Add focused store tests for migration, exact identity uniqueness, policy defaults, todo
  deduplication/cap, and dossier validation.

**Exit:** enabling PeopleSQL creates only that agent's `people.sqlite`; reopening is a
no-op, and disabled configuration opens nothing.

#### 2. Exact Slack discovery and basic tools

- Add `src/people-hooks.ts` and register observation-only `message_received` when PeopleSQL
  is enabled. Derive the owning agent only from a canonical `context.sessionKey` using
  `parseAgentSessionKey`; do not fall back to the main agent.
- For Slack with complete `accountId` and `senderId`, atomically upsert the identity and a
  disabled-by-default person. Store names from the event as display evidence only.
- For incomplete identity, upsert one bounded diagnostic todo and store no message content.
- Add `src/people-tools.ts` with `memory_people_inspect` and `memory_people_update`.
- Keep the update union to `set_policy`, `set_company`, `resolve_todo`,
  `soft_delete_person`, and `restore_person`.
- Use OpenClaw's trusted `senderIsOwner` for administrative actions rather than parsing
  owner configuration inside the plugin.
- Do not create any PeopleSQL tool for non-owner contexts, and retain execution-time owner
  checks on side-effecting tools as defense in depth.

**Exit:** a first message creates one minimal record; repeats update it; missing identity
creates one deduplicated todo; and the agent can inspect the exact stored result.

#### 3. People Whisperer vertical slice

- In `people-hooks.ts`, register `before_prompt_build` and `session_end` using the existing
  Skill Whisperer session-state pattern.
- Require a complete Slack identity, global enablement, `injectionEnabled`, and a current
  dossier.
- Render only the stored bounded blurb through one pure renderer shared with the inspection
  tool. Perform no model call or QMD search.
- Keep an in-memory `Set<personId>` per session and delete it on `session_end`.
- Fail closed and continue the normal turn on missing context or SQLite failure.

**Exit:** a seeded dossier injects once per person per session, never for a disabled or
unknown person, and never exceeds the configured character cap.

#### 4. Codex refinement through a plugin CLI and OpenClaw automation

- Keep refinement candidates and evidence internal to the plugin-owned CLI rather than
  exposing them through an agent tool.
- Add `src/people-evidence.ts` only at this slice. Read exact attributed Slack messages from
  the OpenClaw agent database on demand; do not copy transcripts into `people.sqlite`.
- Register `openclaw unblock-memory people refine --agent <id>` as a lazy plugin-owned CLI
  command. It selects a bounded batch and reads bounded, exact-sender session evidence
  without copying transcripts into `people.sqlite`.
- Invoke one ephemeral, read-only `codex exec` with a JSON output schema. Validate the
  complete result set, exact person IDs, dossier schema, blurb/category invariants, and
  evidence locators before writing the individually transactional dossiers.
- Write each dossier with the candidate's captured `last_seen_at` as `reviewed_at`, so an
  interaction arriving while Codex runs remains eligible for the next refinement.
- Configure a weekly operator-owned OpenClaw command automation externally. The plugin
  does not schedule work; OpenClaw owns command timeout, history, retry, and alert policy.

**Exit:** an enabled person with new evidence receives a validated replacement dossier;
disabled people are skipped, and a no-change review updates only `reviewed_at`.

#### 5. Manual Slack directory sync

- Add `src/slack-directory.ts` behind one small `SlackDirectoryReader` seam so tests provide
  entries without executing a process.
- Implement the production reader with the bounded OpenClaw directory CLI until a public
  runtime API replaces it. Pass only channel, account ID, limit, and `--json`; never accept
  or expose credentials.
- Add `memory_people_sync` for one explicit account. Upsert by the exact identity key,
  preserve curated canonical names, leave enrichment todos for deliberate resolution, and
  return counts.
- Mark explicitly deactivated identities unavailable for that directory source. Do nothing
  based only on absence from a bounded result; never merge or soft-delete automatically.

**Exit:** running the same sync twice is idempotent, enriches encountered people, safely
creates directory-only people with both policies off, and reports a bounded result.

#### 6. Integration and release checks

- Update tool contracts, UI hints, and plugin-inspector hook/registration expectations.
- Add focused hook, tool, config, directory-reader, and store tests. Test behaviors and
  security boundaries, not every SQL getter.
- Run `npm run typecheck`, the focused tests, then the existing full `npm run preflight`.
- Perform one local OpenClaw fixture check: discover a Slack identity, sync enrichment,
  seed/replace its dossier, and observe exactly one injection in a session.

**Exit:** the existing plugin behavior remains unchanged when `people.enabled = false`, and
the normal repository preflight passes.

### Act

This implementation plan is the action from the OODA loop. When implementation is
authorized, start with slice 1. Do not scaffold later slice files, abstractions, or config
until the preceding exit criterion passes. The five version-1 tables are the only up-front
schema work because the core loop depends on their stable contract. If a slice reveals that
a deferred system is genuinely required, update this document with the concrete failure
before adding it.

## Success criteria

The first version succeeds when:

1. An inbound Slack sender resolves deterministically to the correct person.
2. A newly encountered exact Slack identity creates one minimal record without delaying
   the message, and repeated messages do not create duplicates.
3. A manual directory sync safely creates or enriches records and is idempotent.
4. Only explicitly included people are refined or injected.
5. Codex can maintain a useful dossier from attributed interaction evidence.
6. The agent receives a concise, accurate blurb once per person per session.
7. Dossier output never enters its own QMD evidence path.
8. Incomplete, unavailable, or disabled records produce no misleading
    injection.
9. Every injected claim is source-backed or clearly marked as agent assessment.
10. A second company can use different tools and refinement guidance without a custom
    database migration.

## Research findings and decisions

### Prompt-time sender identity

In pinned OpenClaw `2026.8.1-beta.3`, `agent_turn_prepare` and
`before_prompt_build` receive the same hook context. The relevant fields are:

```ts
type PromptIdentity = {
  provider: "slack";    // context.messageProvider
  accountScope: string; // context.accountId: configured OpenClaw Slack account ID/alias
  externalId: string;   // context.senderId: Slack user ID such as U123...
};
```

`channelId` and `chatId` identify the conversation, not the person.
`senderExternalId` is deprecated and core does not populate it.

The Slack workspace/team ID is not present in the prompt-hook context. It may appear later
in `message_received` metadata, but prompt-time lookup must use the exact tuple
`(slack, accountId, senderId)`. `accountId` must not be described as a Slack workspace ID.

Use `before_prompt_build` because it already supports same-turn `prependContext`, is the
existing Skill Whisperer integration point, and is the prompt hook the pinned Codex
app-server actually invokes. Registering this non-bundled plugin also requires
`allowConversationAccess: true`; prompt mutation remains subject to
`allowPromptInjection`.

Inject only when `context.trigger === "user"`, `context.messageProvider === "slack"`, and
both `context.accountId` and `context.senderId` are present. Otherwise fail closed.

The embedded runtime populates the identity tuple, but the pinned Codex app-server prompt
path omits `accountId` and `senderId`. Therefore no pinned prompt hook currently guarantees
the full tuple in every runtime. People Whisperer must fail closed when any required field
is absent. Supporting injection through Codex app-server requires an upstream OpenClaw fix
or an explicit runtime support boundary; display text and conversation IDs are not safe
fallback identities.

Do not bridge the prompt-time identity gap through an observation hook; discovery may race
prompt construction, so same-turn injection must perform its own lookup. In pinned OpenClaw,
use observation-only `message_received` for discovery. Its context lacks `agentId`, so derive
the owner only with `parseAgentSessionKey(context.sessionKey)` and fail closed for missing or
noncanonical keys; never fall back to the main agent. Sender display name and username come
only from the hook's normalized metadata. The handler stores no message content and never
claims or handles the message.

### Historical message attribution

Read structured identity directly from the raw OpenClaw agent database, not from the
rendered QMD transcript.

For group and channel user messages, active transcript events persist useful fields under
`message.__openclaw`, including:

- `senderId`, which is the identity key;
- `senderName` and `senderUsername`, which are display evidence only;
- transport channel and conversation references; and
- message and thread IDs.

For direct messages, per-message sender metadata is not guaranteed. Resolve the person
from the joined conversation using `native_direct_user_id`, then `peer_id`, scoped by the
conversation's channel and account ID. Never use `native_channel_id` as a person ID.

The extraction path is:

```text
session_windows
    -> conversations
    -> session_transcript_active_events
    -> transcript_events
    -> structured message.__openclaw metadata
```

`session_participants` can help discover session participants but cannot attribute an
individual message and may contain profile rather than channel identities.

Legacy or incomplete rows without an exact scoped identity become mapping exceptions or
are skipped. The existing session projector reduces identity to a display speaker string,
so its Markdown output is evidence for content but not authoritative identity attribution.

### Refinement and injection are independent

`refinementEnabled` and `injectionEnabled` are independent, default-false controls.
Enabling refinement must not implicitly enable prompt injection.

This permits a dossier to be refined and reviewed before it affects live turns, and
permits an already reviewed dossier to remain usable without continued scheduled
refinement. A tool or UI may offer an explicit "enable both" action, but it must visibly
write both controls rather than treating one as an alias for the other.

Injection requires all of:

1. the global People Whisperer configuration is enabled;
2. the resolved person has `injectionEnabled = true`;
3. a current dossier and bounded blurb exist.

### Custom categories remain local later

Custom categories are deferred. If they are added later, each agent stores its own local
catalog; no shared writable database or live cross-agent lookup is introduced.

### Minimal agent tool surface

Expose three optional tools rather than a general CRM API.

`memory_people_inspect` is read-only but optional and owner-only because dossiers are
sensitive. All three factories return no tool for non-owner contexts. Inspection uses a
strict `view` union:

- `person`: select by internal person ID or exact scoped identity; return the canonical
  person, company, policies, identities, current dossier, injection eligibility, and exact
  rendered contribution;
- `todos`: list a bounded set of actionable people todos.

The hook and inspection tool use the same pure renderer. The MVP keeps only an in-memory
set of people injected in the current session; it does not add an injection audit table.

`memory_people_update` is side-effecting and uses one strict discriminated action union.
The MVP actions are:

- `set_policy`;
- `set_company`, which upserts a canonical company and assigns it to one person;
- `resolve_todo`; and
- `soft_delete_person`; and
- `restore_person`, which returns an unavailable person to active status without
  re-enabling refinement or injection.

`memory_people_sync` manually reconciles one configured Slack account and returns bounded
created, updated, unchanged, skipped, and failed counts. It delegates authentication to
OpenClaw and never accepts a token parameter.

All three tools are registered only when PeopleSQL is enabled. Inspection and every
update action, including dossier replacement, trust OpenClaw's host-derived
`senderIsOwner`; the plugin does not reimplement `commands.ownerAllowFrom`. Directory sync
also rejects non-owners. Automated refinement runs only from the plugin CLI scheduled by
an operator-owned OpenClaw command automation, and may replace a dossier only for a person
with `refinementEnabled = true`. General person merge and split operations remain deferred.

### Unknown identities and weekly cleanup

People Whisperer works only when OpenClaw supplies an exact scoped Slack sender identity.
It never guesses from a display name or message text.

Two bounded cases enter `people_todos`:

1. OpenClaw supplies a complete, previously unknown Slack identity. Atomically create a
   minimal person and identity, then upsert one `needs_enrichment` row keyed by
   `(slack, accountId, senderId, needs_enrichment)` only when useful directory metadata is
   still missing. Refinement and injection remain disabled until explicitly enabled.
2. The runtime omits part of the required identity tuple. Do not create a person. The todo
   records only the safe route, runtime, session, and conversation metadata that was
   actually available. These
   are diagnostic buckets keyed by the available account/runtime plus a reason such as
   `missing_sender_id`, `missing_account_scope`, or `unsupported_runtime_identity`; never
   create one row per message when no stable person key exists.

Every repeat updates `last_seen_at` and the occurrence counter. Todo rows never
store message content. Directory sync enriches identity data but does not resolve todos.

The plugin still runs the agent turn normally and injects no person context. An owner-agent
must deliberately resolve a `needs_enrichment` row after reviewing the synced data.
A weekly OpenClaw cron may list the remaining actionable diagnostic and review todos and
ask the configured administrator for help. The first setup may simply schedule a weekly
Slack prompt to a chosen exact identity from `commands.ownerAllowFrom`. OpenClaw owns that
schedule; the plugin only owns the inbox and tools used to inspect or resolve it.

### Soft deletion and admin review

PeopleSQL deletion is a reversible soft delete:

1. Set the person status to `unavailable`.
2. Set both `refinementEnabled` and `injectionEnabled` to `false`.
3. Stop updating, refining, or injecting that person immediately.
4. Preserve the existing record and exact identities for review.
5. Upsert one deduplicated `soft_delete_review` todo for the person.

An administrator may later call `restore_person`, keep them unavailable, or archive them.
Restoration returns the person to active status but leaves refinement and injection off.
Administrator authority follows the same trusted OpenClaw rules above; workspace
instructions may describe the review workflow but must not grant authority by themselves.
