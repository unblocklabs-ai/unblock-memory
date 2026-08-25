# Contextual Relationship and Workspace Memory

## Status

Vision and planning document. The current `unblock-memory` plugin indexes configured
Markdown with semantic chunking and exposes `memory_search` and `memory_get`. It does
not currently maintain CRM records, ingest conversations, resolve cross-channel
identities, summarize channels, or inject per-person context.

This document captures the desired end state and a lean Slack-first path toward it. It
connects with [Unblock Memory Consolidation and Reflection Cycles](./memory-consolidation-and-reflection.md), where
the same evidence can later be consolidated into evolving person, relationship, and
channel understanding.

## Vision

`unblock-memory` should become a channel-independent relationship and organizational
memory layer for OpenClaw agents.

For every inbound interaction, the plugin should be able to answer:

- Who is this person across Slack, email, iMessage, and other channels?
- What is their role, and how do they relate to the organization, projects, clients,
  and products?
- What does this agent know about them?
- What work have they recently done together?
- What has gone well or poorly in that relationship?
- Where is this interaction taking place, who can see it, and what is that space for?
- Which prior conversations are semantically relevant to the current message?
- What compact context will help the agent respond well without dumping arbitrary
  recent history into the prompt?

The result is a dynamic, person-and-place-specific equivalent of `HUMAN.md`: one bounded
context package assembled for the current person, channel, thread, and topic.

## What this combines

The vision contains seven related capabilities:

1. **Universal identity resolution** maps multiple channel identities to one person.
2. **Structured organizational memory** stores people, roles, channels, companies,
   projects, clients, products, and relationships.
3. **Person and relationship context** explains who someone is and how the agent has
   worked with them.
4. **Channel awareness** explains the purpose, audience, visibility, and current state
   of the interaction space.
5. **Semantic conversation recall** retrieves relevant prior discussions instead of an
   arbitrary recent-message window.
6. **Per-turn context assembly** combines exact structured facts with semantically
   retrieved text and injects one concise block before the model runs.
7. **Automatic consolidation** updates person, relationship, conversation, and channel
   summaries as new evidence accumulates.

These capabilities should share one memory substrate and provenance model rather than
becoming several unrelated SQLite stores.

## This is broader than a sales CRM

“CRM” is useful shorthand, but the system is not primarily a sales pipeline. It is an
agent's structured understanding of the people and environment in which it operates.

It should represent:

- people and their identities;
- organizations and teams;
- projects, clients, and products;
- roles and relationships;
- communication preferences;
- channel membership and audience;
- interaction history;
- source-backed facts;
- agent reflections and inferences; and
- current synthesized understanding.

The structured portion answers exact questions such as “Which Slack user is this?” and
“Who belongs to this channel?” QMD's documents and vectors answer fuzzy questions such
as “What work did I recently do with Rico?” and “Which earlier thread is similar to
this request?”

## Example interaction

Rico posts a new message in Slack channel `#project-x`:

```text
Can we use the same rollout approach we discussed before?
```

Before the model runs, the plugin:

1. Resolves the Slack workspace and user ID to the canonical Rico person record.
2. Resolves `#project-x`, its visibility, purpose, and current members.
3. Loads Bill's current relationship summary for Rico.
4. Searches QMD for prior threads semantically similar to the rollout question.
5. Assembles a bounded context block.

The model receives something like:

```text
RELATIONSHIP CONTEXT

Person
- This is Rico, engineering lead at Acme.
- He works with Bek and Bill on Project X.
- He prefers concise technical explanations with a clear recommendation.

Recent work together
- You and Rico recently investigated deployment reliability.
- Short proposals with explicit tradeoffs have worked well.
- Repeating context already supplied by Rico has caused frustration.

Audience
- This is #project-x, a private Slack channel.
- Members include Bek, Rico, Alice, and Bill.
- Its purpose is Project X engineering coordination.

Relevant prior conversations
1. Rico and Bek discussed the rollout approach on July 12.
   Outcome: staged rollout with a manual checkpoint.
2. Alice reported a similar deployment issue on August 3.
   Outcome: the failure came from an expired credential, not the rollout sequence.
3. Rico proposed reusing the approach on August 10.
   Outcome: deferred until after the client launch.

Use this context when relevant. Distinguish sourced facts from agent inference, and do
not disclose information inappropriate for the current audience.
```

