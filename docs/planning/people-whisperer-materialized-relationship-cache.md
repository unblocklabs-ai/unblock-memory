# People Whisperer — Materialized Relationship Cache

Status: current planning direction, not yet implemented.

## Goal

When a known person first appears in a session, the agent should receive a fresh,
precomputed understanding of that person through a near-instant local lookup. There is no
interactive memory search, summarization, or model call. More dynamic thought injection
during a conversation is explicitly later scope.

## Architecture

People Whisperer should be a **materialized relationship cache**:

1. exact interaction evidence is associated with a person;
2. QMD/Cluster organize the person's complete evidence into representative themes;
3. an asynchronous consolidator refreshes the dossier only after the person generated
   meaningful new evidence;
4. the stored blurb is injected once per person per session through the existing fast
   SQLite path.

The expensive work happens after interaction, not when recognition is needed.

## The pseudo graph

Do not add a graph database yet. The existing systems already form a small graph:

```text
Person (PeopleSQL)
  -> exact scoped identities
  -> attributed relationship documents/chunks (QMD)
  -> semantic theme membership (Cluster)
  -> evidence-backed dossier claims
  -> materialized blurb
```

Unblock Cluster's Data Graph is currently a record/embedding/view/cluster model, not a
general node-edge entity graph. Reusing it as the canonical people store would duplicate
PeopleSQL and add a service boundary. The minimal implementation is relational/implicit:
PeopleSQL owns people and identity; identity-keyed derived document paths provide the
person-to-evidence edge; QMD owns chunks; Cluster membership provides chunk-to-theme
edges; the dossier is the materialized view.

## Exact attribution before semantic organization

Do not assign a chunk to a person solely because it is semantically similar to that
person's embedding or centroid. Embeddings primarily capture topic. If Bob and Alice both
work on deployments, Alice's deployment evidence may be closer to Bob's centroid than
Bob's grocery preference. That produces a confident-looking but incorrect dossier.

Use exact structured attribution to establish the person edge. Use semantic similarity
only **after attribution** to cluster, rank, diversify, and discover candidate unstructured
evidence. Later, semantically discovered cross-memory candidates can be added as explicit
low-confidence candidate edges, but they should not silently become person evidence.

## Refresh packet

For one dirty person, consolidate from:

- the current dossier, for continuity and explicit claim retention;
- every unseen exact-attributed chunk since the prior evidence watermark, bounded high
  enough not to drop a busy session;
- one or two person-specific representative chunks from each of the strongest semantic
  clusters, subject to Cluster's membership/probability floor;
- the most recent K prior chunks, to retain current work and open loops; and
- a very small number of high-outlier/noise chunks, because novel personal facts often
  look like outliers.

This is stronger than `top K + recent K` alone. Top global hits overrepresent a dominant
topic, while recent-only repeats the MVP flaw. Cluster-stratified representatives provide
coverage, unseen chunks provide freshness, recent chunks preserve current state, and the
old dossier prevents stable facts from disappearing merely because they were not sampled.

## Activity-driven refresh

- During a session, exact observation marks that person's evidence dirty. Current thread
  context already covers the ongoing interaction, so the injected blurb does not change.
- When the session becomes idle/ends, enqueue projection, incremental QMD embedding, and
  dossier consolidation for only the people who produced new evidence.
- Persist the evidence watermark/dirty state so Gateway restart does not lose work.
- Coalesce repeated turns/sessions for the same person and allow only one active refresh.
- If no new evidence exists, do nothing indefinitely. A person not seen for two weeks is
  not refreshed for two weeks.
- On the next session, inject the completed cached blurb once using the existing local
  lookup. If refresh failed, retain the last good blurb and retry asynchronously.

The freshness invariant is therefore: **the dossier should reflect all successfully
processed evidence from prior completed sessions**, not "was refreshed today."

## Lean implementation sequence

1. Replace the recent-20 evidence selector with exact person evidence plus a durable
   evidence watermark; keep manual CLI refinement initially.
2. Add person-attributed relationship projection into QMD so the full history is
   semantically chunked and linked by exact identity.
3. Build the cluster-stratified + unseen + recent evidence packet and inspect it on Bill.
4. Refine the existing typed dossier/blurb from that packet; do not invent a second profile
   schema or a graph service.
5. Add persistent dirty/coalescing orchestration at session idle/end, making refinement
   automatic and restart-resilient.
6. Keep the existing once-per-session injection path and prove it remains a local SQLite
   lookup with no QMD/model work.

## Sources reviewed

- `docs/peoplesql.md`
- `docs/planning/bek-aug25.md`
- `docs/planning/contextual-relationship-memory.md`
- `docs/planning/enhacements-aug25.md`
- `docs/planning/future-features.md`
- `docs/planning/memory-consolidation-and-reflection.md`
- current PeopleSQL evidence, refinement, storage, and prompt-hook implementation
- QMD semantic chunking and exact vector-filter implementation
- Unblock Cluster records, views, memberships, representative selection, and QMD adapter
