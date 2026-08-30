# Entity Whispering — Direction and Doctrine

## Status

Planning conversation consolidation, captured **2026-08-29** and revised **2026-08-30**
after checking the direction against the current PeopleSQL, QMD, and Unblock Cluster
implementations. This is the freshest statement of direction for whispering and
consolidation; where it conflicts with older planning documents, prefer this one, except
where an older document is explicitly cited as still governing.
Nothing here is implemented beyond what the README already describes. The overall
product vision lives in `../vision.md`.

Builds on:

- `people-whisperer-materialized-relationship-cache.md` (evidence packet design; still
  the reference for the full refresh packet)
- `contextual-relationship-memory.md` (context compiler; superseded in part — see
  "Injection model" below)
- `memory-consolidation-and-reflection.md` (dreaming; unchanged)

## Core thesis

People Whisperer is the proof of concept for **general entity whispering**. People,
places, things, and ideas — that is all entities are. If stable subjects can bind the
cues and clusters can organize the evidence around them, the surface area is largely
covered.

The underlying model splits agent memory access into two systems:

- **Recognition (whispering):** involuntary, instant, cued by the environment. The
  agent receives precomputed understanding the moment an entity enters the
  conversation, before any tool call. This is listening-mode pattern matching.
- **Recollection (memory_search):** deliberate, effortful recall. The agent must know
  it doesn't know and phrase the right question. This is thinking-mode.

Humans run almost entirely on recognition and drop into deliberate recall only when
recognition comes up empty. Current agent architecture is inverted: everything is
either permanently in-context (a huge static system prompt) or behind hopeful
retrieval. Whispering is the missing middle layer.

Doctrine that follows: **the heavy consumers of memory_search should be background
processes** — dreaming, curation, dossier refinement, and occasional genuinely deep
conversational dives — not ordinary inbound turns. The interactive path recognizes;
the background path thinks. This generalizes PeopleSQL's existing invariant that the
injection path performs no model call.

### Why not just-in-time retrieval

- A dossier is a materialized view: consolidation cost is paid once, asynchronously,
  off the hot path, computed over the full evidence base. It is then read hundreds of
  times at 200–600 tokens each.
- memory_search on the hot path pays retrieval cost every session, sees only whatever
  chunks the query happens to hit, returns raw material the agent must synthesize
  in-context, and burns output tokens (the expensive ones) composing tool calls.
  Tuning/reranking RAG for just-in-time entity understanding is a fool's game.
- Precomputed understanding wins decisively on latency and repeated token cost. It can
  also be more complete than a handful of just-in-time hits because consolidation has
  time to inspect the accumulated evidence. Accuracy is conditional on freshness: a
  stale or mistaken dossier deterministically repeats its mistake, so evidence citations,
  fast correction, and retaining the last good dossier are product requirements rather
  than cleanup work. Bill has run the same person lookups for hundreds of sessions; that
  repeated reconstruction is wasted time and tokens.

### The system prompt diet (endgame)

Much of what currently lives in agents.md / user.md / soul.md is entity dossiers
wearing a global-rule costume. "How I behave in #support" is a place dossier. "Rules
around the primary user" is a person dossier. "How I write code" is a situation
dossier cued by being in a repo. The static prompt should shrink toward the genuinely
always-on personality kernel; everything situational becomes cued. This is not only a
token saving — every context token biases the response, so the agent talking to the
user's spouse should not be spending attention on coding rules at all. A red car may
recall a first car; a late-90s Camry should not trigger "don't comment every
function."

This is a diet, not indiscriminate extraction. Genuinely unconditional behavior and
non-negotiable operating rules stay in the kernel. Dossiers are descriptive context;
skills and playbooks remain procedural. A missed cue must not silently disable a rule
that was intended to apply everywhere.

## The trigger axis

When generalizing beyond people, the axis that matters is not the entity type but the
**trigger type**:

- **Exact triggers** — structured identity: Slack `(provider, accountId, senderId)`,
  channel ID, working directory, repo name, ticket prefix, URL. Deterministic lookup,
  zero attribution inference, and near-zero latency. The trigger can still be too broad
  for the current conversational need, but it cannot silently attribute Alice's evidence
  to Bob. People Whisperer proves this path.