This is not a replacement for the exact messages needed to understand the current
thread. The plugin should replace irrelevant channel backfill, not remove local
conversational coherence. A reply such as “yes, do that” still requires the immediately
preceding thread message.

## System model

```text
Slack first; email, iMessage, and other channels later
                           │
                           ▼
                Normalized interaction identity
       person + channel + thread + workspace + account
                           │
                           ▼
                    unblock-memory plugin
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
 Structured identity   QMD semantic       Consolidated
 and CRM tables        documents/vectors  summaries
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                  Per-turn context compiler
                           │
                           ▼
                    OpenClaw model turn
```

## One database, separate ownership

### Direction

Use one physical per-agent SQLite database where practical, while keeping schema
ownership explicit:

- **QMD owns** document content, semantic chunks, embeddings, lexical search, and vector
  retrieval.
- **The OpenClaw plugin owns** identity, CRM, channel, relationship, source-link, and
  consolidation state.

This avoids creating a bespoke `crm.sqlite`, `channels.sqlite`, and
`relationships.sqlite` beside the QMD index for every installed agent. It also avoids
making generic QMD itself responsible for Slack or organizational CRM semantics.

The current per-agent path remains the natural physical home:

```text
~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite
```

Plugin-owned tables should be namespaced and migrated independently from QMD core
tables. The implementation must prove that QMD's connection lifecycle and migrations
can safely coexist with plugin-owned tables before committing to this layout. If the
QMD API cannot support extension tables safely, use one plugin-owned database as a
temporary boundary rather than patching QMD internals blindly. The product goal remains
one memory substrate; physical unification should follow proven ownership and migration
semantics.

### Why relational and semantic data belong together

Relational storage is best for exact identity and topology:

- Slack team ID and user ID;
- email address and phone number;
- channel ID and privacy type;
- channel membership;
- job title and company;
- project and client assignments; and
- verified cross-channel identity links.

QMD semantic memory is best for evolving narrative context:

- who a person is in practice;
- what the agent has worked on with them;
- communication preferences;
- what went well or poorly;
- conversation and thread summaries;
- channel purpose and current activity;
- prior decisions and outcomes; and
- reflections, assumptions, and inferred understanding.

The relational record should link to the QMD documents and semantic chunks that support
its current summaries and facts.

## Identity model

### Canonical people and channel identities

One person can have many identities:

```text
Person: Rico
├── Slack workspace A / user U12345
├── Slack workspace B / user U83920
├── rico@example.com
├── +1-555-...
└── iMessage address +1-555-...
```

Every channel identity must be scoped by provider and account/workspace. Slack user IDs
are not globally unique across workspaces, and the same email or phone number can have
different privacy or verification states.

Suggested conceptual records:

```text
people
person_identities
organizations
organizational_roles
channels
channel_memberships
projects
clients
products
entity_relationships
facts
source_links
```

This is not a committed SQL schema. The first implementation should create only the
tables needed for the Slack person-and-channel slice.

### Identity linking rules

Incorrectly merging two people is more damaging than temporarily keeping duplicate
records. Cross-channel identities should be linked through:

1. an exact provider identity already associated with the person;
2. verified administrator configuration;
3. a verified shared email or phone number when policy permits; or
4. an explicit human-approved merge.

Do not automatically merge people based only on display name or model inference. The
agent may suggest that two identities appear related, but suggestion is not identity
proof.

Every merge should be auditable and reversible. Source identities should remain aliases
even after consolidation.

### Multi-company installations

