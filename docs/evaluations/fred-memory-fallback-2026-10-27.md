# Fred explicit-search fallback: deployment and one-week evaluation

Owner: Bill. Requested by Rico on 2026-10-27. Scope: Fred (CLFWD), public
`memory_search` falling back to existing local candidate retrieval when the
TypeSafe key is unavailable or all candidate judgments fail. Automatic Memory
Whisperer injection remains strict; this change does not make its unjudged
passages eligible for automatic injection.

This is a prospective runbook, not a completed evaluation. All targets below
are proposed acceptance gates; no baseline, deployment result, production sample
size, or measured quality/latency is asserted here.

## Evidence and privacy

- Record deployed commit/package version, actual deployment time, process epoch,
  test command/results, and scheduler job ID in Bill's private operational notes.
- Keep queries, customer snippets, labels, source paths, and replay/index snapshots
  on Fred or in access-restricted task artifacts outside the repository (directory
  0700, files 0600). Publish aggregate metrics and sanitized fixture results only.
  Do not copy Fred's corpus into this public repository or a different customer's
  environment. Do not print keys, raw provider responses, or credential errors.
- Source of observational counters: `memory_diagnostics` →
  `whisperers.telemetry.operations.memorySearch`. Record calls, outcomes, and
  measurement totals/samples, including `requestsSucceeded`, `requestsFailed`,
  `fallbackKeyUnavailable`, `fallbackAllJudgmentsFailed`, `eligible`, `results`,
  `elapsedMs`, `retrievalMs`, and `judgeMs`.
- Counters are process-local. Recent p50/p95 cover at most 256 calls, including
  failures, and reset on recreation. Record capture times/epochs; subtract totals
  only within the same epoch. Do not subtract percentiles or combine epoch p95s
  into a weekly p95. The snapshot does not split latency by ranking mode or retain
  individual query content: use timed, private fixed-suite invocations for that.
- Keep controlled test calls distinguishable from natural searches using capture
  boundaries and private invocation receipts. Report both counts separately.

## Fixed-suite baseline and post-deploy checks

Before changing the installed plugin, freeze the five-query live smoke suite in
Bill's private task artifacts: product composition, target market, prior expansion
decisions, company relationship, and a nonexistent-token negative control. Record
the pre-deploy outcomes and rerun the identical inputs after deployment and at
review. This small smoke suite measures availability and source usability, not
representative customer-corpus precision. The committed deterministic tests cover
session and file sources, duplicate passages, corpus/session restrictions, and
provider failure/recovery arms independently of production credentials.

For the one-week quality review, label up to 20 natural searches using the rubric
below, including exact fact, paraphrase, ambiguous/outdated, negative and scoped
cases where available. Report category counts and gaps rather than manufacturing
a balanced production sample. Sanitized synthetic fixtures establish contracts,
not customer-corpus quality.

Run the same queries, index snapshot, corpus/session scope, maxResults=5, and
review rubric on the pre-deploy revision and deployed revision. Preserve the
fixture hash and revisions. If baseline cannot be collected, state why and mark
comparative quality/latency unavailable; do not reconstruct it from memory.
Exercise failures using a deterministic local stub/test harness, never by
deleting production credentials or deliberately exhausting credits. Existing
`eval/memory-ranking` replay tools use a different candidate depth and paid
TypeSafe judgments: do not present their output as a public-tool fallback test.

Required arms and acceptance gates:

1. Healthy provider: normal TypeSafe ranking, existing usefulness threshold and
   maxResults honored. No unnecessary fallback.
2. Missing key/disabled TypeSafe/key-resolution failure: valid retrieval succeeds,
   returns local leads with a degradation warning, `rankingMode: retrieval`,
   `scoreMeaning: retrieval_rank`, and `minUsefulnessApplied: false`. Zero provider
   requests for the missing-key arm.
3. All provider requests fail: cover HTTP 402, authentication rejection, rate limit,
   server error, transport failure, and timeout. With eligible local candidates,
   each returns retrieval-ranked leads and a warning, not a provider-caused empty
   answer or fabricated probability. Assert fallback reason/counters.
4. Partial judgment success: retain only successful probability-ranked results;
   failed candidates do not join the ranking as raw retrieval scores. Preserve
   partial warning and threshold behavior. Zero mixed score domains.
5. Cancellation, invalid/oversized input, unavailable local index, and genuine
   zero candidates remain distinguishable; no fallback masks them as successful
   evidence. Aborted operations do not return leads after cancellation.
6. Safety invariants: zero out-of-scope corpus/session results, zero skill results,
   bounded snippets/results, duplicates suppressed, and no raw credential or
   provider-error disclosure. Automatic injection still fails closed.
