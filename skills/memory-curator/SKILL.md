---
name: memory-curator
description: Investigate Unblock Memory clusters and maintain supported, agent-specific knowledge that would otherwise be difficult to reconstruct.
---

# Memory Curator

Use semantic clusters as attention signals for maintaining the agent's current
understanding of its world. A cluster shows similarity, not a complete timeline,
truth, or consensus. Do not write from a cluster alone, and prefer no write over
weak, duplicative, or easily looked-up knowledge.

## Investigate

1. Call `memory_list_clusters`. If analysis is missing or stale, call
   `memory_recluster`, then list again.
2. Fetch a useful cluster with `memory_fetch_cluster`. Start with
   `sort: "representative"`; use `score_desc`, `date_asc`, or `date_desc` and
   pagination when relevance, evolution, or recent state matters.
3. State the question the cluster raises: what may be repeated, contradictory,
   changing, or worth understanding?
4. Search existing knowledge with `memory_search`, using
   `corpora: ["knowledge"]`. If that corpus is not configured, report that and
   do not create an unindexed file.
5. Investigate the evidence needed to answer the question. Follow important
   `qmd://` sources with `memory_get`, search adjacent memory or sessions, inspect
   other clusters, and check live systems, local files, authoritative docs, or
   the web when they are the right source. The selected cluster is not assumed
   to contain the whole timeline or the current truth.
6. Distinguish underlying evidence from earlier agent-created knowledge.
   Derived repetition can locate or challenge a conclusion, but is not
   independent corroboration.

## Decide what belongs in knowledge

Write knowledge when the result is agent-specific, evolving, and expensive to
reconstruct, such as current fleet composition, relationships, preferences,
project decisions, local conventions, or an assessment synthesized across
time.

Prefer a lookup for public or vendor-owned facts, generic command syntax, and
behavior likely to change with a third-party release. Those sources may verify
a local conclusion, but do not copy ordinary documentation into knowledge. A
local policy or deliberate divergence can belong when its local meaning and
rationale are the durable part.

Choose one outcome: update knowledge or no write. No write is successful when
the evidence is insufficient, the information is already accurate, or lookup
is better than memory.

## Maintain knowledge

Use a stable `knowledge/<topic>.md` file and update it in place. Facts, agent
assessments, and uncertainty may coexist. Qualify each claim where it appears so
it remains honest if semantic chunking retrieves it alone:

- identify what is verified and when or against which current source;
- label an interpretation as the agent's assessment rather than a settled fact;
- state uncertainty or an open question directly with the affected claim.

Keep the file focused on current understanding. Remove stale conclusions rather
than retaining `Supersedes`, history, changelog, migration, or old-process
sections. Raw memory and sessions preserve the evidence history. Include a
human-readable update time and useful evidence citations, but do not force a
rigid document template.

## Finish the cycle

- Do not rewrite raw memory or session projections.
- Verify an updated file with `memory_search`, using
  `corpora: ["knowledge"]`, and check all-corpora ranking when useful.
- Report the questions investigated, evidence consulted beyond each cluster,
  files changed, current uncertainties, and intentional no-write decisions.
- Do not recluster again after this cycle's writes. Let them enter the next
  scheduled cycle so the run cannot recursively react to its own output.