All records must be scoped to the installation's tenant, organization, Slack workspace,
and agent as appropriate. A person may appear in more than one customer environment,
but those environments must not silently share private facts or interaction history.

## Person and relationship memory

### Person profile

A person profile contains stable or slowly changing information:

- preferred name and pronouns when known;
- organization and role;
- channel identities;
- projects, clients, and products they work with;
- communication preferences;
- explicitly recorded personal facts; and
- provenance and freshness for every claim.

### Relationship profile

The relationship between an agent and a person is distinct from the person's global
profile. It may include:

- work recently completed together;
- recurring topics;
- commitments and open loops;
- what interaction patterns have worked well;
- what has caused confusion or friction;
- the agent's current reflections or inferences; and
- when the relationship summary was last reconciled.

This distinction matters when several agents know the same person differently. “Rico
is engineering lead” is a person fact. “Bill and Rico work best from concise rollout
plans” is a relationship fact.

### Facts versus summaries

Exact facts and narrative summaries should not overwrite each other:

```text
Structured fact
  role = engineering_lead
  source = Slack profile or administrator
  observed_at = ...

Semantic synthesis
  "Rico leads engineering at Acme and usually owns rollout decisions."
  derived_from = [...]
  epistemic_type = synthesis
```

Manual or administrator-supplied corrections should outrank model-derived facts.
Conflicting evidence should be retained and surfaced for reconciliation rather than
resolved through last-write-wins.

## Channel memory and audience awareness

### Channel profile

For Slack, a channel profile should eventually include:

- workspace and channel identity;
- display name;
- public, private, direct-message, or multi-person-DM type;
- declared topic and purpose;
- known membership and access scope;
- organizational role of the channel;
- communication norms;
- current projects or clients discussed there;
- rolling summary of active work;
- unresolved decisions or open loops;
- source watermark and last consolidation time; and
- confidence when a field is inferred rather than supplied by Slack.

### Know-your-audience context

Audience awareness serves two purposes:

1. **Interpretation:** the agent understands why the message is occurring in this
   channel and which background is likely relevant.
2. **Disclosure:** the agent understands who can see the response and which facts may be
   inappropriate to repeat there.

Channel privacy is not a complete authorization system. “Private channel” does not mean
every private fact about every member is safe to disclose. The context packet should
distinguish facts useful for internal reasoning from facts safe to mention to the
current audience. A later implementation may need explicit sensitivity and disclosure
scope on facts.

### Updating channel summaries

A fixed hourly job for every channel would waste work on quiet spaces and may lag busy
ones. Prefer an activity-adaptive policy:

- update after a meaningful number of new messages;
- update when an active thread becomes idle or reaches a checkpoint;
- enforce a maximum staleness window for active channels;
- rarely touch inactive channels; and
- maintain a source watermark so each run summarizes only unseen material while still
  reconciling with the previous summary.

The summary is a current synthesis, not a replacement for the underlying conversation
evidence.

## Conversation memory and semantic recall

### Replace arbitrary recency with relevance

The plugin should not use “the last three channel conversations” as a proxy for useful
context. On each inbound message, it should search for conversations semantically
related to the current request.

The desired result is a small set of prior discussions containing:

- a concise summary;
- participants;
- channel and thread provenance;
- date or time range;
- decisions and outcomes;
- unresolved work;
- why the conversation appears relevant; and
- a source link or stable reference.

Use a score threshold and return fewer than the maximum when weak matches would add
noise. “No relevant prior conversation found” is better than three forced results.

### Conversation artifacts

Slack threads are a useful first conversation boundary. The system can maintain one
QMD-indexed artifact per thread, updating it as new replies arrive and consolidating it
when the thread becomes inactive.

The artifact may contain:

- exact or source-linked messages where retention policy allows;
- a semantic summary;
- participants;
- decisions, tasks, and outcomes;
- channel and thread IDs;
- first and last activity times; and
- links to people, projects, clients, and products.

