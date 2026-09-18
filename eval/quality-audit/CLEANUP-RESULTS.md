# Bill: structural ingestion cleanup and fresh Jev audit

Run started 2026-09-17 (America/New_York; artifacts use UTC).

## Changes

- QMD recognizes standalone generated `lcm-memory-backfill` comments as structural
  context, and omits marker-only, rule-only, and whitespace-only semantic chunks.
  Ordinary HTML comments, mixed substantive text, and fenced examples are retained.
  Chunk text remains an exact source slice, with original citation offsets.
- Session projection excludes exact assistant `NO_REPLY` messages and exact user
  queued-message placeholders. Messages with additional content are retained.
- Semantic chunking version is 5; projector version is 4. Version 4 of the chunker
  was briefly tested during this run, then superseded to also exclude whitespace
  tails. The final rebuild replaces all earlier embedding fingerprints.

Changes live in the QMD and unblock-memory repositories. Bill has a development
patch over QMD 2.9.4 and unblock-memory 0.3.13, not a new published release.
His TypeSafe implementation remains the original prose `jev-1.13.0:quality-v1`
policy at `minNoise=0.8`, making this an ingestion comparison rather than a prompt
change. The earlier local JSON-prompt work remains separate and uncommitted.

## Rebuild and reset

- Backed up the installed modules, QMD index, curation database, generated session
  projections, and projection manifest before changing Bill's installation.
- Rebuilt 955 session projections, with zero projection failures or removals.
  Another 758 session windows were skipped by the existing projection policy.
- Rebuilt the semantic vectors. All use fingerprint `8172a5`.
- Verified zero standalone marker/rule-only or whitespace-only indexed chunks.
- Verified the indexed file-document content hashes were unchanged.
- Removed 207 old quality-review tasks and 12,890 cached audit judgments.
  Preserved all five unrelated deferred duplicate tasks. The removed task/cache
  data is recoverable from the on-host SQLite backups.
- Restarted Bill's Gateway and verified health and plugin loading.

The fresh audit runs the installed `auditQualityPage` implementation directly on
Bill, with the configured approved memory, knowledge, and sessions sources and
the same key loader, timeout, policy, threshold, and maintenance-task logic. This
avoids per-page CLI startup overhead. Checkpoints permit retrying interrupted
pages. Any cache hits in this run reflect reuse within the fresh audit, not the
cleared baseline cache. Private text and detailed artifacts remain on Bill.

## Completed audit

| Measure | Before | After |
| --- | ---: | ---: |
| Indexed chunk occurrences scanned | 13,329 | 12,957 |
| Flagged occurrences | 209 | 28 |
| Deduplicated quality-review tasks | 207 | 28 |
| Memory review tasks | 187 | 6 |
| Session review tasks | 20 | 22 |
| Knowledge review tasks | 0 | 0 |

The new inbox has **28 pending review tasks**, approximately **86% fewer** than
the baseline. All 649 pages completed. There were zero stale/oversized skips and
one partial page that was successfully retried from its cursor. The run made
12,558 judgments and reused 396 freshly cached occurrences; within-batch
deduplication accounts for the remaining three occurrences.

All remaining tasks are `possible_ingestion_noise` indicators. Eight previews
concern meeting notifications or transcript content; the other 20 need source
review. None is a standalone backfill marker, separator, or empty chunk.
Session flags increased despite deterministic placeholder removal: new chunk
boundaries and model variation can change other flags. This is not a labeled
precision/recall evaluation, and fewer flags alone do not prove better accuracy.

Bill's Gateway health check passed, `unblock-memory` loaded without plugin
errors, and Slack was running and connected with no reported error.
Live plugin-tool checks also passed: `memory_search` returned two results and
`memory_list_maintenance_tasks` returned ten pending tasks. The generic
`openclaw memory status` CLI reports its core search path disabled on this host;
the plugin-tool checks, not that CLI, verify the active integration.

## Validation and scope

- Unblock-memory full preflight passed: 171 tests, type checking, build, static and
  runtime plugin inspection, and package dry run.
- QMD build/type checking and 292 store/chunking tests passed.
- Following the OpenClaw and TypeSafe skills, source content is preserved and
  model judgments remain review indicators, not automatic repair instructions.
- This is a semantic-vector cleanup, not blanket removal of comments from raw
  documents or full-document lexical search.
- Bill has no wholly empty or marker/rule-only documents. QMD's existing
  completion queries treat a document with no vector rows as needing embedding,
  including intentionally zero-chunk documents. That bookkeeping needs a
  follow-up before a broader release that indexes such documents; it does not
  affect this rebuilt Bill corpus.

Private report directory on Bill:
`/Users/billjohansson/.openclaw/corpus-cleanup-20260917/`.
