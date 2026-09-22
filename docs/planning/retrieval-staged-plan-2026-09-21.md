# Retrieval experiment: reuse existing search, measure honestly

Updated: 2026-09-22. This is the authoritative execution plan and current status
for the lab and retrieval comparison. The [research](context-compiler-research-2026-09-21.md)
records the ideas; the [SMART roadmap](retrieval-roadmap-smart-goals-2026-09-21.md)
retains the eight workstreams and their success gates. [Run instructions](../../eval/retrieval/README.md).

## This change: bounded simplification

Before adding features, remove the custom exact-identifier, temporal and union
helpers, their tests and the duplicate runners. Reuse installed QMD hybrid
retrieval rather than building a competing pipeline. No dormant implementations,
new dependencies, production ranking changes, provider calls or fleet work.
Keep the small, bounded runtime telemetry collector unchanged.

**Done when:** one runner executes all controls; all arms share the frozen corpus,
index, exact source identities and cumulative context-budget policy; focused tests
cover budget/source/error correctness; a local synthetic run and repository
preflight pass. Stop there. This completes cleanup, not the retrieval experiment.

## Experiment contract

- The seed is nine synthetic documents and eight cases: six answerable, two
  no-answer. Its dev/holdout labels exercise reporting, not a pristine holdout.
- Label complete evidence groups and optional forbidden spans independently of
  retrieval. Alternative quotes can satisfy a group; multi-hop needs all groups.
  Validate IDs and unique source quotes before running. Labels never enter search.
- Create one fresh isolated index over copied Markdown. Do not open a Gateway
  index, live transcripts, credentials or configuration, and do not start watchers.
- Bind frozen document IDs to exact collection-qualified QMD paths once. A matching
  path suffix from another collection is not the same source. Only source-backed
  excerpts with valid line ranges can satisfy required evidence.
- One runner compares manager vector@5 and vector@20 (normal 0.3 cutoff), manager
  whole-document BM25 (`lexical`), and SDK `hybrid@20` with `rerank:false`,
  `limit:20`, `candidateLimit:20`, `minScore:0`. QMD owns hybrid retrieval/dedup.
  Its rank scores are not vector similarities; internal retrieval breadth differs.
  This is an existing-path comparison, not an equal-compute lane ablation.
- Every arm uses the same per-case excerpt budget: 4,000 characters by default,
  520 for sync-plan. Greedily keep whole excerpts in rank order when they fit the
  remaining budget. Do not truncate; duplicates consume rank/budget, not extra recall.
  Counts exclude citation wrappers and are characters, not model tokens.
- Time setup/indexing and one full warmup separately. Every measured trial includes
  result construction. The first trial supplies quality predictions; later trials
  supply latency samples, not independent quality observations. Report successful
  p50/p95 with sample counts and failed trials separately. Never replace a failed
  first trial with a later success; unavailable setup is neither a miss nor abstention.
  A shared-index setup failure marks every arm unavailable: there is no separate
  fallback index that could silently measure a different or incomplete corpus.
- Report evidence-group recall, complete coverage, reciprocal rank, citation
  integrity, labeled forbidden evidence, no-answer emptiness, context and errors.
  Include quality denominators and dev/holdout breakdowns. Citation integrity is
  not downstream answer correctness; nonempty no-answer retrieval is not a false answer.
- Save frozen inputs, raw predictions and scores in ignored private reports (0700
  directory; 0600 JSON/Markdown). Reject an existing output directory instead of
  overwriting it. Report format v2 includes package/model/git metadata. Git HEAD
  alone does not fingerprint dirty runner code. No validated replay CLI or real
  dataset loader exists yet; saved JSON must not be called a completed replay system.

## Telemetry retained

Manager search measures elapsed duration, outcome, hit count and excerpt characters,
including initialization/queue waits but excluding tool acquisition. Whisperer
records candidate/eligible/selected counts, retrieval/judge time and hint characters.
Existing diagnostic outcome counters remain useful and separate.

Counters are process-local; percentiles cover at most 256 recent calls per operation
and include failures. No query, excerpt, source/identity value, hash, credential or
network export enters the collector. Snapshots are detached and per-manager isolated;
recreation resets them. An emitted hint does not prove use or user benefit.

## Current status and self-evaluation

The earlier “mechanics pass” claim is withdrawn: the scorer only checked each hit
against the budget, suffix matching could confuse sources, and separate trial loops
measured different work. The speculative union added no demonstrated recall on the
seed. Its code has been removed, not parked for later activation. Historical reports
remain on disk but are not acceptance evidence for the corrected comparison.

Validated on 2026-09-22:

- Focused scorer/runner/telemetry tests passed: cumulative whole-excerpt budgets,
  exact source and line-range checks, supplied-document scoring, first-trial errors,
  successful-only latency samples, unavailable arms, and telemetry bounds/isolation.
- The lab TypeScript check and repository preflight passed (Knip, build, main
  typecheck, tests, static/runtime plugin inspectors and package dry-run).
  Inspectors report no live breakages but retain two proof gaps: privacy-boundary
  hook probes and dependency installation for isolated cold imports.
- Unsandboxed local QMD 2.10.1 run with three trials per case:
  `reports/retrieval-lab/2026-09-22T14-42-08-534Z`. All four arms completed without
  errors. Saved source identities, cumulative budgets, sample counts and report
  permissions were checked directly. For sync-plan, vector context was 279 chars
  and hybrid 427, both below 520.
- Vector and SDK hybrid both covered all six answerable seed cases; hybrid MRR
  was 1.000 versus vector 0.917. Both still returned labeled forbidden evidence
  and nonempty results on both no-answer cases. There is no demonstrated recall
  gain or no-answer/conflict solution, and no representative product-quality claim.