The system should not assume that every important Slack discussion is threaded. A later
version may segment unthreaded channel traffic into semantic conversation events, but
that is not required for the first proof.

### Current-thread coherence remains separate

Semantic recall supplements the exact local thread context. It should replace arbitrary
unrelated channel history, not the messages required to resolve references such as
“that,” “the second option,” or “yes, please do it.”

## Per-turn context compiler

### Inputs

The compiler needs a normalized interaction envelope:

```text
agent identity
channel provider
provider account or Slack workspace
sender provider identity
channel identity and type
thread or reply identity
current message
current local conversation context
```

The exact OpenClaw event fields must be verified against the live channel and prompt
hook payloads before implementation. Do not infer Slack mention, thread, sender, or
audience state from display text when structured payload fields exist.

### Resolution flow

```text
Inbound interaction
        │
        ▼
Resolve canonical person
        │
        ▼
Resolve channel and audience
        │
        ▼
Load person + relationship synthesis
        │
        ▼
Retrieve semantically similar conversations
        │
        ▼
Apply relevance, freshness, disclosure, and token budgets
        │
        ▼
Build one structured context contribution
        │
        ▼
Inject before the model turn
```

### Prompt shape

Use one clearly delimited contribution with sections such as:

```text
RELATIONSHIP CONTEXT
- Person
- Relationship
- Audience
- Relevant prior conversations
- Uncertainty and disclosure notes
```

Tell the model:

- use the context only when relevant;
- do not claim inferences are verified facts;
- respect the current audience;
- prefer current, source-backed information over stale synthesis; and
- do not mention that hidden context was injected unless useful.

The block should remain concise. The compiler should prioritize audience constraints,
strong identity facts, current relationship context, and high-quality semantic matches.
It should omit low-value sections rather than overflow a fixed token budget.

### OpenClaw integration direction

Current OpenClaw plugin guidance exposes `before_prompt_build` for dynamic system-prompt
contributions and `agent_turn_prepare` for same-turn context. One of those typed hook
surfaces is likely the right injection point, but the exact payload, channel metadata,
permissions, ordering, and interaction with the memory capability must be verified
against the pinned OpenClaw version before implementation.

Prompt injection can be disabled by operator policy, and raw conversation access for a
non-bundled plugin may require explicit host configuration. The plugin must declare and
document the resulting capability honestly.

### Latency and failure behavior

Context assembly occurs on the hot path and must be bounded:

- cache stable person and channel profiles;
- avoid running summarization during the inbound turn;
- use existing QMD embeddings for retrieval;
- cap semantic results and injected tokens;
- apply hook timeouts; and
- degrade gracefully to no extra context if the CRM or retrieval layer is unavailable.

Failure to resolve a person should not block the agent's reply. The compiler can inject
known channel context and mark the sender as unresolved.

## Updating the memory

### Event-driven source updates

Prefer exact source updates where possible:

- sync Slack member identity and profile fields from Slack;
- update channel metadata and membership from Slack events or a bounded refresh;
- update conversation artifacts when messages arrive;
- record administrator corrections immediately; and
- retain source timestamps and identifiers.

### Asynchronous consolidation

Do not ask the interactive turn to rewrite every summary. Queue or schedule bounded
consolidation for:

- person profiles whose evidence changed;
- agent-person relationship summaries after meaningful interactions;
- threads that became inactive;
- active channels that crossed an update threshold; and
- unresolved conflicting facts.

The same principles as memory dreaming apply:

- previous summaries remain visible;
- new evidence is compared with current understanding;
- the model may return no change;
- generated claims carry epistemic type and evidence links; and
- raw evidence is not silently deleted.

### Relationship to dreaming

Dreaming can later reconcile the broader clusters around a person, project, client, or
channel. The contextual memory layer consumes the resulting current synthesis during
interactive turns.

```text
Interactions → QMD evidence → consolidation/dreaming → current profile
      ▲                                              │
      └──────────── next interaction context ◄───────┘
```

