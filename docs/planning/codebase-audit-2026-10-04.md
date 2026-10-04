# Codebase audit and resolution ledger — 2026-10-04

Baseline: unblock-memory `fdaf372` (0.7.1), QMD `d563039` (2.10.4).
Scope: plugin production code and invoked QMD boundaries. Three reviewers covered
retrieval/indexing, people/AI, and background processing; the primary reviewer
covered shared infrastructure, clustering/curation, packaging and orchestration.

## Findings

| ID | Finding and evidence | Smallest useful resolution | Status |
| --- | --- | --- | --- |
| A1 | A one-file watcher edit processed both 200-file collections. Each updated collection can separately optimize FTS, vacuum and truncate WAL; searches await this work. | Watch affected collections; update once, embed each affected collection, compact once. Partial-update failures force compaction and invalidate retained analysis. | Resolved |
| A2 | Combined whisperer hook waits for slow skill retrieval. Host default is 15 seconds; ready sibling hints can be discarded. Session-end during retrieval still initiated a new Jev call. | Fixed 3-second total skill deadline; cancel on supersession/end/stop. Shared index initialization can finish independently. | Resolved |
| A3 | Three cooled skill turns made three Jev calls but emitted one hint. | Skip inference when all shortlist candidates are cooling down; preserve winner/no-fallthrough policy. | Resolved |
| A4 | Extraction with 1,000 unchanged sessions and maxBatches=5 performed 1,000 source reads, zero model calls, ~1.46s with instant synthetic sources. Static prompt overhead is tokenized even for empty deltas. | Completed-only rewrite-generation/tail watermark skips source/fact reads; partial backfills and appends remain eligible. Cache static prompt tokens. Metadata discovery still scales with session count. | Resolved |
| A5 | Optional-OR session predicate scans all active extracted facts; direct equality uses the existing session index. People identity lookup scans the table per person. 100 lookups/40k identities: ~294ms vs ~1ms indexed. | Direct extraction session predicate; person identity index; response cohort/session/date index. Additive migrations preserve existing data. | Resolved |
| A6 | Query trimming removes one message then tokenizes the whole suffix again. 390 short messages: ~322ms; fitting 300 messages: ~20ms. | Binary suffix search using exact serialized token counts; keep current request and whole messages. | Resolved |
| A7 | Timestamp projection constructs Intl.DateTimeFormat per message. 10k timestamp formatting: ~441ms vs ~98ms reused. | One formatter per projection pass/timezone. | Resolved |
| A8 | Response freshness reloads/hashes/re-extracts all episodes after each judgment; 20 judgments imply ~21 extractions. | Pass prior revision; skip episode extraction on exact equality, retaining changed-source reconciliation. | Resolved |
| A9 | Every cluster page reloads all temporal annotations, repeatedly hashes the same document chunks and writes unchanged locations. Latest-run validation repeats several membership scans. | Hash chunks once per document per load; skip unchanged location writes; two integrity aggregates replace six queries. Global metadata rebuild per page remains. | Optimized; residual retained |
| A10 | Historical training reads/fingerprints documents/vectors per example and builds separate indexes for uncached retrieval. | Capture verified source bodies/vector bytes once per run; close the read transaction immediately. Exact cutoff prefixes, fingerprints and isolated indexes remain. Capture has corpus-proportional RAM cost, not a byte cap. | I/O resolved; tradeoff retained |
| A11 | training-candidates copies QMD discovery mechanics and imports private internals. Skill embedding format policy is duplicated too. | Public QMD discovery-only API and embedding formatters; small plugin adapter preserves ten candidates per lane, raw backend scores and rank. Release QMD before pinning plugin. | Resolved |
| A12 | Manager lexicalOnly is lab/test-only and ignores session-path filtering. No demonstrated public-tool exposure. | Experimental lexical search stays in retrieval lab; ordinary runtime remains vector-only. | Resolved |
| A13 | Repeated Noul leaf contracts, CLI date validation, people tool context resolution, review request setup and one-item grading wrappers. | Reuse small existing primitives/shared leaf schema; remove one-item wrapper; no generic workflow framework. | Resolved |
| A14 | Shipped MLX worker has no in-repo caller; external use unverified. | Retain documented standalone Studio-serving worker; no evidence justifies deleting an external entry point. | Retained intentionally |
| A15 | Extraction validates independent proposals serially. Source-confirmed latency opportunity, not a measured production bottleneck. | Four-way isolated validation; drain failures before lease release; preserve atomic whole-chunk commit. | Resolved |

## Constraints and non-findings

- Synthetic measurements establish repeated work/scaling, not Bill's actual latency.
- Inside Out, response auditing, extraction, transcript search and training have
  distinct purposes; do not combine their prompts, eligibility, leases or cadence.
- People evidence selection, dossier verification and saved-blurb injection differ.
- Exact historical cutoffs, source coordinates, rewritten-transcript checks,
  answer-key validation and plaintext purging are contracts, not defensive bloat.
- Host owns memory-manager shutdown; no missing plugin shutdown hook was confirmed.
- No universal job/search/AI framework, approximate daily historical indexes,
  or unrequested fleet changes. Both releases authorized after validation.

## Validation record

Audit: 96 focused tests passed; isolated real hook/QMD/worker reproductions,
query plans and tokenizer/projection benchmarks. No paid model calls or live hosts.
Implementation:

- Three independent cross-owner reviews completed. Review caught a partial-update
  invalidation/compaction regression; the real SQLite failure-path test fails without
  the repair and passes with it. Integration also caught normalized BM25 scores;
  discovery now preserves raw negative scores without changing hybrid final ranking.
- Query trimming benchmark: 322 → 60 ms; identical 340 messages / 8,171 tokens.
  Timestamp projection: 544 → 66 ms for 10k messages. Synthetic, not fleet latency.
- Final plugin preflight: all 453 tests passed; knip, build, typecheck,
  cold/runtime plugin inspectors and package dry-run passed.
- QMD focused SDK/query suites: 106 tests passed under each of Node and Bun;
  build, typecheck, lint and knip passed. Full QMD checks: 1,222 tests passed under
  Node (72 skipped) and Bun (81 skipped); package/grammar/CLI smoke checks passed.
- Production dependency audit: zero vulnerabilities.
- Full install audit also reports six dev-only advisories (three high, three
  moderate: brace-expansion, fast-uri, undici, hono, ip-address and openclaw).
  This cleanup changes only the QMD dependency pin; dev-chain upgrades are not
  included or presented as fixed.
- Training does not yet have a large-corpus memory/throughput benchmark. One
  run-scoped source capture plus up to four cutoff-specific indexes is an explicit
  RAM/I/O tradeoff; no cross-run cache or approximate cutoff is introduced.

Release targets: QMD 2.11.0 (GitHub tarball), unblock-memory 0.7.2 (npm).
QMD's tarball is released; a fresh `npm ci --ignore-scripts` loaded its public
discovery/embedding APIs. Plugin preflight passed again against that released
artifact: all 453 tests, inspectors, build/typecheck/knip and package checks.
No live host or paid model validation is claimed.
