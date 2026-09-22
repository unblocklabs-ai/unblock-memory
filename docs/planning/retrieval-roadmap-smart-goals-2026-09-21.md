# Retrieval and context compiler roadmap: SMART goals

Date: 2026-09-21

This is the accountability contract for the retrieval/context-compiler program.
Each workstream has one bounded outcome, a measurable gate, an evidence artifact,
and a stop condition. No item authorizes production rollout, private-corpus
export, paid inference, automatic memory writes, or fleet backfill by itself.

## Status ledger (2026-09-22)

| Workstream | Current state | Gate status | Next smallest accountable step |
|---|---|---|---|
| 1–2. Lab, telemetry and retrieval judgments | See the [authoritative experiment status](retrieval-staged-plan-2026-09-21.md#current-status-and-self-evaluation) | The linked plan records evidence and outstanding gates | Follow that plan; do not maintain a second completion ledger here |
| 3. Query-aware context depth | Design only | **Blocked on #2 baseline** | Label >=30 multi-hop/negation/correction cases, then compare whole-unit depth policies under 4,000 characters |
| 4. Exact subject recognition | Existing exact PeopleSQL/skill primitives remain separate; no generalized semantic subject matcher | **Not started** | Build the bounded people/channel/project registry and its negative-scope suite |
| 5. Claim-scoped dreaming | Existing claim review is read-only; no background write path is enabled | **Not started** | Run 50 shadow claim packets with watermarks and explicit reinforce/revise/qualify/unresolved/write-nothing outcomes |
| 6. Dynamic tool/skill disclosure | Existing skill selector is bounded; dynamic tool disclosure is not enabled | **Not started** | Build a shadow capability selector with mandatory-tool escape hatches and disclosure traces |
| 7. Stateless/no-KV-cache agent | No live transcript replacement proposed | **Not started** | Build the paired replay harness and Context IR before changing prompt assembly |
| 8. Semantic graduation/kernel consolidation | No semantic graduation or self-modifying kernel | **Locked until #1–#7 pass** | Run the held-out graduation test only after all earlier gates have evidence |

The status ledger is deliberately conservative: a passing harness or shadow arm
authorizes the next measurement, not a production rollout. Update this table only
when the corresponding evidence artifact and gate decision exist.

## Common rules

- **Evidence before optimization.** Every comparison uses a frozen, authorized
  snapshot, stable case IDs, a dev/holdout split, and source-span labels.
- **Errors are not abstentions.** Retrieval/provider failures have their own
  denominators and may not be counted as successful no-answer decisions.
- **Safety is deterministic.** Identity, audience, corpus, time and provider
  egress gates run in code; model judgments can rank or qualify but cannot grant
  authorization.
- **Budgets are first-class.** Every experiment reports latency, context size,
  failure rate and quality together. A quality win that blows the latency or
  context budget is not a win.
- **Holdout is sacred.** Prompts, thresholds and lane weights are tuned only on
  dev. Holdout is opened once for the decision report.

## 1. Retrieval lab and telemetry

**SMART goal.** By 2026-10-05, run the synthetic lab and one separately approved
  sanitized snapshot through vector@5, vector@20 and lexical controls, with at
  least 40 answerable and 10 no-answer cases, and publish a replayable report
  containing evidence-group recall, complete coverage, MRR, citation integrity,
  forbidden evidence, no-answer empty rate, p50/p95 latency and context chars.

**Success criteria**

- Dataset validator rejects unknown IDs, duplicate labels, malformed quotes and
  quotes not occurring exactly once in their frozen source.
- Scorer is duplicate-safe, handles multi-hop evidence groups, enforces a cumulative
  excerpt budget without truncation, and excludes errors from quality denominators.
- Runtime telemetry is content-free, process-local, bounded to 256 recent
  samples per operation, agent-isolated, detached on read, and visible through
  diagnostics.
- The first real snapshot report is reproducible from saved predictions without
  rerunning inference.

**Evidence:** `eval/retrieval/`, the [experiment plan](retrieval-staged-plan-2026-09-21.md), telemetry and
scorer tests, private `reports/retrieval-lab/*` output.

**Stop/rollback:** Do not change production ranking or thresholds from this
  workstream alone. If the snapshot cannot meet provenance/split/privacy checks,
  stop and fix the dataset rather than tuning retrieval.

## 2. Multi-lane candidate discovery + no-answer/conflict judgments

**SMART goal.** Within two weeks after the first real-lab baseline, compare existing
  QMD vector + BM25 hybrid retrieval before adding any new discovery lane. Add a
  lane only for a demonstrated evidence gap, then evaluate independent typed judgments for answer support,
  contradiction, shortlist adequacy and no-match. Advance only if holdout
  complete coverage improves by **>=10 percentage points**, forbidden evidence
  does not increase by **>1 point**, and p95 retrieval+judgment latency stays
  within **+150 ms** of the baseline.

**Success criteria**

- Each lane has a per-lane candidate count, latency and unique-span contribution.
- Union deduplication cannot inflate recall; contradictory evidence remains
  separately visible instead of being averaged away.
- No-answer is an explicit existence judgment, not “the top result looked weak.”
- Provider failures, low confidence and insufficient shortlist coverage remain
  distinct outcomes.
- For the eventual typed arm: zero wrong-scope or injection-like candidates in
  final context, no-answer false-answer rate <=5%, no-answer recall >=80%,
  answer-bearing precision >=90%, contradiction recall >=90%, citation integrity
  >=99%. Tune on dev only; evaluate the real holdout once.

**Evidence:** frozen lane predictions, raw typed outputs, threshold replay,
  holdout comparison table, and a failure taxonomy by lane.

**Stop/rollback:** Keep the arm shadow-only if the gain comes from leakage,
  wider context, a changed case mix, or an unacceptable privacy/latency cost.

## 3. Query-aware context depth

**SMART goal.** Within three weeks of the multi-lane baseline, compare omit,
  citation-only, matched excerpt, full event and bounded-neighbor expansion under
  equal **4,000-character** budgets on >=30 multi-hop, negation and correction
  cases. Select a depth policy only if answer-support accuracy rises **>=8
  points** over citation-only without >10% context growth or >100 ms p95 cost.

**Success criteria**

- Whole evidence units are selected; the system never slices away attribution,
  negation, dates or supersession qualifiers to fit a budget.
- Required complementary groups can be selected together.
- Citation line ranges and excerpts remain source-consistent in every arm.
- The report distinguishes retrieval coverage from downstream answer quality.

**Evidence:** paired depth manifests, context-size/latency distributions,
  blinded answer labels and citation-verification results.

**Stop/rollback:** If no depth policy beats the simpler policy on holdout, keep
  the simpler policy; do not add generated summaries as a compensating shortcut.

## 4. Exact subject recognition for people/channels/projects

**SMART goal.** Within four weeks, implement a deterministic subject registry
  for people, channels and projects with exact identifiers, aliases, audience,
  freshness and source citations, and reach **>=99% precision** on a 100-case
  scope/identity suite with **>=95% recall** on approved aliases before adding
  semantic subject matching.

**Success criteria**

- Exact identity/audience gates run before ranking or provider egress.
- Cross-agent, wrong-person, renamed-project and private-channel cases fail
  closed.
- A subject packet is bounded, cited, freshness-marked and independently
  inspectable; it is not a hidden prompt blob.
- Materialized subject delivery beats repeated raw retrieval on p95 latency in a
  paired shadow comparison.

**Evidence:** registry fixtures, negative-scope tests, packet snapshots, and a
  paired latency/usefulness report for at least two real subject types.

**Stop/rollback:** Do not generalize PeopleSQL to arbitrary semantic topics
  until exact subjects demonstrate useful delivery in two distinct domains.

## 5. Background claim-scoped dreaming

**SMART goal.** Within six weeks, run a shadow-only background job over at least
  50 claim-scoped packets, each bounded by an evidence watermark, producing one
  of reinforce, revise, qualify, unresolved or write-nothing. Require **>=0.90
  precision** for retained claims and **>=0.80 recall** on a held-out labeled
  claim set, with every retained claim carrying supporting citations and a
  correction/withdrawal path.

**Success criteria**

- The unit is a claim plus unseen evidence since a watermark, not “summarize the
  whole corpus.”
- Observation time, effective time, speaker/attribution and correction lineage
  remain distinct.
- Contradictions and source withdrawal prevent silent reinforcement.
- Automatic writes remain disabled until precision/recall and operator review
  gates pass twice on separate snapshots.

**Evidence:** claim packets, raw judgments, source-linked decisions, watermark
  replay, correction/withdrawal tests and blinded human labels.

**Stop/rollback:** Any unsupported retained claim, attribution loss or stale
  overwrite blocks publication and returns the item to unresolved/shadow state.

## 6. Dynamic tool/skill disclosure

**SMART goal.** Within eight weeks, extend the proven skill-selector shape to a
  shadow capability selector over at least 30 tool/procedure cases: expose short
  descriptions first, return a typed applicability decision including none, and
  disclose full schemas only when selected. Reach **>=90% correct applicability**,
  **<=5% unsafe disclosure**, and **>=20% median prompt-token reduction** versus
  always exposing the full catalog, with no policy-tool suppression.

**Success criteria**

- “Mentioned” is not “requested”; quoted text, cancellation and scope changes
  are explicit negative cases.
- Mandatory safety/policy tools cannot be hidden by semantic ranking.
- Full-schema disclosure is auditable by request, selected capability and reason.
- Measure actual tool adoption and task success, not selector accuracy alone.

**Evidence:** synthetic and holdout selector cases, disclosure traces without
  secrets, token/latency distributions and downstream task labels.

**Stop/rollback:** Keep current static disclosure when token savings trade for
  missed mandatory tools or task regressions.

## 7. Stateless/no-KV-cache agent experiment

**SMART goal.** Within ten weeks, build a replay harness comparing the current
  accumulating-transcript agent with a stateless turn that reconstructs a bounded
  Context IR. Run >=20 multi-turn tasks across topic switches, compaction and
  restart recovery. A stateless arm is promising only if blinded task success is
  **non-inferior within 3 points**, full cost is **>=15% lower**, and restart
  recovery loses **no required evidence**.

**Success criteria**

- Context IR separates current goal, constraints, observations, durable claims,
  open loops, conflicts, evidence references, freshness and audience policy.
- Cached and uncached tokens, latency, tool calls and provider cost are measured
  end to end; prompt size alone is not the objective.
- The same evidence boundary and task state feed both arms.
- A model restart cannot erase required state or manufacture unsupported claims.

**Evidence:** task manifests, paired rendered contexts, cache/cost telemetry,
  blinded task labels and restart/compaction replay logs.

**Stop/rollback:** Do not replace the live transcript model unless the full-cost
  and quality gates pass; a smaller prompt by itself is not a success.

## 8. Semantic subject graduation and self/kernel consolidation

**SMART goal.** Only after workstreams 1–7 pass their gates, spend one quarter
  evaluating semantic graduation for subjects and a model-independent kernel.
  Promote no more than **10** candidates from exact subjects using a held-out
  graduation test requiring **>=95% precision**, **>=90% recall**, zero audience
  violations and a human-reversible demotion path. Consolidation may publish
  only evidence-linked, conflict-aware Context IR updates.

**Success criteria**

- Graduation is earned from repeated exact recognition/usefulness evidence, not
  cluster size, sentiment or embedding proximity.
- Stable subject identity survives reclustering and source withdrawal.
- The kernel stores typed state and citations, never hidden chain-of-thought or
  untraceable summaries.
- Every consolidation has a diff, provenance, confidence/uncertainty, rollback
  and operator audit record.

**Evidence:** graduation candidates, held-out recognition/usefulness report,
  semantic-versus-exact ablation, kernel diffs, withdrawal/demotion drills and
  operator sign-off.

**Stop/rollback:** No graph database, universal ontology, automatic “remember
  everything,” or self-modifying kernel. If semantic matching cannot beat exact
  subjects without scope errors, do not graduate it.

## Decision log template

For every milestone, record:

1. snapshot ID/hash and case counts by split/category;
2. code, dependency and model identity;
3. baseline and candidate metrics with denominators;
4. latency/context/cost deltas;
5. failures, abstentions, forbidden evidence and unresolved cases;
6. the gate decision: advance, shadow, revise or stop;
7. owner, date and the next smallest experiment.

The roadmap is complete only when each gate has evidence. A passing experiment
authorizes the next experiment, not an unmeasured production rollout.