This creates an intentional feedback loop. Its provenance should remain visible so the
human can distinguish source facts from the agent's own evolving interpretation.

## Human management surface

The long-term operator experience should allow a human to:

- browse and search people;
- inspect linked Slack, email, phone, and iMessage identities;
- merge or split identities;
- correct names, roles, and relationships;
- see where each fact came from;
- inspect a person's current relationship summary;
- browse channels, membership, visibility, purpose, and current summary;
- inspect semantically related conversations;
- see what context would be injected for a given person and channel;
- mark a fact as private, stale, incorrect, or superseded; and
- review how agent-generated understanding changed over time.

The first version does not need a full CRM web application. SQLite inspection, focused
tools, or a minimal admin view are sufficient until the core interaction proves useful.

## Privacy, disclosure, and trust

This system handles more sensitive information than ordinary document search. It may
combine personal facts, communication history, channel membership, inferred
preferences, and relationship reflections.

Required principles:

- isolate customer and workspace data;
- never resolve identities across tenants without explicit configuration;
- preserve the source and epistemic status of facts;
- distinguish what the model may use internally from what it may disclose;
- do not automatically infer sensitive personal attributes;
- allow people and identities to be corrected, split, or removed;
- keep prompt contributions bounded and avoid logging them by default;
- honor channel and workspace retention policies;
- do not treat display-name similarity as identity proof; and
- document when conversation text or summaries leave the machine for model processing.

Person-specific context can improve an interaction while also creating the risk of
creepy or inappropriate recall. Relevance and audience are not enough; the eventual
system needs a disclosure policy that considers sensitivity and why a fact was stored.

## Slack-first MVP

Prove one narrow end-to-end slice before generalizing to every channel or organizational
entity.

### Included

1. One Slack workspace and one OpenClaw agent.
2. A canonical person record for Slack members the agent actually encounters.
3. Exact mapping by scoped Slack user ID.
4. A manually editable person summary and relationship summary.
5. A channel record with name, purpose, public/private type, and known membership.
6. QMD-indexed conversation artifacts for threads in which the agent participates.
7. Semantic retrieval of up to three strong prior thread matches.
8. One bounded pre-turn context block containing person, channel, and relevant-history
   sections.
9. Provenance links from summaries and retrieved conversations to source records.
10. Graceful no-context behavior when identity or search data is unavailable.

### Explicitly deferred

- automatic identity matching across email, iMessage, and Slack;
- an ontology covering every company, project, product, and client shape;
- ingestion of every message in an entire Slack workspace;
- a full CRM administration application;
- automatic sensitive-attribute inference;
- generalized policy engines;
- perfect unthreaded-conversation segmentation;
- automatic person and channel synthesis before the injected-context slice is proven;
  and
- replacement of exact current-thread context.

## Lean implementation sequence

### Phase 1: identity and channel foundation

- Prove that plugin-owned namespaced tables can safely coexist in the per-agent QMD
  database.
- Add Slack-scoped people, identities, channels, and membership records.
- Seed or sync only the fields required for a useful person-and-channel packet.
- Provide a read-only inspection path for debugging resolved identities.

### Phase 2: conversation artifacts and semantic recall

- Capture threads involving the agent through the narrowest available OpenClaw/Slack
  event surface.
- Store or generate stable QMD-indexed conversation artifacts.
- Retrieve semantically related prior threads from the current message.
- Prove that relevance beats arbitrary recent-channel history on real conversations.

### Phase 3: bounded context injection

- Verify the correct typed OpenClaw prompt hook and channel payload.
- Assemble person, relationship, channel, and related-conversation sections.
- Enforce token, latency, freshness, and failure budgets.
- Preserve exact current-thread coherence.
- Test public, private, DM, thread, unresolved-person, and no-match cases.

### Phase 4: automatic consolidation

- Update thread summaries after meaningful activity or inactivity.
- Maintain activity-adaptive channel summaries.
- Reconcile person and relationship summaries when supporting evidence changes.
- Allow no-op outcomes and preserve source lineage.
- Connect the process to the memory dreaming design.

