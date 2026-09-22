# From memory retrieval to a context compiler

Date: 2026-09-21. Research direction approved for preservation; implementation
starts with the retrieval lab and telemetry, not the whole roadmap. The staged
SMART gates for the eight workstreams live in
[retrieval-roadmap-smart-goals-2026-09-21.md](retrieval-roadmap-smart-goals-2026-09-21.md).

## Thesis

**Unblock Memory should not primarily become better RAG. It should become a
context compiler:** evidence → judgments → explicit state → query-specific
context → model.

The TypeSafe founder's [Why yet another agent?](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/mobilebasic)
asks how we would design an agent without a KV cache. That thought experiment
exposes why routing, compaction, tool lists, subagents and restarts are awkward:
they assume one accumulating transcript is the agent's state. Its alternative is
dynamic, query-aware, cost-aware context construction (“meta-attention”), with
progressive capability disclosure and explicit background state.

Its pricing calculation and performance expectations are hypotheses/examples,
not current pricing or proof of a universal win. Rebuilding context can destroy
valuable cache reuse. Measure total task cost and quality, not just prompt size.

Our purpose remains persistent agent employees: their accumulated, auditable
understanding should survive swapping the underlying model. The valuable asset
is not the transcript or the embedding index; it is usable, evidence-backed
understanding delivered at the right moment.

## What worked

### Evidence, understanding and analysis are separate

Raw Markdown and source transcripts are evidence. QMD indexes and clusters are
rebuildable analysis. Dossiers and knowledge are curated understanding. Delivery
is another layer. This prevents generated summaries from becoming untraceable
truth and preserves model independence. Preserve evidence subject to explicit
retention/deletion policy; “sacred” does not override a user's right to erase it.

### Events are better memory units than daily files

Daily Markdown is a provenance container, not one semantic fact. Speaker labels,
timestamps, metadata and semantic chunking improve the representation. Retrieve
atomic evidence, then expand to the smallest useful enclosing message/event.
Do not strip negation, attribution or temporal qualifications to fit a budget.

### Exact boundaries and provenance

Explicit corpora, pre-ranking session filters, exact citations, skill isolation,
and code-owned identity/path/write rules are necessary foundations. Similarity
is a lead, never proof of truth or authorization. Scope selection is not an ACL.

### TypeSafe as a bounded decision component

Memory Whisperer already asks independent usefulness questions in one request.
The extraction experiment separates proposal generation, exact source checks,
semantic support and retention eligibility. Rejecting a feature request framed
as a personal preference is a better result than maximizing extracted counts.

Skill Whisperer's [40-case synthetic experiment](../../eval/skill-whisperer/RESULTS.md)
improved from 24/40 for vector top-one to 40/40 for vector top-three + TypeSafe
with explicit none. This supports cheap discovery followed by applicability
judgment; it does not establish fleet accuracy or candidate coverage at scale.

## What remains weak or unproven

### Candidate discovery remains ordinary RAG

At the inspected baseline (`cac81af`, Memory 0.3.23, QMD 2.10.1), public
`memory_search` is vector-only; Memory Whisperer judges up to eight vector hits.
Standalone QMD `query` is hybrid with TypeSafe, but is not that plugin tool.
A judge cannot recover evidence absent from its shortlist. Exact identifiers,
corrections, temporal questions and poor query wording deserve explicit tests.

### Best available is not adequate

Separate best-ranked evidence, direct answer support, contradictory evidence,
partial coverage and no adequate evidence. A no-answer judgment over a shortlist
means only “not in this shortlist,” not “not in the corpus.” Wider search or
known coverage is needed for a broader claim. Independent existence judgments
are important because relative rankings always have a winner.

### Thresholds depend on the decision

The [prompt-structure experiment](../../eval/quality-audit/STRUCTURE-RESULTS.md)
left Memory Whisperer at 10/12 synthetic cases in both formats. Useful preference
and incident-precedent cases scored around 0.82, below the 0.9 gate. JSON improved
maintainability, not demonstrated accuracy, and increased input tokens.

Do not blindly lower 0.9. A weak research lead, proactive injection, stable-fact
admission and high-stakes action have different error costs. Calibrate on held-out
data. Noul is a yes-probability, not intensity; Choice/Score confidence describes
distribution concentration, not pipeline correctness.

### The hot-path doctrine needs an experiment, not dogma

People Whisperer delivers local materialized understanding. Memory Whisperer
performs remote judgment with a bounded deadline. Treat the latter as a bridge
and measured fallback, not proof that every turn should pay for remote inference.
Prefer background consolidation → materialized packet → exact local trigger,
with deliberate retrieval when that packet is insufficient. Query-specific
judgment may still be worthwhile when its benefit exceeds latency/cache costs.

### Safety tests are not usefulness evaluation

Scope, cancellation, deadlines and source integrity are well covered. We need
answer-bearing recall, wrong/stale attribution, no-answer behavior, agent use,
repeated searches and user-observed continuity. Fewer noise flags alone do not
prove better retrieval. The ingestion cleanup removed structural debris, but
its 207 → 28 review-task count is not a precision/recall benchmark.

### Clusters are not yet an online memory mechanism

Current clustering provides flat, run-scoped analysis. Incremental assignment,
claim ledgers, evidence watermarks and nested subject views remain research.
Subjects must retain stable identity across reclustering. Cluster mass is not
independent corroboration: duplicates and self-reflections can inflate it.

The lasting-facts branch `codex/session-memory-extraction` at `a8a7546` is separate
from the inspected main branch. Its report records 10 real sessions/142 messages,
three proposals and one retained fact, plus 15/16 synthetic retained-set matches.
Attribution loss caused the remaining valid hearsay fact to be safely rejected.
This is narrow calibration, not representative recall or production activation.

