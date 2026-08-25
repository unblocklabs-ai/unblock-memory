# Unblock Memory Platform Ownership and Analysis Boundary

## Status

Accepted product direction; the first naming and analysis-boundary proof is implemented.
The broader memory platform remains in planning.

This document is the final ownership and architecture decision for the **Unblock Memory**
repository and plugin. The former `unblock-qmd` name is implementation history, not a
separate product identity.

This document governs the implementation described in:

- [Unblock Memory Consolidation and Reflection Cycles](./memory-consolidation-and-reflection.md)
- [Contextual Relationship and Workspace Memory](./contextual-relationship-memory.md)

Where those exploratory documents conflict with this decision, this document wins. The
current release includes workspace-backed retrieval and the direct-index clustering
boundary described below. Reflection cycles, CRM, prompt injection, `platform.sqlite`, a
generic analysis provider, autonomous controllers, and a memory-map UI remain future work.

### Current release boundary

Unblock Memory is a clean new plugin, not an in-place upgrade of `unblock-qmd`. It creates
its current schema from scratch, registers only its current tool names, and does not ship
old-tool aliases, legacy state migration, or compatibility code for superseded analysis
schemas. Canonical workspace Markdown remains the migration path: a new QMD index can be
rebuilt from the configured files.

### Implementation checkpoint (2026-08-24)

The first local implementation checkpoint now proves:

- the plugin's product name, plugin ID, package name, agent-facing provider name, and new
  per-agent state path use **Unblock Memory** / `unblock-memory`;
- the plugin initializes exactly three plugin-owned derived-analysis tables in QMD's
  rebuildable `index.sqlite`: `memory_analysis_runs`, `memory_analysis_clusters`, and
  `memory_analysis_memberships`; and
- a private local worker reads QMD's existing unique active `(hash, seq)` vectors directly,
  holds its working matrix only in memory, and writes only cluster summaries, memberships,
  layout coordinates, and run metadata to those three tables.

A direct, offline Bill proof ran against a disposable existing QMD index containing 392
Markdown sources and 10,376 existing 768-dimensional vectors. It produced 40 clusters and
1,765 noise memberships. The pre- and post-run SHA-256 over every stored vector byte was
identical. It did not modify workspace Markdown, generate embeddings, create a second
vector store, or send memory text to a labeling model.

Still pending are npm publication, installed-host configuration, any future
plugin-to-provider abstraction, `platform.sqlite`, relationship context, reflection
workflows, and the memory-specific UI. An old `unblock-qmd` index is only a derived cache;
the new plugin builds its own index from canonical workspace Markdown rather than treating
that cache as canonical data or migrating it.

## Decision

**Unblock Memory is the sole agent-facing memory product and OpenClaw memory plugin.**

QMD is its internal indexing and retrieval engine. A small Unblock Cluster-derived worker
supplies clustering, layout, and outlier detection behind a private,
replaceable analysis boundary. Neither dependency is a second product that the agent
must understand or operate.

The product boundary is:

```text
Agent workspace                         Unblock Memory plugin state
├── MEMORY.md                           ├── index.sqlite
├── memory/**/*.md       indexed by     │   QMD index + plugin-derived analysis
└── configured files ────────────────►  └── platform.sqlite (future)
    canonical narrative memory              optional structured state
                         │
                         ▼
                   Unblock Memory
             one memory product and UX
                         │
                         ▼ private process boundary
              Unblock Memory analysis worker
                         │
                         ▼
          Unblock Cluster-derived mechanics
```

Workspace Markdown does **not** live inside the plugin state directory. The plugin reads,
indexes, retrieves, and reasons over configured workspace files without relocating them.

An agent should understand the feature as:

> My Unblock Memory system can retrieve my memories, organize them into themes, identify
> noise and contradictions, help me reflect, and show my human a memory map.

It should not need to understand QMD internals, SQLite, embedding storage, Data Graph, or
a customer-support-ticket analysis product.

## Naming

The target naming is deliberately consistent:

| Surface | Target name |
| --- | --- |
| Product | Unblock Memory |
| Plugin name | Unblock Memory |
| Plugin ID | `unblock-memory` |
| Repository | `unblock-memory` |
| Package | `@unblocklabs/unblock-memory` |
| Per-agent state directory | `unblock-memory/` |
| Internal search dependency | `@unblocklabs/qmd` |

The former `unblock-qmd` names are implementation history, not a compatibility surface.
Unblock Memory uses a new plugin ID and state directory, does not register the old plugin
or tool names, and does not migrate the old derived `index.sqlite`.