### Phase 5: additional entities and channels

- Add projects, clients, products, and their relationships only as real installations
  require them.
- Add verified email and iMessage identities.
- Normalize other channel adapters into the same interaction envelope.
- Add human merge, split, correction, and disclosure controls.

## Focused validation

Tests should prove the boundaries most likely to cause incorrect or unsafe context:

- Slack identities are scoped by workspace and do not collide;
- display-name equality does not merge people;
- manual corrections outrank inferred facts;
- public/private/DM channel type is resolved from structured data;
- current thread context remains available;
- semantic retrieval returns fewer than the maximum when matches are weak;
- unrelated recent messages are not injected merely because they are recent;
- injected content fits a deterministic budget;
- unavailable CRM or QMD search degrades to a normal agent turn;
- tenant and agent data remain isolated;
- summaries preserve evidence and epistemic status; and
- prompt injection and conversation access honor OpenClaw operator policy.

Use real representative Slack payload fixtures after verifying them against the pinned
OpenClaw and Slack integrations. Do not invent payload fields from prose documentation.

## MVP success criteria

The Slack-first version succeeds when:

1. A Slack message from Rico reliably resolves to the correct canonical person.
2. The agent receives a concise, accurate Rico relationship summary.
3. The agent knows whether the current channel is public, private, or a DM and who the
   relevant audience is.
4. A rollout question retrieves genuinely related prior threads rather than arbitrary
   recent history.
5. The context contribution improves the response without overwhelming the prompt.
6. Weak or unavailable matches produce no misleading injected history.
7. Every injected fact or summary can be traced to a source or marked as agent-derived.
8. The same physical memory system can serve another installed agent without creating
   another bespoke CRM database or schema fork.

## Decisions captured

- Start with Slack, then generalize through normalized channel identities.
- Model one canonical person with many scoped provider identities.
- Never merge identities from display names alone.
- Treat the feature as relationship and workspace memory, not merely a sales CRM.
- Prefer one per-agent SQLite memory substrate with explicit schema ownership.
- Keep QMD generic; keep CRM and channel semantics in the OpenClaw plugin.
- Use relational tables for exact identity and relationships and QMD for semantic text
  and retrieval.
- Inject one bounded per-turn context contribution rather than a permanent giant prompt.
- Preserve exact current-thread context while replacing arbitrary unrelated history with
  semantic recall.
- Include person, relationship, audience, and relevant-conversation context.
- Update channel summaries according to activity rather than polling every quiet channel
  at a fixed rate.
- Preserve provenance, epistemic type, and human corrections.
- Connect automatic person and channel consolidation to the broader dreaming loop.
- Prove the person-and-channel Slack slice before building a universal ontology or full
  CRM UI.

## Open implementation questions

1. Can plugin-owned namespaced tables safely share the QMD connection and migration
   lifecycle, or is a QMD extension-store API needed first?
2. Which current OpenClaw typed hook exposes the required sender, channel, thread, and
   prompt-contribution data at the correct time?
3. What Slack member and channel metadata is available through the host without making
   `unblock-memory` a second Slack client?
4. Which conversations should be retained: only agent-participated threads, explicitly
   configured channels, or a broader workspace scope?
5. Should conversation artifacts retain exact text, summaries plus source links, or
   both under configurable retention policy?
6. What fields belong in the first person and relationship profiles?
7. How should agent-authored facts be proposed, confirmed, corrected, and superseded?
8. Which facts may be used for reasoning but not disclosed in a given channel?
9. How should the system represent unthreaded Slack conversations without creating
   arbitrary boundaries?
10. What activity thresholds produce useful channel summaries without needless model
    calls?
11. Should profile consolidation run through the same scheduled dreaming mechanism or
    a smaller event-driven queue?
12. What minimal human inspection and identity-correction surface is required before
    enabling automatic cross-channel linking?