## Experiments, in order

### 0. Retrieval lab and telemetry

Freeze authorized/sanitized source snapshots, queries and source-span labels.
Stratify by identifiers, stable facts, decisions, corrections, time, episodes,
contradictions, no-answer and privacy/scope. Separate development and holdout data;
do not tune prompts/thresholds on the holdout or leak future evidence backward.

Measure candidate recall, complete evidence coverage, citation integrity,
harmful-result rate, latency, context volume and failures separately. Later add
answer quality and actual memory use; retrieval alone cannot prove either.

Planned comparisons: current vector top-five, vector top-twenty, lexical/exact
union, scoped/temporal lanes, typed judgments, and materialized knowledge.
The [experiment plan](retrieval-staged-plan-2026-09-21.md) defines the current lab implementation and status.

### 1. Multi-lane discovery plus typed routing

Union vector, BM25, exact identity/identifier, event-time, curated knowledge and
subject/cluster candidates. Deduplicate source spans, then judge a bounded set.
Independent questions can cover direct answer support, incremental usefulness,
contradiction, staleness, wrong subject, malicious instructions and redundancy.

Keep permission and identity checks deterministic. Reject prohibited candidates
before external inference. Keep contradictory evidence separately visible. Use
hard gates for non-compensating risks, not a weighted sum that lets relevance
cancel a privacy violation. Reuse QMD primitives rather than a second search stack.

### 2. Query-aware context depth

Choose omit, citation-only, short excerpt, full event or bounded neighbor expansion.
Start with exact source-span selection, not generated summaries. Compare under
equal context budgets. Some claims require several jointly sufficient spans;
independent per-chunk judgments alone will miss this complementarity.

### 3. Recognition through durable subjects

Prove people → channels/places → repos/projects before arbitrary semantic topics.
A subject owns exact/semantic triggers, curated blurb, citations, freshness and
audience/injection policy. Exact identity does not guarantee topical usefulness.
Memory Whisperer becomes fallback when materialized understanding is unavailable
or insufficient. Do not generalize PeopleSQL before a second real use case.

### 4. Background dream packets

Present prior claim, unseen evidence since watermark, source diversity, support,
contradictions and unresolved questions. Let the agent reinforce, revise, qualify,
record an observation, seed a subject or write nothing. Maintain corrections and
source withdrawal. Separate extracted enduring facts from searchable task history.
Keep broader extraction shadow-only until both precision and recall are evaluated.

### 5. Progressive capability disclosure

Generalize skill discovery to tools, procedures and docs: short available-capability
descriptions → typed applicability decision including none → full schema/procedure
only when needed. Do not let a semantic router suppress mandatory policy. Measure
actual agent adoption; even a correct hint can be ignored or misused.

## More speculative directions

### A no-KV-cache agent benchmark

Compare accumulating sessions with stateless turns reconstructed from explicit
memory. Include compaction, restart recovery and topic switches. Measure quality,
full task cost, cached/uncached tokens and latency. Do not assume stateless wins.

### Model-independent context representation

A small Context IR could contain current goal, active subjects, constraints,
observations, durable claims, open loops, unresolved conflicts, evidence references,
audience policy and freshness. Render it differently for different models. Keep
mandatory policy distinct from descriptive memory, and tool observations distinct
from model guesses. Do not depend on hidden reasoning as durable evidence.

### Memory debt and active learning

Repeated searches, corrections, retrieved-but-unused evidence and underdelivered
answers can reveal missing memory capabilities. Gather approved examples for
operator evaluation; do not let sentiment or response audit rewrite beliefs.
Content-free telemetry cannot itself establish semantic repetition or causality.

### Counterfactual evidence probes

Replay with and without a candidate (or jointly necessary group). Does the answer
change, and is that change correct? This can expose indispensable evidence,
redundancy, anchoring and unsupported synthesis. Use paired/repeated runs and
independent labels; one stochastic difference is not causal proof.

### Security-aware routing

Route only explicitly approved data to a provider, considering sensitivity as well
as cost/capability. Public docs, personal context and credentials need different
policies. A model's prediction of sensitivity is advisory, not authorization.

### Temporal belief ledgers

Keep observation time separate from effective time; preserve speaker, assertion
basis and correction lineage. Historical truth and present truth can differ.
“Worked at A” and “left A” need not conflict. Retrieval must know which time the
question asks about and whether newer evidence is available.

## Do not build yet

- A graph database or universal entity ontology.
- Approximate vector optimizations without a representative win. Historical
  128d shortlist + 768d rerank testing lost to exact 768d on latency and recall;
  that small August experiment is not a benchmark of today's implementation.
- AI freshness checks on every ordinary search.
- Automatic dossier writes from raw retrieval or sentiment.
- Permanent summaries of everything, a dashboard, or a second job system.
- Semantic entity graduation before exact triggers and their useful delivery work.

## The north star

Make the agent carry less context, but make every carried token deliberately
chosen, provenance-aware and appropriate to the current moment. Optimize for
correct work and continuity, not merely remembered volume or fewer tokens.

## Sources

- [Founder essay](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/mobilebasic), read 2026-09-21.
- [TypeSafe building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md),
  [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md),
  [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md),
  [line search](https://docs.typesafe.ai/cookbooks/semantic_find.md),
  [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md).
- [Vision](../vision.md), [subject boundary](entity-whispering-direction.md),
  [runtime retrieval contract](../retrieval.md),
  [extraction design](../../EXTRACTED-MEMORIES-DESIGN.md).

This memo saves the research synthesis, not a claim that its roadmap is implemented.
