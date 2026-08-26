---
name: memory-curator
description: Review Unblock Memory clusters and turn supported current knowledge into canon or exploratory reasoning into reflections.
---

# Memory Curator

Use Unblock Memory's semantic clusters to maintain durable workspace knowledge.
Clusters show similarity, not truth or consensus. Prefer no write over a weak or
duplicative artifact.

## Review clusters

1. Call `memory_list_clusters`.
2. If analysis is missing or stale, call `memory_recluster`, then list again.
3. Fetch useful clusters with `memory_fetch_cluster`. Treat noise as optional
   review material, not automatically important content.
4. Follow representative `qmd://` source paths with `memory_get` whenever the
   excerpt lacks context or a conclusion could change durable knowledge.
5. Distinguish underlying memory or session evidence from earlier canon and
   reflections. Derived artifacts may help locate, challenge, or revise an
   understanding, but repetition does not make them independent evidence.
6. For each reviewed cluster, choose canon, reflection, or no write.

## Write canon

Use `knowledge/canon/<stable-topic>.md` for a supported, durable rule or current
understanding. Update the topic file in place instead of creating dated copies.

Every semantic chunk in canon must remain correct if retrieved alone:

- State only the current affirmative truth.
- Remove obsolete instructions rather than preserving them for comparison.
- Never add `Supersedes`, history, changelog, old-process, or migration sections.
- Include a human-readable `Updated` timestamp, the current rationale, and
  `qmd://` evidence citations.
- Preserve uncertainty in the claim itself. If the evidence does not support a
  stable current claim, write a reflection or nothing.

A concise shape is sufficient:

```markdown
# Topic

Updated: 2026-08-26 14:30 EDT

## Current understanding

Present-tense rule or facts.

## Rationale

Why this is the current understanding.

## Evidence

- qmd://memory/...
- qmd://sessions/...
```

## Write reflections

Use `knowledge/reflections/YYYY-MM-DD.md` for patterns, hypotheses,
contradictions, open questions, or reasoning worth revisiting. Append a
timestamped section when the day's file already exists. Label uncertainty
plainly and include the `qmd://` evidence examined. Reflections are not
authoritative instructions.

## Finish the cycle

- Do not rewrite raw memory or session projections.
- Avoid restating knowledge already captured accurately.
- Verify new or updated knowledge with `memory_search`, selecting `canon` or
  `reflections` when useful.
- Report clusters reviewed, files changed, evidence used, uncertainties, and
  intentional skips.
- Do not recluster again after this cycle's writes. Let them enter the next
  scheduled cycle so the run cannot recursively react to its own output.
