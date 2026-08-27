# Future Features

## Scoped clustering

Allow an agent to rebuild clusters from a selected subset of the configured
memory corpora instead of always clustering every non-skill corpus together.

Examples:

- cluster only the `memory` corpus;
- cluster only `sessions`;
- cluster `memory` and `knowledge` together;
- cluster memory whose event occurred during the past 30 days.

A possible `memory_recluster` input is:

```json
{
  "corpora": ["memory"],
  "eventTime": {
    "from": "2026-07-27T00:00:00Z",
    "to": "2026-08-26T23:59:59Z"
  }
}
```

Both filters should be optional. Omitting both preserves the current behavior
of clustering all configured non-skill corpora. The isolated skills corpus must
remain excluded.

### Corpus scope

Corpus scoping should resolve the requested logical corpus names to their QMD
collection IDs before invoking the analysis worker. The worker already accepts
a collection allowlist, so this should require only narrow plugin plumbing and
validation.

Use the same corpus-selection rules as `memory_search`:

- reject an empty list;
- reject unknown corpus names;
- allow multiple named corpora;
- if `all` is supported, require it to appear alone and interpret it as every
  non-skill corpus.

### Time scope

Apply the time range to the input population **before** UMAP and HDBSCAN run.
Filtering members from clusters produced over the global population would
answer a different question: it would show recent members of existing clusters,
not the natural topics within recent memory.

Time filtering should use resolved event time rather than raw filesystem or QMD
modification time. Prefer, in order:

1. session start time;
2. a date encoded in the source path;
3. an agent-verified temporal annotation.

Do not silently treat source modification time as event time for a bounded
cluster run. Documents with ambiguous event time should be excluded from the
bounded population and remain eligible for the existing maintenance inbox so
the agent can investigate and annotate them.

Use explicit ISO 8601 `from` and `to` boundaries in the tool contract. An agent
can calculate “the past 30 days” before calling the tool, while the stored run
scope remains deterministic and auditable.

### Retention and UX

The current analysis worker retains only the latest clustering run. Keep that
behavior for the first implementation: a scoped run replaces the previous
all-corpora or differently scoped run.

To prevent confusion:

- persist the selected corpora and event-time boundaries in the run parameters;
- return the scope from `memory_recluster`, `memory_list_clusters`, and
  `memory_fetch_cluster`;
- make it clear that calling `memory_recluster` without filters restores the
  all-corpora analysis.

Do not add named analyses or retain multiple runs until real usage demonstrates
that agents need simultaneous global and scoped cluster views.

### Lean implementation sequence

1. Add optional `corpora` and `eventTime` parameters to `memory_recluster`.
2. Resolve corpus names to the existing QMD collection allowlist.
3. Extend the analysis worker to filter active vectors by resolved event time.
4. Persist and expose the effective scope with the analysis run.
5. Add focused tests for corpus-only, time-only, combined, ambiguous-date, and
   unfiltered behavior.


## Cluster activity

Show which clusters were most active during a selected period, such as the
past 24 hours or seven days. The agent should be able to retrieve both the top
K representative chunks and the top K recent chunks from that period, then use
them to create new observations or identify areas worth exploring.
