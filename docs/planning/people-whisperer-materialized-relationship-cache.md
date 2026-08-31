# People Whisperer — Materialized Relationship Cache

Status: superseded for People Whisperer maintenance by
[`people-whisperer-agent-owned-dossiers.md`](people-whisperer-agent-owned-dossiers.md).

This document remains historical exploration of exact attribution and possible future
QMD/Cluster organization. Its plugin-owned maintenance mechanics are not the current
implementation direction. Current maintenance is documented in the linked plan and the
bundled `$people-whisperer` skill.

## Historical goal

The proposal aimed to give the agent a fresh, precomputed understanding of a known
person through a near-instant local lookup. It kept interactive memory search,
summarization, and model calls off the injection path.

## Historical architecture proposal

The proposal treated People Whisperer as a **materialized relationship cache**:

1. exact interaction evidence is associated with a person;
2. QMD/Cluster organize the person's complete evidence into representative themes;
3. an asynchronous consolidator refreshes the dossier only after the person generated
   meaningful new evidence;
4. the stored blurb is injected through the fast SQLite path.

Its durable insight remains: expensive work belongs outside the recognition path.

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

## Deferred evidence-organization research

If ordinary agent-directed search proves insufficient, a future consolidator could
investigate:

- the current dossier, for continuity and explicit claim retention;
- exact-attributed interaction evidence;
- one or two person-specific representative chunks from each of the strongest semantic
  clusters, subject to Cluster's membership/probability floor;
- the most recent K prior chunks, to retain current work and open loops; and
- a very small number of high-outlier/noise chunks, because novel personal facts often
  look like outliers.

This research is stronger than `top K + recent K` alone. Top global hits overrepresent a
dominant topic, while recent-only repeats the MVP flaw. Cluster-stratified
representatives diversify themes, recent chunks preserve current state, and the old
dossier prevents stable facts from disappearing merely because they were not sampled.

## Current maintenance boundary

- The plugin observes exact Slack identities, stores dossiers, and injects
  `dossier.blurb` once per person per thread.
- The agent chooses whom, when, and how to investigate with ordinary memory search and
  optional session sync.
- The agent directly replaces a dossier only when doing so would make future
  conversations meaningfully better. It may update several people or nobody.
- `reviewedAt` records a successful dossier write; it is not scheduling state.
- The plugin does not promise that every interaction has been reviewed.

## Deferred research sequence

Only if tests on Bill show ordinary agent-owned maintenance is losing important context:

1. Add exact person attribution to a derived QMD projection.
2. Compare cluster-stratified representatives with ordinary targeted memory search.
3. Improve evidence organization only where it materially improves dossiers.
4. Keep `dossier.blurb` as the sole injected artifact and the injection path as a local
   SQLite lookup with no QMD/model work.

## Sources reviewed

- `docs/peoplesql.md`
- `docs/planning/bek-aug25.md`
- `docs/planning/contextual-relationship-memory.md`
- `docs/planning/enhacements-aug25.md`
- `docs/planning/future-features.md`
- `docs/planning/memory-consolidation-and-reflection.md`
- the PeopleSQL storage and prompt-hook implementation at the time of the proposal
- QMD semantic chunking and exact vector-filter implementation
- Unblock Cluster records, views, memberships, representative selection, and QMD adapter
