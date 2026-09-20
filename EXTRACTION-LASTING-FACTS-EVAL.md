# Lasting-memory prompt evaluation — 2026-09-20

## Change

Luna and TypeSafe share one retention policy in `src/extraction-model.ts`:
retain explicit identity, relationships, ongoing responsibilities, stable personal
preferences, enduring project purpose and adopted standing constraints. Do not turn
task history, releases, technical documentation or one-off feature requests into
lasting memory. Original conversations remain searchable through QMD.

TypeSafe checks category eligibility separately from factual support. Ordinary
low-stakes personal facts qualify; strategic importance is not required. Model,
reasoning level, schemas, transport and all 0.90 acceptance thresholds are unchanged.
Current prompt version: `lasting-facts-v10`.

## Real-session comparison

Same frozen ten Bill sessions, 142 cleaned messages, actual incremental worker,
fresh private evaluation databases. All ten sessions completed, each with one
isolated Luna request; all unchanged reruns skipped inference. These are isolated
`runtime.llm.complete()` calls on Bill's machine, not his conversational agent turn.

| Prompt | Luna proposals | Exact-quote failures | TypeSafe approvals |
| --- | ---: | ---: | ---: |
| Previous broad policy, v7 | 26 | 2 | 8 |
| Initial lasting policy, v9 | 5 | 0 | 0 |
| Category-calibrated policy, v10 | 3 | 0 | 1 |

Fewer approvals are intentional; the old policy's project/task facts are no longer
positive targets. v9 mistakenly treated the favorite-color fact as insufficiently
important (support 0.99, usefulness 0.79). v10 clarified category eligibility without
lowering the threshold.

### Manual review of every v10 proposal

1. **Keep: "Bek's favorite color is red."** The human says "its red
   :slightly_smiling_face:" after the blue guess. The discarded guess is not retained.
   Support 0.99; category eligibility 0.91. This passes, but the latter is close to
   the 0.90 threshold; one run is not proof of stability.
2. **Reject: agentic video should be default without opt-in/static fallback.** Luna
   framed a requested skill implementation as Bek's preference. It belongs in the
   skill/code, not personal background. Support 0.85; eligibility 0.10.
3. **Reject: agents should download from public video sources without arbitrary
   domain restrictions.** Another feature requirement presented as a preference,
   not a standing personal trait. Support 0.83; eligibility 0.24.

The other eight sessions produced no proposals. Source review supports excluding
their API discussions, deployment/status updates, issue requests and sales-copy
task content under this policy. The video session still exposes some over-extraction
by Luna; TypeSafe's independent gate is doing useful work.

## Positive and negative controls

Expanded `scripts/extraction-cases.mjs` from 10 to 16 cases. Temporary-plan expectation
is now empty; added explicit role, relationship, standing responsibility/constraint,
feature-release exclusion and activity-not-role controls.

**15/16 expected retained sets matched by manual semantic review.** Direct personal
facts, corrected values, different people/colors, role, relationship, responsibility
and standing rule survived. All seven expected-empty cases remained empty, including
hypotheticals, unconfirmed guesses, prompt injection and one-off activity.

Remaining miss: given "Rico told me his favorite color is green. Mine is red," Luna
kept Bek's red correctly but proposed Rico's green without hearsay attribution.
TypeSafe rejected that proposal (support 0.71), correctly avoiding promotion of a
stronger claim. We still miss the valid attributed fact. Do not call this 16/16 or
relax support to hide the miss.

These synthetic controls are calibration checks, not an independent accuracy
estimate. The three nominally held-out real sessions were also observed in the
earlier v9 run; this is a paired rerun, not a pristine unseen test set. Broader
real-world positive examples and repeatability checks remain useful before rollout.

## Validation and boundaries

- Build, typecheck, Knip: passed.
- Focused extraction/chunk tests: 21/21 passed.
- Ten sessions completed with no worker failures and no unchanged-session inference.
- Bill production check: extraction config absent; extraction tables absent.
- No production memory/config changes, normal Bill turn, commit or release.
- Subsequent SQLite startup fix: full preflight now passes **323/323 tests**, Knip,
  build/typecheck, both inspectors and package dry-run. A bounded SQLITE_BUSY retry
  during WAL activation resolves the earlier first-open failure; 800 concurrent
  opens across 100 fresh databases passed with migration/write/integrity checks.
  This infrastructure fix did not change the prompts or inference results above.
- Existing saved memories are not automatically purged or replayed by this prompt
  change. Evaluation used fresh private databases; historical cleanup is separate.

Private inputs/results remain in ignored `reports/bill-real-lasting-v*.json`,
`reports/bill-lasting-v*-controls.json`, and Bill's isolated evaluation directory.