- **Semantic triggers** — embed the live turn, compare against pre-embedded entity
  representations, gate on minScore with a cooldown. Skill Whisperer already proves
  this path (it is spreading activation with a salience gate).

Both runtime mechanisms therefore already exist as separate proofs: People Whisperer
proves exact lookup and Skill Whisperer proves semantic cueing. Skill Whisperer does not
yet prove that arbitrary topic centroids will be good entity representations; that must
be calibrated separately.

The durable concept is a **subject**: a stable address for a person, channel, project,
idea, or eventually the agent itself. A subject owns exact and/or semantic triggers,
injection policy, attributed evidence, and curated understanding. Clusters are disposable
views over that evidence, never the subject's identity. This avoids a typed ontology
without making durable identity depend on unstable analysis output.

Do not extract generic subject tables from PeopleSQL yet. Finish the people loop first.
When channels introduce real duplication, the general shape can become a `subjects`
table, `subject_triggers`, and subject-keyed dossiers. `person_identities` is already the
narrow exact-trigger equivalent. Semantic triggers require stricter salience gates
because a false-positive injection is worse than none.

### Sequencing

1. **People** (in flight) — exact triggers, proves the loop.
2. **Places / channels next** — exact triggers again (cheap), and delivers the
   audience-awareness slice already specified in `contextual-relationship-memory.md`.
3. **Extract the generic subject seam** only when people and channels demonstrate the
   shared storage and policy shape.
4. **Semantic idea/topic subjects last** — the only genuinely risky trigger type;
   Skill Whisperer usage will have calibrated the minScore/cooldown dials by then.

People + places covers the two entity types present in essentially every session
before any hard trigger problem must be solved.

## Injection model (decided 2026-08-29)

- The token budget (~200–600 tokens, loose) is **per whisper**, not a global
  per-thread budget.
- Injection is **event-driven and incremental**: each entity's dossier snippet is
  injected **once per thread per entity**, at the moment that entity enters the
  thread. Person A's snippet fires when Person A starts the thread; Person B's snippet
  fires when Person B chimes in later; Project A's snippet fires when Project A is
  detected. Once-per-thread means per-entity dedup, not one whisper total.
- There is consequently **no compiled context block and no arbitration problem**: no
  global budget to allocate, no priority ordering to compute per turn. A thread with
  two people and a project pays roughly three whispers over its lifetime, each at the
  moment of maximal relevance. This supersedes the single compiled
  "RELATIONSHIP CONTEXT" block sketched in `contextual-relationship-memory.md`.
- Mid-thread entity entry re-cues by design — the "oh, Dave's here" moment. That
  ordinary retrieval systems never re-cue mid-conversation is part of why this design
  wins.
- Cost self-limits and still beats the output-token + latency + context-pollution cost
  of tool-call loops answering "who is this person / what is Project A."

## Freshness, recency bias, and severity

Concern: LLMs over-index on freshness. Given a dossier derived from months of evidence
plus a few chunks from one recent session, the model may let the single session
overturn the core summary when it was situational. Severity matters the way it does
for humans: catching an honest person in a lie should change one's mind; one 2 a.m.
McDonald's run should not overturn "this person is healthy."

Cheap mitigations (prompt- and schema-level, no math):

- **Prior framing:** the refinement prompt presents the current dossier as a prior
  earned from months of evidence. Revising a core claim requires either (a) direct
  contradiction that cannot be situational (severity), or (b) a repeated pattern
  across multiple sessions (accumulation).
- **Two-tier dossier:** a **core understanding** section (slow-moving; revision
  requires severity or accumulation) and a **recent observations** section
  (fast-moving, cheap to append, allowed to be wrong). Single anomalies land in
  observations; refinement promotes them to core only when the pattern repeats. Core
  claims carry more implicit confidence precisely because they survived multiple
  refinement cycles, composing with the existing epistemic-metadata design.

Do not over-engineer past this until real rough edges hurt.

