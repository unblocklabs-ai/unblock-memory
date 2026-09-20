# Extracted memories: lean v1

Built from released memory 0.3.20 in an isolated worktree. Original dirty checkout
and paused Cerebras work are untouched. Not released or enabled in production.

## Scope

- [x] Luna extraction + exact-citation checks + independent TypeSafe support/usefulness.
- [x] Three tables in the existing durable DB; no Markdown intermediary.
- [x] Per-session opaque cursors, bounded lookback, leases and atomic fact/checkpoint commit.
- [x] Persisted backfill start, explicit earlier-history replay, source-time ordering.
- [x] Source reset/deletion withdrawal, versioned corrections, per-session deduplication.
- [x] Optional Gateway schedule, CLI run/report, missing-key safety and shadow default.
- [x] QMD projection, semantic retrieval and authoritative version checks.
- [x] Focused tests, full repo preflight and Bill shadow/retrieval pilot.

## Evaluation

**Current code validation:** After test cleanup, full preflight passes **319/319 default tests**, Knip,
build/typecheck, both plugin inspectors and package dry-run. The intermittent
first-open SQLite race is fixed with a bounded five-second SQLITE_BUSY retry around
WAL activation only. Other errors propagate and failed connections close. The
unchanged initializer failed 3/160 concurrent stress opens; the fix passed 800/800
opens across 100 fresh databases, with single migration, all writes and integrity
verified. Logs: `reports/sqlite-startup-preflight.log` and
`reports/sqlite-startup-stress.log`. No release or host update.

Three historical noise-parser evaluation tests now run separately with
`npm run test:eval:noise` (**3/3 passed**). One redundant cooldown test was removed;
both people-hook arrival orderings remain covered. Latest preflight log:
`/tmp/unblock-test-cleanup-preflight.log`.

**Latest, lasting facts:** Luna and TypeSafe now share the narrow enduring-background
policy (`lasting-facts-v10`, unchanged 0.90 gates). Across the same ten sessions /
142 messages, Luna proposed three facts and TypeSafe retained one: Bek's favorite
color is red. The two rejected proposals were feature requests framed as preferences.
Synthetic controls matched 15/16 expected retained sets; the remaining attributed
hearsay was safely rejected after Luna dropped attribution. Build/typecheck/Knip and
21 focused tests passed. See `EXTRACTION-LASTING-FACTS-EVAL.md`. No production changes.

**Conversation chunks:** Shared cleaning, single-session token chunks, adaptive SDK
reads, overlap and resumable partial-page/message checkpoints are implemented.
Ten real sessions (142 messages) completed with exact source coverage and zero calls
on unchanged reruns. Same-seven-snapshot Luna calls fell from 39 to 7. Earlier
task-fact-positive prompt evaluations are superseded by the lasting-facts policy.

Evidence is in ignored `reports/` and Bill's private
`/Users/billjohansson/.openclaw/extraction-eval.PlONcv/` directory.

### Historical initial pilot (superseded by the evaluation above)

The first support prompt falsely rejected the explicit red correction at 0.84.
Clarifying self-report/speaker attribution raised support to 0.98. A Choice-based
support check further separates support from contradiction/insufficient evidence.
Support and usefulness gates remain 0.90; replacement is judged only when a prior
fact actually exists. Provider probabilities are signals, not guarantees.

The ten-case synthetic set checks resolved corrections, unconfirmed guesses,
hypotheticals, real preference changes, attribution, conditional plans, chatter and
prompt injection, a held-out person/value and an answer contradicting the prompt's
red example. Evaluate the whole retained set, including unwanted extras.
Hearsay/relative-date plans are deliberately conservative and are not considered a
fully calibrated success. Negative validation probes directly test a retained guess,
wrong value, hypothetical asserted as fact and wrong person.

Bill's actual color session produced exactly **Bek's favorite color is red.**
Evidence is his Sept 11 correction, not Bill's guess. Rerun without new messages made
zero Luna calls and added no duplicate. Initial tiny-index semantic retrieval returned
the fact for both color phrasings in 11–14 ms; not a production-scale benchmark.
The final source validation accepted the real correction at 0.97 support and 0.93
usefulness. A live existing-fact correction scored 0.98 for replacing the same fact;
unrelated new chatter produced no memory operation.

Final manual review: **9/10 synthetic cases matched the expected retained fact set**;
the conditional future launch plan was conservatively omitted. The attributed-hearsay
case passed in the final run, but earlier runs exposed attribution variation in Luna
which TypeSafe rejected. All four planted invalid proposals were rejected. Both held-out
person/value cases passed: the pipeline is not hardcoded to Bek/red.

Final Bill read-only check: production remains 0.3.20, has no extraction config and
has none of the three extraction tables. No release, production activation or fleet
update was performed.

## Review and fixes

Final preflight passed: **311 tests**, TypeScript build/typecheck, Knip, static and
runtime plugin inspection, and package dry-run. Twelve focused extraction tests cover
gates, isolation, atomicity, deduplication, revisions, leases/cadence, retries,
backfill continuation, source rewrites and canonical retrieval. Validation follows
the TypeSafe skill's citation-check pattern: exact quote matching before semantic
support judgment, plus an independent usefulness gate.

- Persist historical extraction boundary: a scheduled continuation must not skip
  unprocessed backfill pages by switching to the live watermark.
- Filtering one session must not withdraw other approved sessions' memories.
- Refresh active versions after asynchronous retrieval/context expansion.
- Reject source-generation changes during inference before committing.
- Preserve existing file corpora named extracted when the new feature is disabled;
  reserve that name only when enabling extraction.
- Bound retained lookback by both message count and bytes.
- Exclude managed records from default raw QMD retrieval; only plugin APIs enforce
  canonical-record freshness.

## Intentional limits

No relationship graph, global semantic merge, separate job system, automatic dossier
changes, or per-message AI freshness check on search. No third production DB. Bill's
production plugin/config and daily memories are unchanged: tests use a separate
staged plugin and isolated output DB/index. Broader shadow calibration is the next
step before enabling publication or fleet rollout.
