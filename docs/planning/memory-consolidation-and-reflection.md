# Unblock Memory Consolidation and Reflection Cycles

## Status

Planning document. This describes the intended end state and a lean path to prove it.
It is not a claim that the integration, scheduler, metadata model, or agent tools already
exist.

### Current MVP decision (2026-08-26)

The shipped curator workflow supersedes this document's separate canon and reflection
outputs with one `knowledge` corpus backed by stable `knowledge/<topic>.md` files. Facts,
agent assessments, and uncertainty may coexist when each claim is qualified where it
appears. Clusters are incomplete attention signals: the agent investigates beyond the
selected cluster, then updates current knowledge or writes nothing. Historical sections
below remain design context, not the current curator contract.

The existing [QMD Memory Bundle v1](https://github.com/unblocklabs-ai/unblock-cluster/blob/main/docs/planning/qmd-memory-bundle-v1.md)
remains the portable and remote import contract. Directly reading QMD SQLite is the
preferred local integration for the first working version.

## Vision

QMD and Unblock Cluster should give an OpenClaw agent two complementary ways to
understand memory:

- **QMD provides micro retrieval:** "Which memories answer this question?"
- **Unblock Cluster provides macro understanding:** "What does my memory contain, how
  is it organized, what changed, and what no longer fits?"

Together they enable a recurring memory-consolidation process, called **dreaming** in
the agent experience. During a dream, an agent examines the current structure of its
memory, compares that structure with the previous run, reasons about meaningful
changes, and creates new reflections or updated knowledge artifacts when warranted.

This serves two equally important users:

1. The human gets a visual, auditable map of the agent's memory. Noise, duplication,
   irrelevant material, contradictions, and oversized themes become much easier to
   inspect than they are in a directory of Markdown files.
2. The agent gets a metacognitive loop. It can revisit everything it knows about a
   topic, see its earlier conclusions beside newer evidence, and decide whether its
   current understanding should change.

The goal is not to turn clusters into canonical truth. Clusters are derived,
rebuildable analysis. Canonical memory remains Markdown indexed by QMD.

## Example: Rico

Assume an agent named Bill has a cluster about a person named Rico. The cluster may
contain:

```text
Rico cluster
├── Raw memory: Rico works at Company A
├── Raw memory: Rico prefers email
├── Raw memory: Rico left Company A
├── Bill's prior reflection: the employment information appears stale
├── Bill's inference: Rico may be changing industries
└── Curated understanding: Rico previously worked at A; current role is unknown
```

When new Rico content arrives, Bill should receive the complete cluster, including his
own prior reflections. He can then decide whether the new material:

- confirms an existing conclusion;
- weakens or contradicts it;
- represents a real change over time rather than a contradiction;
- makes an older memory historically valid but no longer current;
- supports a genuinely new inference; or
- does not materially change his understanding.

Bill might produce a current synthesis such as:

```markdown
# Rico — Current Understanding

As of 2026-08-24:

- Rico previously worked at Company A but has since left.
- Rico currently prefers Signal; older memories mentioning email appear stale.
- Rico is no longer involved in Project X.

## Inference

Rico may be changing industries. This is not yet confirmed.

## Unresolved

It is unclear whether Rico left Project X voluntarily.

## Evidence

- qmd://memory/...
- qmd://memory/...
```

The older memories are not necessarily wrong and should not be silently deleted. They
remain evidence of what was known at an earlier time. The new artifact records Bill's
current interpretation and its provenance.

## Product principles

### Preserve evidence; derive understanding

Dreaming may create reflections, inferences, or curated summaries. It must not silently
rewrite or delete raw memory. A conclusion can mark another claim as stale or
superseded while retaining the underlying evidence.

### Reflections participate in clustering

Agent-created reflections must remain visible in later cluster runs. Hiding yesterday's
reflection would cause the agent to repeatedly rediscover the same conclusion and would
prevent it from reasoning about how its own beliefs evolved.

The recursive loop is intentional. We want to observe whether capable models can
distinguish evidence from their own earlier interpretation and how their long-term
reasoning changes over time. The system should make that recursion visible and
reversible rather than preventing it.

### Provenance is separate from semantic grouping

Raw memories, reflections, inferences, and curated summaries about Rico should all be
eligible for the Rico cluster. Their properties describe and color them; those
properties should not force them into separate semantic universes.

### Daily files are containers, not semantic units

The QMD fork uses semantic chunking. A single daily memory or reflection file may
contain unrelated topics; QMD splits it at semantic boundaries before embedding it.
Unblock Cluster must consume QMD's stored semantic chunks directly and must not impose
one-file-per-topic rules or re-chunk the source documents.

### Automation should be quiet when nothing changed

The end state is automatic, preferably with a default nightly schedule that does not
require a manually configured cron job for every agent. A scheduled wake-up is not a
requirement to write. If the indexed memory did not change, the run should stop. If a
changed cluster does not alter the agent's understanding, the agent may produce no new
durable artifact.

### The human remains able to audit the system

Every derived conclusion should link back to the memory items used to create it. The UI
should expose those chains and make recursive self-reference, repeated conclusions,
noise, and stale claims easy to see.

## Conceptual layers

```text
New experiences and Markdown memory
                 │
                 ▼
          QMD semantic index
       exact chunks and vectors
                 │
                 ▼
        Unblock Cluster snapshot
    topics, noise, duplicates, layout
                 │
                 ▼
       Cluster change comparison
  new, changed, split, merged, outlier
                 │
                 ▼
          OpenClaw dream turn
     reason over changed clusters
                 │
                 ▼
      Reflections and reconciliations
       written as canonical Markdown
                 │
                 └──────► indexed by QMD on the next cycle
```

The four durable conceptual layers are:

1. **Raw memory:** what happened or was recorded.
2. **QMD index:** searchable semantic chunks and their vectors.
3. **Cluster analysis:** disposable, reproducible maps and run history.
4. **Derived memory:** reflections, reconciliations, and curated current knowledge.

## System ownership

```text
OpenClaw agent
  └── unblock-memory plugin
        ├── canonical Markdown memory
        ├── per-agent QMD SQLite
        ├── memory search/get tools
        └── memory map and dreaming orchestration
              └── Unblock Cluster
                    ├── read-only QMD SQLite adapter
                    ├── immutable analysis snapshots
                    ├── cluster and layout runs
                    ├── cluster change comparison
                    └── human web UI
```

The dependency direction should remain:

```text
unblock-memory → Unblock Cluster
```

QMD should not depend on Unblock Cluster. QMD owns indexing and retrieval. Cluster owns
derived macro analysis. The OpenClaw plugin is the agent-facing integration surface.

## Direct QMD SQLite integration

### Trusted database path

The plugin already derives the database path from the active agent identity:

```text
~/.openclaw/agents/<agentId>/unblock-memory/index.sqlite
```

The plugin should pass that trusted path to Cluster. It should not expose an arbitrary
`sqlitePath` tool argument to the model; an agent should not be able to inspect another
agent's database or an unrelated SQLite file through prompt-controlled input.

For standalone human use, Cluster may accept an explicit source configuration:

```json5
{
  sources: {
    "bill-memory": {
      type: "qmd-sqlite",
      path: "/absolute/path/to/index.sqlite"
    }
  }
}
```

Manual paths must be absolute, exist, be readable SQLite databases, and contain the
expected QMD schema.

### Adapter behavior

Add a direct QMD source adapter under `datagraph/external_vectors/`, sharing the same
internal `ExternalChunk` and persistence service as the portable bundle importer. It
should:

1. Open QMD SQLite using URI `mode=ro`.
2. Load the matching `sqlite-vec` extension into the Python SQLite connection.
3. Set `PRAGMA query_only=ON`.
4. Begin one read transaction so the import sees a consistent WAL snapshot.
5. Validate required tables and columns before reading data.
6. Read active logical documents and complete embedded chunk sets only.
7. Reconstruct exact embedded text with the stored character position and length:

   ```text
   content.doc.slice(content_vectors.pos, pos + chunk_len)
   ```

8. Read the original float vectors from QMD's `vectors_vec` virtual table.
9. Require one coherent model, embedding fingerprint, dimension, and normalization
   space per import.
10. Preserve collection, path, title, timestamps, character span, sequence, embedding
    fingerprint, and metadata.
11. Preserve separate logical path aliases while deduplicating shared vector bytes by
    content hash, sequence, and fingerprint.
12. Generate a deterministic snapshot identity from the source rows and embedding
    space.
13. Import through Cluster's existing immutable record, tombstone, provenance, and
    historical-run machinery.

Do not use SQLite `immutable=1`; doing so can ignore current WAL state. Reject legacy
rows with missing or zero chunk lengths rather than guessing or re-chunking.

Cluster's Python dependencies do not currently include `sqlite-vec`. The implementation
must add and verify the Python package matching QMD's `sqlite-vec` version. Its loading
API and returned vector representation should be proven in a focused integration test
before building the rest of the adapter.

### Portable bundle relationship

Direct SQLite is the simplest local path for Unblock-owned projects and should be the
MVP. The `qmd-memory-v1` bundle remains useful when:

- QMD and Cluster run on different machines;
- a snapshot needs to be transferred or archived;
- the source database must not be opened by Cluster; or
- another exporter wants to target a provider-neutral contract.

Both sources should normalize into the same internal external-vector model so the
clustering, layout, provenance, UI, and retention behavior do not diverge.

## Memory properties and epistemic status

### Two independent dimensions

Do not overload one `kind` field with both storage provenance and epistemic meaning.
Use at least two independent properties:

```ts
type MemorySource = "raw" | "reflection" | "curated";

type EpistemicType =
  | "observation"
  | "reported_claim"
  | "inference"
  | "assumption"
  | "opinion"
  | "synthesis"
  | "unknown";
```

An item can therefore be a reflection artifact whose epistemic content is an
inference. Suggested metadata:

```json
{
  "memorySource": "reflection",
  "epistemicType": "inference",
  "author": "bill",
  "createdAt": "2026-08-24T03:00:00Z",
  "derivedFrom": ["memory-123", "memory-456"],
  "supersedes": [],
  "confidence": null,
  "dreamRunId": "dream-2026-08-24"
}
```

`derivedFrom` and `supersedes` must reference stable record or source-span identities,
not cluster IDs. Cluster IDs may change when the clustering run is rebuilt.

### Current gap

Cluster already accepts arbitrary `ExternalChunk.metadata` and persists it on imported
records. QMD's current `content_vectors` rows store the content hash, sequence,
character position and length, model, fingerprint, total chunk count, and embedded
timestamp; they do not store arbitrary per-chunk metadata.

The integration therefore needs an explicit metadata bridge:

1. `memorySource` can initially be derived from trusted paths such as
   `memory/reflections/` and `memory/curated/`.
2. Unclassified historical content can safely use `epistemicType: "unknown"`.
3. Agent-authored artifacts should explicitly declare their epistemic type and evidence
   lineage.
4. QMD should eventually persist that declaration per semantic chunk, either alongside
   `content_vectors` or in a keyed companion table. The exact schema should be designed
   with the writer and semantic chunker together; adding a metadata column without a
   reliable source-to-chunk mapping would not solve the problem.
5. The direct adapter copies the resolved fields into Cluster record metadata.

The metadata is used for counts, filters, UI coloring, prompt construction, and audit.
It does not prevent semantically related records from entering the same cluster.

### Time semantics

QMD currently provides document creation/modification timestamps and embedding time.
Those values do not necessarily represent the time of the event described inside a
daily journal chunk. Dreaming must not call a claim "four months old" solely because of
the containing file's modification time.

When semantic event time is explicitly present in Markdown, the metadata bridge should
carry it separately from document and indexing timestamps. Until that exists reliably,
the agent may reason about source order and known document dates but should describe
event-time conclusions as uncertain.

## Cluster construction and comparison

### Build the current map

Each analysis run should:

1. Wait for the plugin's current QMD sync and embedding work to finish.
2. Snapshot the trusted database into Cluster.
3. Reuse unchanged immutable records and vectors.
4. Tombstone source records absent from the new full snapshot.
5. Run clustering.
6. Run layout.
7. Optionally label clusters.
8. Make the new run the active human view.
9. Compare it with the previous completed run.

Clustering and layout can run locally. Cluster labeling currently sends representative
text to the configured language-model provider and should remain opt-in. The dream turn
also sends selected cluster contents to the OpenClaw agent's configured model; that is
intentional but should be described accurately in configuration and permission text.

### Compare meaning, not cluster IDs

Rebuilt cluster IDs are not durable topic identities. Comparison should align old and
new clusters using membership overlap and, where helpful, centroid similarity. The
resulting change classes should be understandable to both the agent and the human:

- unchanged;
- expanded;
- contracted;
- new;
- disappeared;
- split;
- merged; or
- materially reorganized.

The first version does not need a generic temporal graph engine. It needs enough
continuity matching to identify which clusters merit another look and to show the old
and new member sets.

### What should trigger reasoning

A nightly schedule should rebuild only if QMD changed since the last completed analysis.
After rebuilding, the agent should reason only about:

- newly formed clusters;
- materially expanded or reorganized clusters;
- clusters with possible duplicate or contradictory content;
- new outliers or noise;
- clusters containing newly superseded or stale claims; and
- clusters explicitly requested by the agent or human.

All memory sources, including prior reflections, remain in the clustering universe. A
dream's own writes must not trigger another immediate dream in the same cycle. They
become visible at the next scheduled run. This allows recursive self-reference to evolve
over time without an unbounded same-night execution loop.

## The dream packet

For each changed cluster, the plugin should give the agent a compact, structured packet
rather than an undifferentiated text dump:

```text
Rico cluster changed since the previous cycle.

Current contents:
- 12 raw memory items
- 3 prior reflections
- 2 agent inferences
- 1 curated synthesis
- 4 items are new

Change:
- 3 raw items added
- 1 prior reflection added on the previous cycle
- no items removed

Task:
Determine whether this changes your current understanding. You may confirm,
revise, supersede, identify an unresolved conflict, create a new artifact, or
decide that no durable update is needed.
```

Each included item should carry:

- stable identity;
- exact semantic chunk text;
- source path and span;
- event/document time and indexed time where available;
- `memorySource` and `epistemicType`;
- whether it is new in this run;
- `derivedFrom` and `supersedes` relationships; and
- enough neighboring context to interpret the item without merging unrelated semantic
  events.

The model should be explicitly allowed to return `no_change`. Repeatedly writing
"nothing changed" into durable memory creates noise.

## Dream outputs

### Daily reflection

The agent may append to a daily reflection container:

```text
memory/reflections/YYYY-MM-DD.md
```

Because QMD uses semantic chunking, that daily file may contain multiple unrelated
topics. The file boundary supplies date and provenance; it is not treated as one topic.

A reflection should record:

- what cluster changed;
- what the agent concluded;
- whether the conclusion is an observation, inference, assumption, opinion, or
  synthesis;
- the memory items used as evidence;
- which prior conclusion was confirmed, revised, or superseded; and
- unresolved uncertainty.

### Curated topic artifacts

When a conclusion is durable and useful for later retrieval, the agent may create or
update a topic artifact such as:

```text
memory/curated/people/rico.md
```

Curated artifacts represent current understanding, not raw history. They must cite the
evidence and distinguish known facts from inference. Updating one should preserve enough
history to explain why the understanding changed.

### No-op

No output is a valid and desirable result when new material merely repeats existing
knowledge or does not justify a durable conclusion. The dream run log can record the
decision without creating another indexed memory artifact.

## OpenClaw plugin surface

### Configuration

The plugin should derive the QMD database and dataset identity from the active agent.
A conceptual configuration is:

```json5
{
  paths: ["MEMORY.md", "USER.md", "memory/**/*.md"],
  analysis: {
    enabled: true,
    command: "unblock-cluster",
    dataDir: "/path/to/cluster-data",
    baseUrl: "http://127.0.0.1:8080",
    labels: false,
    dreaming: {
      enabled: true,
      schedule: "nightly",
      onlyWhenMemoryChanged: true,
      allowSelfReference: true,
      reflectionsPath: "memory/reflections",
      curatedPath: "memory/curated"
    }
  }
}
```

This shape is illustrative, not a committed schema. The desired end state is that
enabling analysis gives each agent a sensible nightly default without requiring the
operator to create a separate cron job. The implementation should reuse an OpenClaw
host scheduling primitive if one is available rather than embedding a second general
scheduler in the plugin.

### Agent tools

Start with two narrow tools:

- `memory_map_analyze` waits for QMD, creates the current Cluster snapshot, runs cluster
  and layout, computes the change summary, and returns counts, freshness, noise ratio,
  changed clusters, run identities, and `vizUrl`.
- `memory_map_inspect` returns a cluster overview, representatives, outliers, changes,
  or the complete evidence packet for one selected cluster.

The scheduled dream turn can use those tools and the agent's existing ability to write
canonical Markdown. Add a separate `memory_dream` orchestration tool only if repeated
implementation proves that it meaningfully simplifies the host integration. Do not
pre-build a broad workflow framework.

The plugin should invoke Cluster with fixed `execFile` arguments or an equivalent typed
library boundary, never shell interpolation. The model does not choose database paths,
dataset identities, output directories, or arbitrary commands.

### Stable Cluster command

The current import surface is a repository script. Package a stable command for the
plugin, for example:

```sh
unblock-cluster memory-map build \
  --qmd-db /path/to/index.sqlite \
  --dataset openclaw-bill-memory \
  --data-dir /path/to/cluster-data \
  --json
```

It should import/snapshot, cluster, layout, optionally label, compare with the previous
run, and return machine-readable identifiers and URLs. Exact command naming can change;
the important boundary is one deterministic operation with a typed JSON result.

## Human web UI

The first human experience can reuse Cluster's existing visualization and inspectors.
The memory-specific experience should evolve to show:

- the active memory map for each agent;
- cluster size, labels, representatives, and noise;
- duplicates and near-duplicates;
- outliers and likely irrelevant content;
- additions and removals since the previous run;
- split, merged, and newly formed clusters;
- colors or filters for raw, reflection, and curated sources;
- colors or filters for observation, claim, inference, assumption, opinion, synthesis,
  and unknown content;
- the age and source of every memory item;
- chains from raw memory to reflection to later reflection to curated understanding;
- suspected self-referential loops; and
- links back to exact Markdown source spans.

The UI should help a human audit and clean memory, but the first integration does not
need to automate destructive cleanup. Human-directed deletion or editing remains a
separate, explicit action against canonical Markdown.

## Retention and cleanup

Cluster snapshots, layouts, and comparisons are derived data. They need a bounded
lifecycle:

1. Maintain one active run per agent dataset.
2. Keep at least the previous completed run so the next comparison is possible.
3. Optionally retain a small configurable history for human audit and experiments.
4. Garbage-collect older derived runs and unreferenced derived data after retention.
5. Never interpret Cluster retention as authorization to delete QMD or Markdown memory.

Do not immediately delete the previous cluster run when a rebuild completes; it is the
basis for change detection. Conversely, do not retain every nightly layout forever by
default. The existing immutable import and tombstone model should remain the provenance
foundation, with a focused retention operation for complete derived run lineages.

Daily reflection and curated Markdown are canonical memory artifacts, not disposable
Cluster outputs. They follow normal OpenClaw/QMD memory retention unless the human or
agent explicitly revises them.

## Recursive reasoning experiment

The system deliberately permits an agent to reason about its own prior reasoning. This
may produce valuable self-correction, stable identity, and increasingly coherent
knowledge. It may also produce recursive amplification in which an inference becomes a
memory, is later treated as evidence, and grows more authoritative without new external
support.

The initial response should be observability, not prohibition. Preserve and expose:

- raw-to-derived evidence links;
- the depth of self-citation chains;
- the ratio of raw to derived items in each cluster;
- repeated or near-duplicate reflections;
- conclusions supported only by earlier agent conclusions;
- confidence changes over time;
- no-op versus write rates; and
- changes in cluster composition after reflections re-enter QMD.

The model should receive provenance and time information and be asked to distinguish
external evidence from its own interpretation. It should not be artificially prevented
from using reflections. This makes it possible to learn whether models such as
GPT-5.6-sol manage the loop well and how the loop evolves in practice.

Reversibility is still required: raw memory remains intact, dream runs remain auditable
for the retention window, and derived artifacts cite their inputs.

## Privacy and permissions

- Opening QMD SQLite, importing vectors, clustering, layout, and change comparison can
  be fully local.
- Cluster labeling sends representative memory text to its configured model provider
  and should default to disabled.
- Dream reasoning sends selected cluster contents to the OpenClaw agent's configured
  model provider. This is expected functionality, but the permission and configuration
  should describe it clearly.
- The plugin passes only its own trusted per-agent database path.
- Logs and JSON results must not include secrets or dump complete memory contents by
  default.
- Dreaming does not grant permission to delete or overwrite canonical raw memory.

## Lean implementation plan

### Phase 1: prove direct ingestion

Build the read-only QMD SQLite adapter and run it manually against a copied or test QMD
database. Prove:

- exact chunk-text reconstruction;
- original vector loading through Python `sqlite-vec`;
- one coherent embedding-space selection;
- logical path alias preservation;
- read consistency with WAL state;
- no writes to the QMD database; and
- successful Cluster import, clustering, layout, and web visualization.

This is the core hypothesis. Do not begin with scheduling, generic workflows, or a large
UI redesign.

### Phase 2: stable command and on-demand plugin tools

Package the one-shot memory-map command, add plugin analysis configuration, derive the
trusted per-agent path, and implement `memory_map_analyze` and
`memory_map_inspect`. Bill should be able to build and inspect his map on demand, while
Bek can open the returned visualization URL.

### Phase 3: provenance properties and changed-cluster packets

Bridge `memorySource` and `epistemicType` into QMD semantic chunks and Cluster metadata.
Add old/new cluster comparison and produce structured packets that include prior
reflections beside raw memories. Prove the Rico workflow manually.

### Phase 4: automatic dreaming

Use the appropriate OpenClaw host scheduling mechanism to run nightly by default when
enabled. Skip unchanged indexes, inspect only material cluster changes, permit no-op
results, and prevent a dream's own writes from recursively starting another dream in
the same cycle.

### Phase 5: retention and human audit improvements

Add bounded derived-run cleanup and the smallest UI additions that make temporal
changes, provenance types, and self-reference visible. Let real use determine whether
more elaborate review, editing, or cleanup workflows are justified.

## Focused validation

Tests should cover the boundaries where silent corruption would be costly:

- schema validation fails clearly on an unrelated or drifted SQLite database;
- read-only import includes current WAL data and cannot mutate QMD;
- exact semantic text spans match the stored vector rows;
- incomplete or mixed embedding spaces are rejected;
- aliases remain distinct records while sharing vector bytes;
- metadata survives QMD-to-Cluster import;
- cluster comparison identifies representative new, expanded, split, and merged cases;
- unchanged memory produces no dream work;
- a dream's own write does not immediately recurse;
- prior reflections remain visible in the next changed cluster; and
- retention removes only exact derived run targets, never canonical memory.

Avoid a combinatorial test matrix before the end-to-end Rico slice works.

## MVP success criteria

The first complete version succeeds when:

1. Bill's plugin can build a Cluster map directly from Bill's QMD SQLite without an
   exporter or manually entered database path.
2. Bek can open the web UI and identify memory themes, noise, duplicates, and outliers.
3. Bill can inspect a changed cluster containing raw memories and prior reflections.
4. The packet states facts such as "12 raw memory items, 3 prior reflections, and 2
   inferences," with source links.
5. Bill can create a cited reflection or curated Markdown artifact—or correctly decide
   that no update is needed.
6. That new artifact re-enters QMD and participates in the next relevant cluster.
7. The following dream can recognize, confirm, revise, or supersede Bill's earlier
   reasoning rather than blindly repeating it.
8. Old Cluster runs are cleaned up according to retention while raw memory and its
   provenance remain intact.

## Decisions captured

- Direct SQLite is the local MVP; the portable bundle remains for remote and archival
  workflows.
- Unblock Cluster reads QMD; QMD does not depend on Cluster.
- The OpenClaw plugin is the agent-facing surface and supplies its trusted database path.
- Cluster consumes QMD's stored semantic chunks and does not re-chunk Markdown.
- Daily Markdown files are provenance containers, not semantic units.
- Reflections, inferences, and curated artifacts remain eligible for the same semantic
  clusters as raw memories.
- Provenance properties describe records without partitioning the clustering universe.
- Recursive self-reference is an intentional experiment, made visible rather than
  prevented.
- One scheduled cycle may write memories, but its writes do not trigger another
  immediate cycle.
- Dreaming may create or supersede derived understanding but does not silently delete
  raw memory.
- Rebuilds keep enough prior state for comparison and garbage-collect older derived
  analysis.

## Open implementation questions

Resolve these with focused spikes rather than speculative frameworks:

1. Which OpenClaw host primitive can provide a default nightly schedule without a
   custom plugin scheduler?
2. What is the smallest reliable Markdown-to-semantic-chunk metadata contract for
   `epistemicType`, `derivedFrom`, and `supersedes`?
3. Should QMD store chunk metadata on `content_vectors` or in a companion table?
4. What membership-overlap threshold is sufficient for first-pass cluster continuity?
5. Should curated topic updates be direct autonomous writes, append-only revisions, or
   proposals during the initial experiment?
6. How many historical Cluster runs are useful enough to retain by default?
7. Which recursion measures are actually useful after observing Bill's first several
   weeks of dreams?