QMD may remain visible in engineering diagnostics and dependency documentation. Normal
agent instructions, tools, configuration, and human workflows should say **Unblock
Memory**.

## Product shape

Unblock Memory should remain one installed plugin with disciplined internal modules:

```text
Unblock Memory
├── retrieval                       required
│   └── @unblocklabs/qmd
├── structured memory               future, plugin-owned
│   └── platform.sqlite
├── relationship context            future optional module
├── memory analysis                 current optional module
├── reflection and reconciliation   future optional module
└── memory UI                       future optional module
```

This is not a generic "master Unblock Labs" plugin. It contains capabilities that share
one memory model, provenance system, agent surface, and lifecycle. Unrelated Unblock Labs
products should remain separate.

It should also not be split into several competing OpenClaw memory plugins unless future
permission or release-boundary evidence requires it. OpenClaw selects one primary memory
capability, and the agent should install and understand one memory product.

## Ownership by component

### Unblock Memory owns the memory product

The plugin owns:

- the agent-facing memory contract;
- memory tools and their names;
- memory-oriented prompts and instructions;
- configured workspace memory sources;
- QMD synchronization and freshness;
- initialization of its three `memory_analysis_*` tables in QMD's rebuildable index;
- the future `platform.sqlite` schema and migrations;
- future CRM, identity, relationship, audience, and channel context;
- future provenance, epistemic type, and disclosure classifications;
- selection of memory topics and evidence for agent reasoning;
- future reflection, reconciliation, and change-review workflows;
- future idempotency and consolidation watermarks;
- writing accepted derived memory back to workspace Markdown;
- memory-specific configuration and permissions;
- memory-specific results and error messages;
- the finished human memory-map experience;
- retention policy for derived analysis; and
- documentation presented to plugin users.

Unblock Memory decides **when**, **why**, and **how** analysis is used and what the agent
may turn into durable memory.

### The workspace owns narrative memory

The agent workspace remains the physical home of narrative memory, including:

- `MEMORY.md`;
- `memory/**/*.md`;
- reflection files;
- curated person, project, or topic files; and
- any other explicitly configured Markdown sources.

These files are human-readable, editable, portable, and canonical. Accepted reflections
become canonical only when the Unblock Memory workflow writes them to an approved
workspace path with provenance.

### The QMD library owns indexing primitives

The `@unblocklabs/qmd` library owns:

- reading configured content into its index;
- semantic chunking;
- indexed chunk positions and lengths;
- embeddings and embedding-space identity;
- lexical and semantic retrieval;
- `index.sqlite` schema, migrations, and integrity;
- exact winning memory spans; and
- generic APIs for safely accessing indexed content.

QMD's documents, chunks, FTS rows, and vectors are derived and rebuildable. They are not
the canonical copy of workspace Markdown.

QMD should remain domain-neutral. It should not acquire Slack CRM, relationship policy,
Unblock Cluster, or reflection-workflow concepts merely to support this plugin.

QMD's storage schema remains QMD-owned. Unblock Memory's analysis schema is deliberately
small and namespaced inside the same rebuildable `index.sqlite`, because it directly
references QMD's stable `(hash, seq)` chunk identities. The plugin, not the worker,
creates those three analysis tables. This new plugin starts with the clean schema rather
than carrying compatibility migrations for superseded analysis prototypes.

### Future: `platform.sqlite` owns canonical structured memory

This database is not part of the current release. A future Unblock Memory release should
own a separate per-agent `platform.sqlite` for structured data that
does not naturally belong in Markdown or a rebuildable search index, including:

- people and organizations;
- channel-specific identities and aliases;
- relationship facts and summaries;
- channel and audience records;
- disclosure classifications;
- provenance and source links;
- reflection and analysis watermarks;
- idempotency keys; and
- plugin-owned schema versioning.

One memory product does not require one SQLite file. Separate files preserve clear schema,
migration, backup, concurrency, and recovery ownership:

```text
~/.openclaw/agents/<agentId>/unblock-memory/
├── index.sqlite       QMD-owned and rebuildable
└── platform.sqlite    Unblock Memory-owned structured state
```

This is one stable platform database, not a new bespoke database for each feature or
customer.

### The private analysis worker owns generic analysis mechanics

The current private worker owns:

- accepting records and existing vectors;
- validating one coherent embedding space;
- clustering;
- dimensionality reduction and layout;
- outlier and noise identification;
- duplicate or near-duplicate analysis where supported;
- immutable analysis snapshots and provenance;
- comparison inputs for changed-topic detection;
- representative selection; and
- rendering or supplying visualization data.

