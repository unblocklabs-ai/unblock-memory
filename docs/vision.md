# Unblock Memory — Vision

**Written 2026-08-29.** This is the whole-product vision as it stands today,
synthesized from the planning documents, the shipped MVP, and the direction
conversations consolidated in `planning/entity-whispering-direction.md`. It describes
the destination; the README describes what is implemented. Where this document
conflicts with older planning documents, prefer this one and the direction doc.

## One sentence

Unblock Memory is a cognitive architecture for long-lived agents: it turns everything
an agent experiences into evidence, grows that evidence into organized understanding,
and delivers the right slice of that understanding at the right moment — so that the
agent's accumulated, auditable knowledge of its world, its people, and itself becomes
the durable asset, independent of whichever model happens to be running underneath.

## The problem

Current agent memory is inverted relative to how minds actually work. Everything is
either permanently in-context (a ten-thousand-token system prompt rehearsing every
rule on every turn, the way no human walks into a store consciously holding their
coding standards) or behind hopeful deliberate retrieval (memory_search, which
requires the agent to know it doesn't know, phrase the right query, and synthesize
raw chunks — every session, for the same lookups, forever). An agent that has talked
to the same person for hundreds of sessions re-derives who they are each time. That
wastes seconds, wastes tokens (output tokens, the expensive ones), and produces worse
answers than precomputed understanding would.

The ultimate constraint in LLMs is context: every token biases the response. The
answer is not more retrieval or a bigger prompt. It is the middle layer both
approaches are missing.

## The model: recognition and recollection

Human memory runs on two systems, and Unblock Memory implements both:

- **Recognition (whispering):** involuntary, instant, cued by the environment. When
  something enters the conversation — a person, a channel, a project, a topic — its
  precomputed understanding is injected before any tool call. Seeing a red car recalls
  your first red car; it does not recall your commenting rules. Cues activate what is
  relevant and nothing else.
- **Recollection (memory_search):** deliberate, effortful recall for genuine
  thinking. Its heavy consumers are background processes — dreaming, curation,
  refinement — and the occasional deep conversational dive, not ordinary inbound
  turns.

The interactive path recognizes; the background path thinks. **No model call ever
runs on the injection path** — whispers are local SQLite lookups of understanding
that was consolidated asynchronously, off the hot path, with the full evidence base
and time to think. A dossier is a materialized view: expensive once at write time,
near-free hundreds of times at read time, and more accurate than any just-in-time
retrieval because consolidation saw everything while a search sees five chunks.

## The architecture: everything is clusters

There is no entity ontology. No schema for people, projects, companies, channels, or
ideas. **An "entity" is a cluster that has acquired an exact trigger.** Ontology is
clustering output, not design input.

```text
Workspace Markdown + session transcripts        (evidence — canonical, sacred)
                    │
                    ▼
            QMD semantic index                  (chunks + vectors — rebuildable)
                    │
                    ▼
        The cluster forest (unblock-cluster)    (derived — disposable)
   scoped, nested cluster trees over one shared chunk pool
                    │
                    ▼
        Claims, dossiers, knowledge, kernel     (curated understanding — durable)
                    │
                    ▼
              Whispers + search                 (delivery)
```

### Evidence is sacred; understanding is earned; analysis is disposable

Three regimes, never confused:

1. **Evidence** — raw Markdown memory and projected session transcripts. Immutable,
   never silently rewritten or deleted. Pruning is a non-problem: storage is cheap,
   and decay applies only to *prominence* (what gets sampled, whispered, kept in
   curated files), never to the record.
2. **Derived analysis** — indexes, clusters, layouts, arrival events. Rebuildable
   from evidence at any time; marked stale rather than trusted blindly; carries no
   irreplaceable state.
3. **Curated understanding** — dossiers, knowledge topics, and eventually the
   identity kernel. Durable, evidence-cited, epistemically qualified, revised only
   through consolidation.

### The cluster forest

Clustering is the universal organizing mechanism, with one designed seam: **exact
attribution scopes populations before clustering organizes within them.** Embeddings
capture topic, not attribution — a purely semantic "Mike" cluster would collect
chunks about things Mike discusses, including other people's work (the Bob/Alice
failure). So exact identity (sender ID, channel ID, repo path) defines which chunks
belong to a scope, and semantic clustering discovers structure *inside* it: Mike's
scope sub-clusters into his eating habits, his project work, his preferences —
matryoshka nesting, which HDBSCAN's condensed hierarchy provides natively.

It is a forest, not one tree: a single chunk can involve a person, a project, and a
channel, so scopes are overlapping populations over one shared chunk pool. Clusters
are lenses; chunks are canonical.