## Consolidation v0 (decided 2026-08-29)

Keep it simple to start; adjust when it hurts. Anything beats hoping the agent runs
memory_search and gets the right hits just to remember the one person it talks to 99%
of the time.

- A floated v0 was: per entity, take top-K + recent-K hits above minScore and ask
  whether anything materially changed versus the dossier summary.
  `people-whisperer-materialized-relationship-cache.md` already critiques exactly this
  shape: top-K overrepresents the dominant topic and recent-K repeats the MVP flaw.
- **The one piece to keep even in the crudest v0 is the evidence watermark.** Without
  it, "has anything materially changed?" is ill-posed — top-K resamples the same
  dominant chunks every run, old information keeps presenting itself as candidate
  news, and the model re-litigates the whole dossier each cycle. With it, the question
  becomes "here is the dossier; here is only what you have not seen — does any of it
  matter?" That is cheaper and structurally biased against recency over-indexing,
  since the unseen set is small and explicitly labeled as new.
- v0 = **watermark + prior-framed prompt + two-tier dossier.** No weights, no
  frequency analysis, no mini-clusters, no graph structure.
- Defer until a real dossier goes visibly stale or lopsided on Bill:
  cluster-stratified representative sampling, chunk frequency/weighting, mini-clusters
  within a large cluster, and any Unblock Cluster mini-graph expansion. The full
  refresh packet in `people-whisperer-materialized-relationship-cache.md` remains the
  reference design for that next step.

### Immediate People Whisperer slice

Finish the people loop before generalizing the storage model or expanding Cluster:

1. Add a durable per-person evidence cursor and dirty state. The cursor must identify
   processed evidence, not merely compare wall-clock timestamps, so late projection or
   imported history cannot be skipped.
2. Replace the recent-message selector with bounded pages of unseen exact-attributed
   evidence. Include the surrounding conversational exchange, not only isolated messages
   from the person; agreements, agent responses, outcomes, and relationship dynamics live
   in the interaction.
3. Add the two-tier dossier and prior-framed refinement prompt while keeping `blurb` as
   the single bounded materialized injection.
4. Process dirty people outside the interactive path with persistent coalescing, one
   active refinement per person, retry state, and last-good-dossier fallback. A frequent
   operator-owned command that exits immediately when nothing is dirty is sufficient;
   do not add a resident orchestration service yet.
5. Inspect the resulting dossiers and whispers on Bill. Measure stale or incorrect
   claims, missed durable facts, inappropriate anomaly promotion, refinement no-op rate,
   and whether ordinary turns stop reaching for person-identification searches.

Only add person-attributed QMD projection and cluster-stratified refresh packets when
that evidence shows the simpler loop is losing coverage. Current QMD vectors do not carry
arbitrary per-chunk person identity, so exact person scoping will require an intentional
attributed projection or schema extension rather than a search query disguised as one.

## The identity layer (Inside Out synthesis, 2026-08-29)

A years-old "Inside Out" memory model (core memories → personality islands → identity)
was reviewed against the current architecture. The two designs are complementary
halves: the old model is psychology-first (identity, significance, decay), the current
one epistemology-first (evidence, provenance, audit). The synthesis: **identity
structures earned from evidence, with citations.**

Mapping the old hierarchy onto the current stack, the bottom layers already exist —
events (sessions), episodic memory (`memory/`), regularities (`knowledge/`, dossiers;
the curator is the Abstract Thought mechanism). The missing layers are all at the top.

Kept from the old model:

- **The identity kernel should be a curated artifact, not a hand-written file.**
  soul.md / user.md have no path by which memory can revise them today. Islands are
  the sections of an identity document that dreaming maintains like any knowledge
  topic, with the highest revision threshold in the system. The two-tier dossier
  mechanics (core understanding vs. recent observations; severity or accumulation
  required to revise core) are island mechanics applied at self scale. user.md is
  revealed to be the primary user's dossier — the most refined entity in the system,
  maintained by the same consolidation loop.