The engine decides **how** generic records are analyzed. It must not decide what an agent
should remember, write, disclose, delete, or believe.

### OpenClaw owns host runtime policy, not memory reasoning

OpenClaw remains responsible for:

- loading and enabling the plugin;
- agent, session, channel, and sender identity exposed through supported APIs;
- tool and prompt-injection policy;
- model/provider execution;
- session and thread lifecycle;
- Cron and other host scheduling primitives; and
- operator-controlled permissions.

Unblock Memory must use supported host surfaces rather than becoming a second channel
client or scheduler. When the host does not expose a required typed identity, directory,
or scheduling capability, that gap should be handled explicitly rather than bypassed by
importing another plugin's private internals.

## Future: reflection cycles are owned by Unblock Memory

Reflection automation and its controller are not part of the current release. This
section fixes future ownership so a later implementation does not reuse OpenClaw dreaming
or introduce competing writers.

OpenClaw's existing `memory-core` dreaming behavior is not the desired product and is not
an implementation foundation for Unblock Memory.

Unblock Memory owns:

- selecting changed topics and evidence;
- distinguishing raw memory, observations, inferences, assumptions, and reflections;
- exposing previous reflections alongside new evidence;
- constructing reflection prompts;
- asking the agent to confirm, revise, supersede, or make no change;
- preventing duplicate nightly artifacts;
- preserving evidence and self-reference lineage; and
- writing accepted memory artifacts to configured workspace paths.

OpenClaw Cron may eventually act only as a wake-up mechanism:

```text
OpenClaw Cron
     │ "run your Unblock Memory reflection cycle"
     ▼
Unblock Memory review workflow
     │
     ▼
Agent reasons over typed evidence
     │
     ▼
Approved workspace memory artifact
```

The Cron trigger must not invoke or reuse `memory-core`'s promotion, ranking, narrative,
or write logic. There must be exactly one autonomous memory-review controller and one
writer policy.

Until external plugins have a supported scheduling API, the progression is:

1. manual or on-demand reflection;
2. operator-created OpenClaw Cron that asks the agent to invoke Unblock Memory; and
3. later, a supported external-plugin scheduler API or narrowly scoped installation
   helper.

OpenClaw's built-in dreaming must be explicitly disabled wherever automated Unblock
Memory reflection is enabled. The plugin should detect and clearly report an unsafe
double-writer configuration where practical.

## Future target architecture

The current release implements the workspace, QMD index, Unblock Memory runtime, and
private analysis-worker path. `platform.sqlite`, relationship context, reflection,
automation, a generic provider interface, and the memory UI in this diagram are future.

```text
Agent workspace
├── MEMORY.md
├── memory/**/*.md
└── other configured Markdown
        │
        │ indexed by
        ▼
@unblocklabs/qmd ───────────────► index.sqlite
        │                           QMD index + three derived analysis tables
        │ direct existing vectors
        ▼
Unblock Memory runtime ◄──────── platform.sqlite
├── search and retrieval            structured canonical state
├── relationship context
├── memory review
├── reflection and reconciliation
└── memory UI
        │
        ▼ private process boundary
Unblock Cluster-derived worker
        │
        ▼
Derived groups, outliers, representatives, and layout
```

Analysis runs are derived and rebuildable. The analysis engine never becomes a source of
truth and cannot edit workspace Markdown or `platform.sqlite`.

Only if later evidence justifies it, a generic analysis provider may replace the current
private worker behind the same Unblock Memory-owned boundary.

## Agent-facing contract

### Memory-native tools

The current tool contract is:

```text
memory_search
memory_get
memory_recluster
memory_list_clusters
memory_fetch_cluster
```

No aliases for superseded analysis-tool names are registered. Future tools such as memory
review or reflection should be added only when their use is proven. Normal tools must not
expose QMD internals, engine commands, or customer-support concepts.

Avoid names such as:

```text
unblock_cluster_import
cluster_dataset
datagraph_view
analyze_tickets
qmd_sqlite_export
```

### Memory-native output

Normal results may contain:

- memory items;
- themes or memory topics;
- observations, reflections, inferences, assumptions, and opinions;
- duplicate or redundant memories;
- outliers and possible noise;
- changed topics;
- stale or superseded understanding;
- evidence links and source spans;
- freshness; and
- a memory-map URL.

Normal results should not contain:

- ticket terminology;
- support-specific summaries;
- customer sentiment fields;
- product/SKU fields from the support domain;
- QMD database details;
- engine command lines;
- dataset/graph/view jargon; or
- Cluster identifiers unless an operator explicitly requests diagnostics.

### Prompt ownership

All prompts presented to the agent are authored and versioned by Unblock Memory. The
analysis engine returns structured analysis; it does not supply customer-support or
memory-reflection instructions.

For example:

```text
This memory topic changed since your previous review.

It contains 12 raw memory items, 3 prior reflections, and 2 inferences.
Four items are new. Review whether your current understanding should be confirmed,
revised, or superseded. You may decide that no durable update is needed.
```

Prior observations and reflections remain visible in the same semantic universe so the
agent can recognize previous reasoning rather than recreate it nightly. Their epistemic
type and evidence lineage must remain explicit so repeated reflection is not mistaken for
independent corroboration.

## Future: relationship and audience context

Relationship context is an optional module inside the same plugin and structured-memory
model. It is not a second memory capability or a second Slack client.

The first implementation should use a minimal disclosure distinction:

- available for private model reasoning; and
- safe to repeat within a defined audience or scope.

Uncertain person-specific information defaults to reasoning-only. Prompt construction
must be bounded, source-linked, and fail closed to no additional context when identity,
audience, permissions, or freshness cannot be established.

OpenClaw should expose a supported, typed interaction and directory contract for Slack
and later channels. Unblock Memory should not import Slack plugin internals or independently
reimplement Slack directory synchronization.

## Future: human-facing contract

The finished human experience belongs to Unblock Memory and should use names such as:

```text
Unblock Memory Map
Bill's Memory
12 Memory Topics
7 Possible Duplicates
18 Outliers
3 Topics Changed Since Yesterday
```

It should support inspection of:

- raw workspace memories and exact source spans;
- observations, reflections, assumptions, and inferences;
- topic representatives;
- duplicate or noisy content;
- temporal changes;
- evidence and self-reference chains;
- person, project, and relationship themes; and
- links back to canonical workspace Markdown.

The current Unblock Cluster UI may be reused privately for the first proof. Its
support-ticket fields and vocabulary make it unsuitable as the finished Unblock Memory
experience. A finished UI should be either a memory-specific Cluster mode driven by a
neutral contract or a thin Unblock Memory UI over generic analysis results.

## Direct-index analysis boundary

The normal local path is intentionally simple: the worker opens the plugin's existing QMD
`index.sqlite`, validates the supported schema, reads QMD's active vectors, and writes
only derived results to the three plugin-owned analysis tables. It never creates tables,
stores another vector copy, or writes QMD documents, chunks, or embeddings.

The input identity is the unique QMD `(hash, seq)` key. Multiple active document paths
may alias one content hash; analysis clusters that vector once, while result reads join
back to every active source path. The worker validates one model, embedding fingerprint,
dimensionality, and a stable input digest before it saves a run.

The worker is private implementation code, not an agent tool or durable public API. QMD
does not depend on the worker. A portable QMD snapshot/export may be useful later for
debugging or another-machine operation, but bundles are not part of the normal Unblock
Memory path.

Plugin-managed access is the supported concurrency model for this release. The manager
serializes QMD synchronization, analysis writes, and analysis reads for an agent; the
worker commits a rebuild atomically. Uncoordinated external writers to the same
`index.sqlite` are outside the supported contract.

The agent-facing analysis contract is deliberately explicit:

- `memory_list_clusters` reads the retained result and reports whether it is stale;
- `memory_recluster` is the only expensive, side-effecting rebuild and exposes bounded
  UMAP, HDBSCAN, and seed controls; and
- `memory_fetch_cluster` accepts a run-scoped ten-character cluster reference plus
  `topK`, then returns representative QMD-backed chunks without another semantic search.

Index changes mark the retained run stale rather than deleting it. Reads report both
original `size` and currently readable `availableSize`, because deleted QMD chunks are
not copied into derived storage. Cluster references change after a successful rebuild;
failed rebuilds preserve the previous stale result.

### First proof

```text
QMD vectors in index.sqlite
        ▼
private local analysis worker
        ▼
three plugin-owned derived-analysis tables in that same index
        ▼
Bek validates useful memory decisions
```

### Future only: optional provider

This provider abstraction is not part of the current release. If repeated use proves
valuable, Unblock Memory may call a separately installed analysis
provider through a small, versioned, memory-oriented process or JSON contract. Search and
retrieval must remain independent of that provider.