Structure is earned. Thin evidence stays one undifferentiated cluster until mass
justifies sub-clusters. Matryoshka depth is itself information: the primary user's
scope has a dozen sub-clusters; a person met twice has none — exactly as it should
be.

### Clusters are evidence ledgers for claims

A mature sub-cluster — 30 chunks over 6 months about one theme — is the evidence
ledger behind one dossier claim. This makes consolidation **claim-scoped and
event-driven**:

- A new chunk is assigned to its nearest sub-cluster (approximate membership, no
  re-cluster needed). Its arrival is the event "new evidence in an open case,"
  pre-routed to the exact belief it bears on.
- The dreaming question sharpens from "did anything change about Mike?" to "this
  chunk landed in *eating habits* (30 chunks / 6 months): reinforce, contradict, or
  doesn't belong?"
- **Cluster mass × age is the quantitative prior.** One chunk against thirty rarely
  revises a claim; the same chunk in a two-chunk cluster is legitimately formative.
  This defeats LLM recency bias with arithmetic instead of hope: a single 2 a.m.
  McDonald's run does not overturn "this person is healthy," but catching an honest
  person in a lie does — severity or accumulation, measured.
- Claims are two-tier: **core understanding** (slow-moving, revision requires
  severity or accumulation) and **recent observations** (fast-moving, cheap, allowed
  to be wrong). Refinement promotes observations to core when patterns repeat.
- Assessments never live in clusters. Claims are durable; clusters are rebuildable
  views re-linked to claims by membership overlap after each rebuild. A claim whose
  evidence cluster dissolves is itself an attention signal.
- An **evidence watermark** keeps consolidation honest: refinement sees the current
  claims plus only unseen evidence, so old dominant chunks stop presenting
  themselves as news, and "has anything materially changed?" becomes well-posed.

### Core memories are discovered, not tagged

A memory is core **if and only if it changed a durable structure.** When
consolidation revises a core claim because of a piece of evidence, that evidence is
marked — it earned anchoring status retroactively, at the moment it demonstrably
mattered. No significance evaluators at encoding time, no extra model calls: the
dreamer already answers "did this change your understanding?"; the system persists
which evidence made it say yes. (Truer to life than the movie: you rarely know a
moment was formative until later.)

## Whispering: delivery

- **Two trigger types, one mechanism.** Exact triggers (sender ID, channel ID, repo
  path, ticket prefix) fire deterministic lookups — zero inference, zero false
  positives. Semantic triggers (centroid similarity with a minScore and cooldown)
  cover ideas and topics. People Whisperer proved the exact path; Skill Whisperer
  proved the semantic path; the general whisperer is their marriage.
- **Event-driven, once per thread per entity.** Person A's blurb fires when Person A
  starts the thread; Person B's fires when they chime in; a project's fires when
  detected. The budget (~200–600 tokens) is per whisper, not global. There is no
  compiled context block and no arbitration layer — injection is incremental,
  self-limiting, and lands at the moment of maximal relevance. Mid-thread re-cueing
  ("oh, Dave's here") is a first-class feature no retrieval system has.
- **Salience gates are the product.** A cluster cannot whisper until it has a
  materialized blurb; it does not earn a blurb until dreaming judged it mature;
  minScore and cooldown gate firing. Injection is default-off and earned at every
  layer. Exact-triggered clusters may run looser gates; semantic-only clusters face
  the full gauntlet — a false-positive injection is worse than none.

### Graduation: the entity lifecycle

Entities are not a kind of thing; they are a **lifecycle stage of clusters.** Chunks
accumulate → a dense cluster emerges in some scope → dreaming names it and writes its
first blurb → an exact trigger is bound to it (by agent proposal or human
confirmation) → evidence now routes deterministically and the cluster gains a scope
of its own. Promotion from idea to entity is a trigger acquisition, not a type
change.

## Dreaming: the consolidation loop

Nightly (or activity-driven), only when evidence changed, and quiet when nothing did:

1. Rebuild or incrementally update the cluster forest.
2. Diff against the previous run — expanded, contracted, new, split, merged clusters;
   arrival events in mature ledgers.
3. Wake the agent with structured, claim-scoped packets: current claim, mass and age,
   unseen evidence only.
4. The agent reinforces, revises, records an observation, seeds a new theme, or —
   crucially — writes nothing. No-op is a valid and desirable outcome.
5. Its writes are indexed and participate in the next cycle, never triggering another
   dream in the same cycle.

