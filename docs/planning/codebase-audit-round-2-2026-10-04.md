# Codebase audit, round two — 2026-10-04

Baseline: unblock-memory `9c281a9` (0.7.2), QMD `8b6ed52` (2.11.0).
Scope: local cleanup only; no publication, fleet changes, or paid inference.
Three subagents reviewed background processing, people/AI, and retrieval;
the primary reviewer covered runtime, shared infrastructure and packaging.
This round excludes the findings already resolved in the first audit.

## Findings and resolutions

| ID | Finding | Targeted resolution | Evidence on baseline |
| --- | --- | --- | --- |
| R1 | An old failed manager startup evicts a newer cached replacement. | Remove the pending entry only while it is still owned by that startup. | Close/retry/failure sequence created three managers instead of reusing the second. Owner-boundary regression failed before repair. |
| R2 | Workspace classification resolves the same root for every path. | Resolve once per invocation, preserving per-file canonicalization and untrusted missing paths. | 1,000 paths caused 1,000 workspace realpath calls. |
| R3 | Cluster previews calculate chronology that summaries discard. | Dedicated representative-preview reader; full member reads retain temporal metadata for every sort. | 20 clusters / 10k chunks: 20 chronology queries; 90 ms vs 20 ms without chronology, identical output. |
| R4 | `memory_get` resolves the document twice and then queries its body. | Request metadata and body in one public QMD `get` call; preserve exact-path validation. | 100 reads / 10k documents: 300 document SELECTs vs 100; 261 ms vs 89 ms, identical bodies. |
| R5 | QMD virtual-path equality concatenates indexed columns, causing scans. | Use collection/path equality only for canonical literal round-trips; retain all fallback semantics. | Query plan changes from `SCAN d` to existing composite-key index lookup. |
| R6 | Quality auditing materializes whole documents for every chunk and lookahead row. | Fetch page metadata, then one body per distinct hash for processed rows; no persistent cache. | 20 chunks plus lookahead from one 2.24m-character document returned 47.04m characters vs 2.24m, identical chunk text. |
| R7 | Observing one response session reconciles every review in its cohort. | Restrict reconciliation to the session's tasks using existing indexes. | One session change caused 1,000 evidence updates; only one status changed. |
| R8 | Training query selection loads negative inputs before filtering. | Join/filter gates and examples in SQL before materializing inputs; remove one-caller helper and Map. | 1,000 examples / 10 eligible: 23,044,890 bytes loaded vs 230,430 bytes. |
| R9 | Training refresh prepares three identical inserts for every example. | Prepare once inside the session transaction, reuse statements. | 1,000 unchanged examples caused 3,000 INSERT preparations. |
| R10 | Projection retirement searches the live-window array for each removed session. | Build one Set of live session IDs. | 1,000 live windows / 1,000 retired projections caused 1m comparisons. Quiet all-retained runs already short-circuit. |
| R11 | Skill Whisperer parses all history twice before retaining a few messages. | Scan backward for the last N visible messages and share parsed history between retrieval and Jev. | 10k-message hook parsed 20k messages; zero-history query still parsed all 10k. |
| R12 | Primer cache repeats schema checks and sorts all cache rows on every write. | Initialize once per store; index the existing deterministic eviction order; keep immediate 2,000-entry bound. | 90 read/write pairs at 2,000 rows: 180 CREATE checks, 90 prunes; ordering index reduced synthetic elapsed time from about 110 ms to 20 ms. |
| R13 | Config's empty-root path duplicates 13 feature defaults; primer duplicates seven schema defaults. | Normalize absent root/primer inputs into existing resolvers; retain null/invalid-input distinctions. | Root absent/null equals empty object; primer schema defaults equal absent-input resolution. |

These are synthetic work/scaling measurements, not Bill's latency or RSS.
R5 is a separate QMD source change; the plugin stays pinned to released QMD
2.11.0 until a future authorized release. R4 works with that existing SDK.

## Intentionally retained

- Domain prompts, eligibility, cadence, leases and checkpoints differ across
  Inside Out, response auditing, extraction, training and whisperers.
- Freshness reconciliation, exact historical cutoffs, source coordinates,
  quote checks and isolated historical indexes protect correctness.
- Runtime and projection atomic writers have different parent-directory,
  permission and error-cleanup contracts. Their small overlap does not justify
  a generic filesystem layer.
- The global temporal annotation rebuild and training's corpus-proportional
  source capture are known first-round tradeoffs, not newly discovered bugs.
- No generic job, query, cache or indexed-chunk framework is introduced.

## Validation and local state

All 13 targeted resolutions are implemented. Three independent cross-owner
reviews found no actionable lost contracts. The training guide now describes
immutable source capture and the public QMD discovery API.

Post-fix synthetic checks:

- R1: two startup attempts, replacement reused; R2: one root resolution for
  1,000 paths.
- R3: zero chronology queries, about 19 ms for the same 20-cluster/10k-chunk
  listing (baseline about 90 ms).
- R7: one evidence update; R8: ten rows / 230,430 bytes; R9: three INSERT
  preparations; R10: no repeated live-window comparisons.
- R11: five message parses for a 10k-message hook; zero for zero-history
  turns. R12: no repeated CREATE checks after initialization, about 23 ms
  for the 90 cache read/write pairs, strict 2,000-entry bound preserved.

Validation:

- Cache-race, discarded-history and repeated-body regressions each failed on
  a disposable untouched baseline and passed with the repairs.
- Plugin: final `npm run preflight` passed, including 456 tests, knip,
  typecheck, build, cold/runtime inspectors
  and package dry-run passed. Generated tracked `dist` is rebuilt.
- QMD: 254 storage-owner tests passed under each of Node and Bun, with 13
  local-model tests skipped in each. Typecheck, lint, knip, build, grammar
  checks and packaged CLI smoke passed. The full unrelated QMD suite was
  not rerun for these two lookup predicates.
- Both repository diffs pass whitespace checks. Production source:
  plugin +117/-99 lines, QMD +18/-2; tests: plugin +132/-14, QMD +26/-0.
  Generated artifacts, docs and validation configuration are separate.

The initial mock-SDK capture failed because the inspector also replaces
TypeBox's schema/default implementation with generic proxies. Real installed
SDK/dependency capture passes. Runtime inspection now uses `--real-sdk`;
it stays local, does not start Gateway services or make inference requests,
and verifies actual dependency-backed registration rather than dummy defaults.
The inspector still reports three pre-existing proof gaps, not live breakages.

Quality page capture does not yield before inference, but it is not a held
cross-process SQLite transaction. Content remains hash-addressed and source
coordinates are checked after inference; a concurrent missing body produces
a retryable partial result without advancing the cursor.

Cleanup was prepared and validated on `codex/audit-round-2` in both repositories,
then included in unblock-memory 0.7.3 and QMD 2.11.1. The plugin pins that QMD
release tarball. No host deployment or paid-model validation is claimed.

The test-audit follow-up wires eight Python preparation tests and 13 QMD
lint-rule test files into validation, replaces literal SDK checks with a real
consumer typecheck, and removes nine redundant runtime tests plus the unused
CLI exit injection. Migration now verifies 1,001 documents across multiple
batches; maintenance listings measure returned text rather than SQL aliases.
Both strengthened regressions failed under deliberately broken code before
passing with production behavior restored. FTS resource/concurrency guards
remain until equally strong owner-boundary replacements exist.