- **Core-memory status is discovered at consolidation, not tagged at encoding.**
  A memory is core if and only if it changed a durable structure. When refinement
  revises a core claim because of a piece of evidence, mark that evidence; it becomes
  anchoring/protected. No evaluator stage, no extra model calls — the dreamer already
  answers "did this change your understanding?"; persist which evidence made it say
  yes.
- **Weight on knowledge structures.** The regularity layer should not be flat:
  independent-evidence counts, source/session diversity, and last-reinforced timestamps
  are useful context. Island strength is measured, not declared. Raw cluster mass is a
  signal, not a reinforcement count: repeated chatter, correlated episodes, chunking,
  and the agent's own reflections can all inflate it.
- **Abstraction before decay**, relocated: with evidence sacred and storage cheap,
  pruning is dissolved at the evidence layer; decay applies only to *prominence*
  (packet sampling, whisper priority, curated-file content), and only after the
  episode's regularity is captured.

Aged out / discarded: the graph database (pseudo-graph + computed connectivity
signals suffice), the emotion-evaluator console (keep only: significance ≠ semantic
similarity), LoRA/weight compilation (marries identity to one base model and forfeits
model fungibility — the prompt-space kernel is the compilation; revisit only if a
kernel outgrows its budget), dream-as-imagination and Train-of-Thought multi-hop
whispering (real, later).

The consistent direction of evolution: **from designed cognition to earned cognition.**
The old model hand-engineered the psychology; the current one grows the same
structures out of evidence and lets consolidation discover what was previously
hand-tagged.

## Claim-scoped consolidation: clusters as evidence packets (2026-08-30)

Subject-scoped clustering can eventually make consolidation more focused, but clusters
and claims are not one-to-one:

- A mature sub-cluster (e.g. chunks over six months about Mike's eating habits) is a
  **candidate evidence packet** for one or more dossier claims. A claim may span several
  clusters, and one cluster may support several claims.
- New evidence landing near an established theme sharpens the consolidation question
  from "did anything change about Mike?" to "does this evidence reinforce, contradict,
  qualify, or fail to belong with the current claims around this theme?" A core revision
  still identifies the evidence that earned core-memory status.
- Cluster mass, age, source diversity, and distinct-session count give the consolidator
  useful prior context. They do not mechanically determine truth or confidence. Thirty
  near-duplicate chunks from one interaction are not thirty independent confirmations.
- The distribution of a subject's evidence across clusters is an approximate attention
  profile, useful for sampling and discovery rather than a durable model of the subject.

This requires real Unblock Cluster work. The current implementation calls HDBSCAN
`fit_predict`, persists one flat set of run-scoped labels/probabilities/representatives,
and discards the fitted model. It does not persist the condensed tree, a UMAP transform,
or HDBSCAN prediction state. Nested views and between-run approximate assignment are
plausible future capabilities, not existing ones and not merely a matter of "stop
flattening." Start with periodic scoped rebuilds; add online assignment only if rebuild
latency or consolidation freshness makes it necessary.

Constraints:

- **Assessments never live in clusters.** Claims are durable (dossiers, two-tier);
  clusters are the rebuildable evidence view, re-linked to claims by membership
  overlap and cited evidence after each rebuild. A failed re-link (a claim whose
  supporting cluster dissolved) is an attention signal, not automatic retraction.
- **Structure is earned.** Thin evidence (5–15 chunks) stays one undifferentiated
  cluster; the min-cluster-size floor gates sub-cluster formation. Matryoshka depth
  is information: no nuanced model of someone met twice.

## The boundary: stable subjects, disposable cluster views (2026-08-30)

The typed entity ontology can still be deleted; the durable subject cannot. **A subject
is a stable address for accumulated understanding. A cluster is a disposable view over
some of its evidence.** A person remains the same subject when their themes split or
merge. Exact triggers, policy, human corrections, evidence citations, and the dossier
must survive every recluster.

Three rules keep the boundary small:

1. **Exact triggers establish attribution and scope.** Embeddings capture topic, not
   attribution; a purely semantic "Mike" population collects chunks about things Mike
   discusses, including Alice's work. Exact identity establishes the Mike evidence
   population; semantic organization happens only inside or across explicitly attributed
   populations.
2. **It is a forest of views over one evidence pool.** One chunk can involve Mike,
   Project X, and a channel. Subject scopes overlap, so the same canonical chunk may
   participate in several derived cluster runs. Within-scope nesting is a future view,
   not durable identity.
3. **The salience gate is the delivery product.** A subject cannot whisper until it has
   a materialized blurb and explicit injection policy. Exact triggers can use looser
   relevance gates because attribution is known; semantic triggers must earn injection
   through conservative thresholds and cooldowns.

**Graduation:** an emerged semantic theme may cause dreaming to propose a new durable
subject. Creating that subject and optionally binding an exact trigger (repo path, ticket
prefix, channel ID) gives it a stable address; it does not make a run-scoped cluster ID
durable. Some idea subjects may remain semantic-only indefinitely. Personality islands
are durable identity claims informed by the strongest evidence themes in the self scope,
not aliases for those clusters.

**Minimal durable concepts** for the eventual architecture:

1. **Evidence and attribution** — canonical chunks plus exact or explicit subject edges.
2. **Subjects** — stable addresses with no required type-specific ontology.
3. **Trigger bindings and policy** — exact or semantic cues tied to a subject.
4. **Claims, blurbs, and evidence cursors** — curated two-tier understanding keyed to
   subjects and citing evidence.

Clusters, trees, mass, arrival events, layouts, and representative selections remain
derived and disposable. This is the eventual shared model, not a request to replace the
working PeopleSQL tables before the second entity type exists.

## Decisions captured

- People Whisperer is the POC for general entity whispering; entities are people,
  places, things, and ideas.
- Generalize along the trigger axis (exact vs. semantic), not the entity-type axis;
  People Whisperer proves exact lookup and Skill Whisperer proves semantic cueing, not
  yet arbitrary semantic-subject quality.
- **Superseding refinement (2026-08-30): subjects are durable; clusters are disposable
  views over subject evidence.** Delete the typed ontology, not the stable address.
  Exact attribution scopes populations before semantic organization; overlapping views
  form a forest over one shared evidence pool.
- Whispering serves listening-mode; memory_search serves thinking-mode (background
  consolidation, dreaming, curation, deep dives).
- Injection is event-driven, once per thread per entity, budgeted per whisper
  (~200–600 tokens); no global compiled context block, no arbitration layer.
- Mid-thread entity arrival triggers that entity's whisper.
- Dossiers are materialized views: expensive at write time, near-free and instant at
  read time, no model call on the injection path.
- Guard against recency over-indexing with prior framing and a two-tier dossier
  (core understanding vs. recent observations); severity or accumulation is required
  to revise core claims.
- Consolidation v0 keeps the evidence watermark and skips weights, stratified
  sampling, and graph structure until real usage hurts. The immediate slice adds a
  durable evidence cursor, surrounding interaction evidence, two-tier refinement, and
  persistent dirty/coalesced processing, then evaluates the result on Bill.
- Sequencing: finish people → places/channels → extract the shared subject seam →
  semantic idea subjects → the self scope.
- Endgame: the static system prompt shrinks to a personality kernel; situational rules
  migrate into cued entity dossiers.
- The identity kernel (soul.md / user.md) should eventually be a curated artifact
  maintained by dreaming with the highest revision thresholds; user.md is the primary
  user's dossier.
- Core-memory status is earned retroactively: a memory is core iff it changed a
  durable structure.
- Clusters are candidate evidence packets, not claims. Mass, age, distinct-session count,
  and source diversity inform consolidation but do not mechanically determine confidence.
- Assessments live in durable claims, never in disposable clusters; re-link by
  cited evidence and membership overlap after rebuilds.
- Structure, blurbs, and whisper eligibility are earned through evidence and explicit
  subject policy; injection is default-off at every layer.
- HDBSCAN hierarchy and approximate membership are future Unblock Cluster work. The
  current implementation persists flat run-scoped output and no prediction state.
- Discarded from the old Inside Out model: graph database, emotion-evaluator console,
  LoRA compilation (for now), encoding-time significance tagging.