Reflections deliberately re-enter the clustering universe, so tomorrow's dream sees
yesterday's conclusions beside the raw evidence. Recursive self-reference is an
intentional, observable experiment: epistemic type, evidence lineage, self-citation
depth, and raw-to-derived ratios stay visible so both the agent and the human can
distinguish external evidence from the agent's own prior interpretation. The response
to recursion risk is observability, not prohibition.

## The identity layer: earned, not written

The endgame is the **system prompt diet.** Most of what lives in agents.md / user.md
today is entity dossiers wearing a global-rule costume: "how I behave in #support" is
a place dossier; "rules around the primary user" is a person dossier; "how I write
code" is a situation dossier cued by being in a repo. As whispering matures, the
static prompt shrinks toward the genuinely always-on personality kernel, and
everything situational becomes cued. This is not merely token savings — every context
token biases behavior, so the agent talking to a family member should not be spending
attention on coding rules at all.

The final step: **the kernel itself becomes a curated artifact.** Today soul.md and
user.md are hand-written and frozen while everything below them evolves. Eventually
they are maintained by the same consolidation loop as any dossier — user.md is
revealed to be the primary user's dossier, the most refined entity in the system —
with the highest revision thresholds anywhere: identity has persistence without being
immutable. Personality islands, in Inside Out terms, are simply the highest-mass
clusters in the self scope, and their strength is measured, not declared. The design
philosophy throughout is **earned cognition over designed cognition**: grow the
structures out of evidence and let consolidation discover what older designs
hand-engineered.

Deliberately rejected: a graph database (the pseudo-graph — scopes, overlap, and mass
computed from existing structures — suffices), emotion-evaluator consoles (keeping
only the insight that significance ≠ semantic similarity), and LoRA/weight
compilation of identity (it marries the agent to one base model; the prompt-space
kernel *is* the compilation, and model fungibility is the point — the memory is the
moat, the model is swappable).

## The minimal durable schema

The entire architecture rests on three durable concepts:

1. **Chunks** — evidence. Sacred, immutable, attributed.
2. **Trigger bindings** — `(kind: exact | semantic, key or centroid, scope,
   injection policy)`. The one designed seam, because attribution cannot be inferred
   from topic.
3. **Claims/blurbs** — curated two-tier understanding, keyed to scopes, citing
   evidence, re-linked to clusters by overlap after rebuilds.

Everything else — indexes, clusters, trees, mass, layouts, arrival events — is
derived and disposable.

## The human surface

Every derived conclusion links back to the evidence that produced it. The eventual
memory-map UI lets a human watch an agent's understanding reorganize over weeks —
themes forming, splitting, merging; reflection chains deepening; self-referential
loops becoming visible; noise and duplicates surfacing for review. For an agent
employee, this is the trust product: the answer to "what does this thing actually
know about us, and why does it believe it?" Human corrections outrank inferred facts;
identity merges are explicit, auditable, and reversible; audience awareness governs
what may be disclosed where.

## What it is ultimately for

Persistent agent employees. The model is fungible; an agent's two years of
accumulated, curated, provenance-tracked understanding of one organization — its
people, places, projects, norms, and its own hard-won conclusions — is not. Unblock
Memory is the substrate that makes an agent worth *keeping* rather than respawning,
and that lets a better model be swapped underneath the same accumulated self.

RAG answers "what happened before?" This system is built to answer the deeper
question: **"given everything that has happened before, who am I now?"**

## Where we are and what comes next

Shipped (MVP): corpora over workspace Markdown; semantic search and reads; session
projection with speaker labels and exact metadata filters; clustering, cluster reads,
and chronology via unblock-cluster; the maintenance inbox (ambiguous event times,
duplicates — attention signals, never auto-edits); PeopleSQL with exact Slack
attribution, Codex dossier refinement, and once-per-session injection; Skill
Whisperer; the memory-curator skill.

Sequencing from here, each step gated on the previous proving itself on a real agent:

1. **People** — the whisper loop on autopilot: watermark-based refinement,
   prior-framed prompts, two-tier dossiers, activity-driven refresh.
2. **Places/channels** — exact triggers again; the audience-awareness slice.
3. **Entity-scoped nested clustering** — ledgers, arrival events, mass-as-prior,
   claim-scoped dreaming packets.
4. **Semantic idea clusters and graduation** — the full trigger lifecycle, with
   salience dials calibrated by Skill Whisperer experience.
5. **The self scope** — kernel as curated artifact; islands measured from mass.
6. **The memory map** — the human audit surface, throughout.

The standing engineering discipline applies to all of it: exact attribution before
semantic organization; nothing expensive on the hot path; evidence never destroyed;
derived state always rebuildable; injection default-off and earned; no
prompt-controlled paths or arbitrary execution; simple first, adjusted when the rough
edges actually hurt.