- Runtime source, generated output and dependency manifests were unchanged from
  the start of this cleanup. Existing telemetry changes were preserved.

Self-evaluation corrected one implementation error caught by the live run: a
shared injected store must initialize semantic chunking before collection-scoped
manager sync. This was not a sandbox limitation. Final review also removed the
partial-index lexical fallback, so setup errors cannot look like correct abstention.
The simplification is complete; workstreams 1–2 have not passed their real-data,
replay or semantic-judgment gates.

Follow-up review restored `keepModelsWarm:true` on the shared store to match the
production manager's model-lifecycle defaults. The corrected local run,
`reports/retrieval-lab/2026-09-22T15-14-58-407Z`, completed all four arms with
three trials per case and no errors. Seed quality scores were unchanged; this
corrects the baseline configuration, not retrieval quality.

## What this does not complete

No representative real snapshot, mock/recorded semantic judgments, live TypeSafe
comparison, answerability/conflict decision, or downstream answer evaluation has
been completed. These remain requirements for workstreams 1–2, not implied wins.

## Next steps: real-agent retrieval comparison

### OODA decision (2026-09-22, code checkpoint `cf16d9e`)

- **Observe:** retrieval, indexed reads, session-context expansion, exact People
  recognition and bounded judgments already work. The synthetic lab has not
  established a real-memory quality improvement. Telemetry measures execution,
  not whether recalled evidence helped an answer.
- **Orient:** the goal is the right evidence at the right moment. Reuse QMD's
  hybrid discovery, existing source/expansion/read APIs, PeopleStore, TypeSafe
  transport and feature-specific judges, and the current runner/scorer. A better
  judge cannot rescue evidence absent from its shortlist.
- **Decide:** stop adding abstractions. Compare existing retrieval on actual
  memory questions before building more lanes, another judge, a subject framework
  or dreaming. Consolidate further only for a concrete duplication cost.

### Act: one bounded, real-data run

**Status:** planned, not executed. **Owner:** coding agent; Bek approves the source
scope and accepts claimed recoveries. Within **two working days of approving one
agent's corpus**, finish the comparison below; target the roadmap's **2026-10-05**
baseline deadline. If genuine cases or approved data are unavailable, report the
blocker rather than manufacture examples or silently extend the scope.

Add only validated external-dataset input and offline rescoring to the existing
lab. Reuse its types, runner, scorer, reports and installed QMD. Snapshot only
approved indexed documents and necessary source/session metadata with read-only
consistent reads. The older `eval/enhancements/prepare-corpus.mjs` assumes `main`
and legacy `curation.sqlite`; reuse its approach, not that script unchanged.

No new service, dependency, index engine, dashboard, provider call or production
retrieval switch. Keep private snapshots/results on the approved host, outside
live corpus roots; do not copy credentials or alter live indexes/configuration.

### Execution success criteria

1. **Real questions:** freeze 40 genuinely answerable requests and 10 with no
   adequate evidence in the approved snapshot. Split disjoint topics/sessions
   into 20 answerable + 5 unsupported dev cases and the same counts for holdout.
   Include actual identifiers, decisions, corrections and multi-source questions.
   Keep whole eligible documents and distractors, not only answer snippets.
2. **Independent labels:** fix source-linked labels before predictions and do not
   tune on holdout. Identify agent-only labels; independently human-review claimed
   recoveries. Record the evidence cutoff and prevent later answers, feedback or
   revisions from leaking into historical as-of questions.
3. **Real execution:** run actual QMD indexing, embeddings and retrieval through
   vector@5, vector@20, lexical and existing hybrid@20 with `rerank:false`.
   No mocking, canned results or placeholders count as completion. All arms use
   the same permitted sources, identity/time boundaries, complete-unit context
   policy and 4,000-character excerpt budget. Reuse session expansion where needed;
   do not compare expanded vector context with unexpanded hybrid chunks.
4. **Reproducible evidence:** retain actual predictions, source hashes/lines,
   code/dependency/model identity, errors and timings. Offline rescoring must
   reproduce quality counts without inference; never synthesize timings. Run at
   least three real trials per case, report cold setup separately, and avoid
   competing model/CPU workloads. Errors are not abstentions or hidden exclusions.
5. **Tangible result:** deliver a question-by-question report of baseline misses,
   recovered and lost evidence, forbidden evidence, latency and context. Verify
   citations through the existing indexed-read path. Nonempty/empty retrieval
   does not itself establish an answerability judgment.

### Adoption gate and stop condition

- Hybrid must improve held-out complete evidence coverage by **>=10 percentage
  points over vector@5**: at least two net additional completely covered cases
  among 20 answerable holdout questions. Show those real questions and verified
  source passages, not only an aggregate score.
- Compare against vector@20 too. Hybrid must beat it on quality or demonstrate a
  measured efficiency advantage; prefer a larger vector shortlist if it achieves
  the same benefit more simply.
- Require **zero wrong-scope outputs**, **100% citation validity in this run**,
  **no additional labeled forbidden-evidence cases**, and **<=150 ms added p95
  retrieval latency** over vector@5, with the same context budget. At this sample
  size the roadmap's +1-point forbidden-evidence allowance permits no extra case.
- Any failed case blocks a win claim until resolved or a new predeclared run is
  made. If the candidate loses or ties without an efficiency advantage, keep
  current retrieval and select only the smallest correction justified by the
  observed failures.

A valid negative result completes the experiment, not a product improvement.
Passing this gate permits consideration of integration, not automatic deployment.
It does not solve no-answer/conflict judgments, prove downstream agent improvement,
or unlock later roadmap stages. Saving this plan authorizes neither private-data
egress nor a production change.