Do not extract a generic clustering framework merely because it might be reusable.
Consider extracting Cluster's pure clustering/layout mechanics only when real evidence
appears, such as:

- support-ticket fields repeatedly leak into otherwise generic analysis paths;
- packaging the Cluster application pulls unnecessary services into memory installs;
- memory behavior requires repeated forks of Cluster internals;
- another non-support product needs the same algorithms; or
- replacing Cluster cannot be tested behind the private provider contract.

Do not copy the entire Cluster product into Unblock Memory or reimplement mature Python
clustering algorithms in TypeScript without evidence.

## Dependency and failure policy

```text
Unblock Memory
├── memory_search             required
├── memory_get                required
├── direct-index analysis     optional current module
├── platform.sqlite           future
└── analysis provider         future, only if justified
```

Analysis-worker absence, failure, or timeout must not break ordinary memory indexing,
search, or retrieval. A failure should produce a
memory-oriented diagnostic such as:

```text
Memory analysis is unavailable. Search and retrieval are still working.
```

It must not expose a missing customer-support service error to the agent.

## Data ownership and write boundaries

### Canonical data

- workspace Markdown and accepted reflection artifacts, owned by the human and agent
  workflow;
- future identities, relationships, disclosure state, provenance, and workflow watermarks
  in `platform.sqlite`, owned by Unblock Memory when that store exists.

### Derived data

- QMD documents, chunks, FTS rows, and vectors in `index.sqlite`;
- clustering snapshots and group membership;
- layouts and outlier scores;
- representatives and transient labels; and
- change-comparison artifacts that can be regenerated from canonical inputs.

The analysis worker reads QMD's existing vectors and writes only derived analysis storage.
It cannot edit or delete workspace Markdown, `platform.sqlite`, QMD documents, chunks,
or vectors.

Only the Unblock Memory workflow and the agent operating under its write policy may turn
analysis into a new canonical workspace artifact. No analysis result is automatically a
fact: an outlier is not automatically junk, and a cluster is not automatically coherent.

## Future provider replaceability test

The boundary is correct if:

> Replacing Unblock Cluster with another analysis provider does not change Bill's memory
> tools, prompts, canonical data, reflection workflow, or normal output contract.

The replacement may change grouping quality, layout, performance, or internal run
identities. It must not require the agent to learn another product.

The boundary is leaking if agent-facing code imports support-ticket types, emits Cluster
jargon, exposes QMD storage internals, or treats Cluster run IDs as durable memory
identities.

## Implementation order

1. Preserve and harden `memory_search` and `memory_get`.
2. Launch the clean `unblock-memory` identity, state path, and schema without legacy
   aliases or state migration.
3. Keep the three plugin-owned analysis tables in QMD's rebuildable index and use the
   direct existing-vector worker.
4. Expose one explicit rebuild tool and two read-only cluster tools.
5. Validate the direct-index path against Bill's full memory without changing vector
   bytes.
6. Future: prove stable source/span identities and provenance independently of cluster
   references.
7. Future: add `platform.sqlite` only with the schema needed by the first relationship
   context slice.
8. Future: add bounded Slack identity and audience context with minimal disclosure
   semantics.
9. Future: add on-demand reflection before considering any autonomous controller.
10. Future: extract an analysis provider only if working integrations justify it.

## Implementation requirements

- Define memory-oriented plugin types independent of Cluster types.
- Keep backend commands and IDs below a translation layer.
- Maintain stable workspace source/span identities above indexing and clustering runs.
- Keep QMD tables QMD-owned; keep the three namespaced analysis tables plugin-owned in
  the same rebuildable `index.sqlite`.
- Author all review and reflection prompts in Unblock Memory.
- Preserve epistemic type and evidence lineage for recursive reflections.
- Treat analysis as optional, derived, rebuildable, and recoverable; it may write only its
  three namespaced tables.
- Return memory-oriented errors and metrics.
- Fail closed when relationship disclosure or audience scope is uncertain.
- Validate that no support-ticket prompt or field reaches ordinary memory context.
- If future automation is added, keep exactly one reflection controller and writer policy.
- If future automation is added, disable OpenClaw built-in dreaming first.
- If a future provider is added, document its network, model, storage, and privacy behavior
  through Unblock Memory configuration.

Avoid:

- exposing `unblock-cluster` as an agent tool namespace;
- asking the agent to run Cluster commands;
- linking agents to support-ticket documentation;
- treating QMD SQLite as canonical narrative memory;
- adding non-analysis plugin state to QMD's `index.sqlite`;
- letting the worker create or migrate tables, or write QMD documents, chunks, or vectors;
- treating graph, view, dataset, or run IDs as canonical memory identities;
- persisting conclusions only inside derived analysis storage;
- copying the full Cluster codebase into the plugin;
- creating a generic Unblock Labs umbrella plugin;
- splitting one memory product into competing memory plugins prematurely;
- building a second Slack client inside Unblock Memory;
- reusing OpenClaw `memory-core` dreaming logic; and
- running two autonomous memory writers.

## Documentation policy

Plugin documentation should describe:

- Unblock Memory search and retrieval;
- configured workspace memory sources;
- people, relationships, audience, and channel context;
- memory topics and maps;
- observations, inferences, reflections, and evidence lineage;
- reflection and reconciliation cycles;
- privacy and model-data flow; and
- future optional analysis-provider requirements.

QMD documentation may describe the internal indexing library. Unblock Cluster may
continue documenting its customer-support product. Internal engineering documents may
name both dependencies, but agent instructions and ordinary user workflows should not
require understanding either implementation.

## Validation checklist

Before calling the platform product-ready, verify:

- [x] Product, plugin, package, repository, and state-directory naming consistently use
      Unblock Memory.
- [x] The plugin starts clean without old-tool aliases, legacy state migration, or duplicate
      plugin registration.
- [ ] Workspace Markdown remains in its workspace paths and is treated as canonical.
- [ ] QMD's `index.sqlite` is independently rebuildable.
- [ ] Future `platform.sqlite` has independent migrations, backup, and recovery behavior.
- [ ] All agent tools and normal results use memory-oriented vocabulary.
- [ ] Normal prompts and results contain no support-ticket fields or instructions.
- [ ] Any future analysis provider cannot edit canonical memory or structured platform
      state.
- [ ] Future provider absence does not break `memory_search`, `memory_get`, or relationship
      context.
- [x] Direct analysis reads unique active QMD vectors and persists only derived results.
- [x] Bill's direct analysis leaves all stored vector bytes unchanged.
- [ ] Cluster IDs are not treated as durable memory identities.
- [ ] The human UI uses Unblock Memory vocabulary.
- [ ] Relationship context distinguishes private reasoning from audience-safe repetition.
- [ ] Prior reflections remain visible with epistemic type and evidence lineage.
- [ ] Reflection writes are idempotent for the same snapshot or change set.
- [ ] OpenClaw built-in dreaming is disabled before Unblock Memory automation starts.
- [ ] If future automation is enabled, exactly one reflection controller and writer are
      active.
- [ ] The analysis implementation can be replaced behind a tested private interface.

## Decisions captured

- Unblock Memory is the main, core, and sole agent-facing memory product.
- Unblock Memory launches as a clean new plugin identity rather than preserving
  `unblock-qmd` compatibility, aliases, or derived state.
- Workspace Markdown is canonical narrative memory and remains physically in the agent
  workspace.
- A future `platform.sqlite` will be the canonical structured-memory store owned by Unblock
  Memory; it is not part of the current release.
- QMD is a domain-neutral internal indexing engine; its index is derived and rebuildable.
- QMD's rebuildable index contains QMD tables plus exactly three Unblock Memory-derived
  analysis tables; `platform.sqlite` remains separate for future canonical structured state.
- Unblock Cluster is an optional, hidden, replaceable analysis implementation—not a
  plugin dependency for ordinary memory search.
- The first analysis integration reads QMD's existing vectors directly from the local
  index and writes derived relationships beside them; bundles are optional portability,
  not the current product path.
- Customer-support, Cluster, and QMD storage vocabulary must not enter normal memory
  tools, prompts, outputs, or the finished UI.
- Unblock Memory owns reflection and reconciliation behavior.
- OpenClaw Cron may wake the agent, but OpenClaw `memory-core` dreaming logic is not used.
- Built-in OpenClaw dreaming must be disabled before automated Unblock Memory reflection
  is enabled.
- Prior reflections may re-enter the same semantic universe only with explicit epistemic
  type and provenance.
- Relationship context lives inside the same plugin and structured-memory model, with
  minimal disclosure semantics from the first slice.
- Search and retrieval continue working when structured context or analysis is disabled
  or unavailable.
- A neutral analysis kernel is extracted only when working integrations demonstrate a
  stable shared boundary.
- The architecture passes the replaceability test without teaching the agent another
  product.
