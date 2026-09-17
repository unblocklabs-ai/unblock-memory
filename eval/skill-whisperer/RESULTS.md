# First Skill Whisperer comparison — 2026-09-17

**Promising enough for a broader evaluation; not a production accuracy claim.**
No plugin runtime changes, fleet configuration changes, or Bill SSH tests were made.
The TypeSafe skill guided the closed-choice + explicit no-match design.

## Setup

- 40 synthetic, pre-labeled requests: 30 skill-positive and 10 no-skill cases.
- 16 real skill-description snapshots, not a deployed fleet inventory.
- Cases include overlapping skills, exclusions, quoted task names, topic switches,
  cancellations, and follow-ups requiring history. Several labels allow alternatives.
- Actual production QMD `searchSkills` with the default embeddinggemma model;
  @unblocklabs/qmd 2.9.4, unblock-memory source at `91bfcb0`.
- TypeSafe pinned to `jev-1.13.0`; same descriptions and conversation content,
  with explicit current-request/history fields rather than the vector query's flattening.
- No fitted confidence threshold, generative judge, or changed labels after results.
- Fixture/prompt hash: `1b4859aa2f9beab42fce11900ecb201ff36844c94653bdcf0175264a0297e3fc`.

## Results

| Selector | Correct | False hints on no-skill cases | Wrong skills | Missed skills | Warm p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Current vector top-one, minimum 0.5 | 24/40 | 1 | 2 | 13 | 19 ms | 24 ms |
| Vector top-three, then TypeSafe + none | 40/40 | 0 | 0 | 0 | 203 ms | 805 ms |
| Full test roster, TypeSafe + none | 40/40 | 0 | 0 | 0 | 183 ms | 301 ms |

The hybrid arm removes the 0.5 gate and judges the unthresholded top three. Keeping
that gate would preserve its missed candidates. Top-three retrieval contained an
acceptable skill for all 30 positive cases; a larger roster may not.

Removing the vector threshold entirely scored 25/40. A post-hoc sensitivity check
of thresholds 0, 0.30, 0.35, 0.40, 0.45, 0.50 and 0.60 scored respectively
25, 30, 29, 29, 28, 24 and 15 out of 40. Thus a simple lower threshold helped,
but did not close the gap on this fixture. These are not held-out tuning results.

Examples:
- A request for an image of a LEGO car selected the LEGO engineering skill under
  vector search; both TypeSafe arms chose imagegen.
- Translating the words “create a Linear ticket” triggered Linear under vector
  search; TypeSafe chose none.
- A new PDF inspection task after LEGO discussion still selected LEGO under vector
  search; TypeSafe chose PDF.

## Latency, failures and cost

- Local model/roster initialization in the completed run: 1.87 seconds, excluded
  from warm figures. The first attempt downloaded a roughly 318 MiB local model.
- The first attempt stopped after an HTTP 529, with five complete cases and one
  partial case. That partial run is retained and excluded from aggregate accuracy.
- The completed run had one HTTP 529 in the hybrid arm; a bounded retry succeeded.
  Its slowest end-to-end hybrid result was 3.56 seconds, including retry delay.
- Hybrid: 25,802 input tokens, estimated $0.001084 for 40 successful evaluations.
- Direct: 60,150 input tokens, estimated $0.002526 for 40 successful evaluations.
- Total completed-run estimate: $0.003610 at published $0.042/M input tokens;
  excludes the partial run and any charges for failed requests. Not an invoice.
- Fixed arm order and one pass do not establish reliable relative latency.

## Recommendation

Keep local candidate retrieval and evaluate TypeSafe as the applicability decision,
including none, rather than as a veto after the existing high similarity gate.
Also keep direct full-roster selection as a comparison: it worked here, but 16
skills cannot establish scaling behavior for a fleet inventory.

Before integration, use a larger representative roster and separately labeled
holdout requests, then validate suggestion usefulness with the actual agent.
Production must have a bounded timeout and preserve unblocked turns on failures;
the multi-second retry policy here is for offline measurement, not a hook default.

## Evidence and checks

Local raw outputs (ignored, retained):
- `reports/skill-whisperer/2026-09-17T17-35-38-195Z/`: partial first attempt.
- `reports/skill-whisperer/2026-09-17T17-37-07-162Z/`: completed run, input snapshot,
  per-case answers/probabilities, HTTP attempt log, summary and report.

Passed: evaluation TypeScript check, fixture dry run, seven existing whisperer
tests, repository typecheck, Knip and `git diff --check`. No production deployment,
full preflight, or fleet runtime validation was performed.