7. Recovery: after a failure arm, a healthy stub on the next call restores
   TypeSafe ranking automatically without restart or configuration changes. On
   Fred, verify this again with the real provider only when existing access is
   working; otherwise report real-provider recovery as unverified.

All deterministic reliability/scope/score-contract gates must pass. One scope
leak, mixed probability/retrieval ranking, or fallback-after-cancellation fails
release acceptance regardless of aggregate quality.

## Quality and source validation

For all returned fixed-suite hits, read the exact returned reference with
`memory_get` and its actual line range. Follow `nextFrom` when needed. An `ok`
but truncated read is not proof the complete claim was checked; `not_found` or
`unavailable` is a failed source read. Review dates, attribution, adjacent context,
and whether a passage describes a proposal or an observed result.

Blind the reviewer to ranking mode, scores, and result order before assigning
passage relevance: 0 irrelevant, 1 marginal, 2 useful, 3 direct/high-value. Store
short reasons privately. A second reviewer adjudicates disputed relevant labels
and every potentially consequential false positive; do not use the unavailable
TypeSafe service as the sole reference grader.

- Primary metric: precision@5 = useful hits (grade ≥2) / 5 per answerable query;
  missing slots count as non-useful. Report macro average and numerator/denominator,
  returned-hit precision, nonempty rate, and number of answerable queries.
- Negative cases: report nonempty false-positive rate separately, with count and
  denominator; a raw retrieval lead alone is not a false factual assertion. Check
  whether the assistant read it, treated it as certain, or made an incorrect claim.
- Proposed quality gate: fallback macro precision@5 ≥0.60 on answerable fixtures;
  if a healthy-provider paired baseline exists, decline ≤0.15 absolute. Zero
  materially wrong assertions supported only by unverified fallback leads.
  Report results by case category; a small pilot does not establish superiority.
- Proposed source gate: 100% of evidence used in reviewed factual answers is read
  successfully and supports the claim. Report stale/contradicted and unreadable
  sources separately, not as ranking-provider failures.

## Latency, observation window, and review times

Measure end-to-end tool wall time and snapshot retrieval/judging timings for the
same suite in healthy, missing-key, and total-failure arms. Report p50/p95 and n
per arm, cold/warm status, configured timeout, and errors. Proposed latency gate:
missing-key p95 ≤ local-retrieval-only p95 + 1 second; total-failure p95 ≤
local-retrieval-only p95 + configured provider timeout + 2 seconds. Investigate
any >2× paired baseline regression. These are targets, not observed performance;
small-n percentiles are descriptive and include the exact sample count.

- At deployment: capture baseline/post-deploy checks and initial diagnostics.
- Within 48 hours of actual deployment: Bill checks Fred is responsive, runs a
  scoped public search and exact-source read, compares counters for unexplained
  failures, and confirms deployed revision. Use a controlled failure test off the
  production credential path if the real provider is healthy.
- One-week review: 2026-11-03, America/New_York. Schedule an explicit local clock
  time and save its verified UTC equivalent: DST ends November 1, so New York is
  UTC−05:00 on review day. Calendar-week same wall time is 169 elapsed hours from
  October 27, not 168. The scheduling receipt, not this document, proves it exists.
- At review: capture diagnostics, tally all available natural `memory_search`
  calls by epoch/outcome, repeat the frozen suite, and privately review up to 20
  naturally occurring degraded searches selected chronologically, not cherry-picked.
  Deduplicate repeated searches from the same request; report queries, distinct
  human requests, source corpora, failure modes, and days covered.
- Coverage target: ≥20 natural degraded searches across ≥5 distinct human requests
  and ≥3 days, plus all deterministic arms. If traffic/provider failures are fewer,
  report the exact sample and **insufficient natural evidence**, not a pass inferred
  from zero complaints. Controlled tests establish behavior only. Recommend a
  specific additional observation window; schedule an extension only within the
  owner's authorization, never silently convert this into a recurring monitor.

## Decision and delivery

Bill reports in Slack channel `C0AHZFCAS1K`, thread `1793083978.852489`, using the
trusted original task route. Include deployed revision/PR, observation window,
sample coverage, reliability outcomes, fallback counts/reasons, precision@5 and
source-read results, p50/p95 with denominators, verified/unverified recovery,
and concrete learnings. Send only aggregate/customer-safe examples.

Recommend retain, patch, or roll back based on evidence. For each false positive
identify the failure layer and next action: query/scope correction, stale index
repair, source-read behavior, or a tested ranking change. Consider an alternative
small model only if blinded paired evidence shows unacceptable fallback relevance
and the proposed model's availability, cost, latency, and privacy route are proven.
Name the owner and action for unresolved gaps. Do not merge the PR without the
required approval. Verify Slack delivery before marking the review complete.
