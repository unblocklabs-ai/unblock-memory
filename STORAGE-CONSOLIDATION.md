# Durable storage consolidation

## Scope

Use two active SQLite databases per agent: QMD-owned `index.sqlite` and
plugin-owned `unblock-memory.sqlite`. No extracted-memory feature or changes to
agent-owned Markdown. Implementation was validated first; the subsequently
authorized v0.3.20 release and fleet rollout are complete (see below).

## Requirements / acceptance

- [x] Route curation, people and response auditing to the same durable database.
- [x] Keep store modules, agent isolation, configuration and tool contracts intact.
- [x] Preserve every legacy row, ID, cache, receipt, review, lease, due time and
  checkpoint; no inference or reprocessing caused by migration.
- [x] Import existing legacy schemas transactionally, including uncheckpointed WAL
  data; verify row equality/counts and integrity before committing a completion marker.
- [x] Missing legacy databases are normal. Unsupported/corrupt/conflicting schemas
  fail closed. Interrupted imports retry without duplicates or partial visibility.
- [x] Serialize concurrent initialization; short write transactions, WAL,
  foreign keys and private file permissions on every shared-store connection.
- [x] Replace PeopleSQL's database-wide schema version with a component version;
  preserve upgrades from legacy PeopleSQL versions 1–4.
- [x] Keep response judgments/reviews operator-only; no new memory corpus or
  automatic prompt injection. Shared-file existence must not imply audit history.
- [x] Leave QMD and transcript databases untouched. Retain the three old databases
  as inert recovery copies; never dual-write or silently reimport after completion.
- [x] Document stop/start upgrade and rollback limits: old binaries must not keep
  writing old stores after cutover; rollback copies exclude post-cutover changes.
- [x] Focused migration/store/runtime tests, build/typecheck, review and Bill snapshot test.

## Design

One shared connection opener owns SQLite settings and one-time legacy import.
Existing store classes retain their SQL and independent connections. A small
`memory_schema` table tracks component versions and the committed storage migration.
All three legacy files are attached under one write lock during import; only the
new database receives application writes. SQLite may checkpoint legacy WAL data,
changing physical bytes without changing logical records. Tables, explicit indexes, values and foreign keys are
verified before commit. Current QMD migrations remain wholly separate.

Run upgrade with Gateway and plugin CLI writers stopped. Legacy file locks protect
the import itself, not against an old process resuming writes after migration.
First access migrates lazily, including features currently disabled.

## Validation / review — 2026-09-19

- Build, typecheck, Knip and package dry-run pass.
- Final full suite: **316/316 pass**, including legacy-version consolidation
  coverage. Focused final migration/people/
  curation tests: 34/34 pass.
- Static and mocked-runtime plugin inspector: PASS, zero breakages. It still
  reports two coverage gaps: conversation-hook privacy probes and cold import
  with isolated dependency installation. Neither is a demonstrated migration defect.
- Migration tests cover all three populated legacy stores, committed WAL,
  schedules/leases/checkpoints/cached judgments/review decisions, privacy-facing
  table separation, missing stores, versions 1–4, unknown versions/schema objects,
  missing required tables, corruption, broken foreign keys, target conflicts,
  concurrent initialization, uncommitted-process termination and symlinks.
- Reviewed changed source: `memory-database.ts`, `curation.ts`, `people-store.ts`,
  `response-store.ts`, `response-audit.ts`, `response-identity.ts`,
  `response-runtime.ts`, `runtime.ts`; their call sites, modified tests, README and
  generated outputs. QMD remains a separate path; fixed SQL/API boundaries keep
  audit records out of agent memory tools. Standalone manager/test callers can
  still explicitly use isolated stores; plugin runtime always selects the shared file.
- Fixed during implementation/review: first-audit identity reader opening before
  migration; shared-file existence incorrectly implying response history; schema
  initialization races; dangling-symlink acceptance; incomplete legacy PeopleSQL
  schemas reaching the migration completion marker. No outstanding blocking
  finding in the consolidation change.

### Bill snapshot results

Ran the candidate on Bill using Node 24.18.0 and his installed OpenClaw/typebox
dependencies. Online-backup snapshots only; no gateway restart, config change,
live migration, installed plugin replacement, TypeSafe calls or release.

- Final reviewed-code import: **37.3 ms** (initial run: 37.7 ms).
- **13,796 original rows across 11 tables**, all counts and row hashes match:
  26 people, 26 identities, 2 dossiers, 6 dossier revisions, 2 people todos,
  33 maintenance tasks, 12,558 quality judgments, 1,143 primer judgments; the
  other three tables are empty.
- Bill has no `response-audit.sqlite` in this state directory. Missing-history
  handling and new response table/schedule/checkpoint operations pass on his
  snapshot; populated response-history migration is proven by local fixtures,
  not by claiming nonexistent Bill audit history.
- All existing dossiers readable; response-to-person linking and snapshot-only
  people/dossier, curation and response read/write operations pass.
- Integrity and foreign keys pass; repeat opening preserves all rows. Legacy
  snapshots remain byte-identical. Live QMD file hash is unchanged.
- Private remote artifacts:
  `/tmp/unblock-storage-migration.Wyaf3m/snapshot-reviewed/report.json` and
  `/tmp/unblock-storage-migration.Wyaf3m/candidate/validate.mjs`.
- Local evidence: `/tmp/unblock-storage-bill.HZ8UKN/report.json`;
  test logs `/tmp/unblock-consolidation-*.log`.

### Rollout boundary

Implementation, isolated validation, release and live cutover are complete.
Gateways and CLI writers were stopped for cutover; recovery copies were retained.
No extracted-memory feature has been implemented. Existing unrelated dirty
worktree changes were preserved; publication used an isolated release worktree.

### Release and fleet rollout — 2026-09-19

- Published [v0.3.20](https://github.com/unblocklabs-ai/unblock-memory/releases/tag/v0.3.20),
  commit `6e872bef9523473f7fa3fbfc85cbafaa461abe37`; npm latest is 0.3.20.
- Release-only preflight: **299/299 tests**, build, typecheck, Knip and plugin
  inspector passed. GitHub workflow `35485517331` passed clean Linux installation,
  preflight and npm publication. The earlier 316-test result above includes local
  unreleased work, not the isolated release's test surface.
- Bill, Pearl, Vera, Alfie, Theo, Bridger, Ivy, Cherry, Fiona, Fred Flint,
  Fred Farryn and James now run 0.3.20: **12 nodes, 26,223 legacy rows preserved**.
- Every node passed pre-start copy checks, legacy row hash/count comparison,
  consolidated integrity/foreign-key checks, configuration preservation, live
  plugin loading, Gateway RPC health, no degraded plugins and Slack probing.
- Bill additionally passed live `memory_search` (3 hits), `memory_people_inspect`
  (26 people, 2 dossiers), `memory_list_maintenance_tasks`, and a second Gateway
  restart with database validation.
- Sara (`thesis-sara-mika`) is reachable but has no recognized Unblock Memory
  installation/config entry. Left unchanged; a fresh installation is separate scope.
- Some initial reports failed an overly strict physical-file hash assertion after
  successful import. SQLite checkpointing changed file layout, not logical data.
  Final verification checked all legacy row hashes/counts against pre-upgrade
  backups and integrity; all 12 passed. Original reports remain as evidence.
- Recovery directories and legacy databases are retained. They do not contain
  new post-cutover writes and must not be treated as lossless rollback targets.
- QMD stays on published 2.10.0; Cerebras remains stashed and excluded. Extracted
  memories remain a separate future implementation/release.
- Evidence and per-node recovery paths:
  `/tmp/unblock-consolidation-release.5ERB8Y/ROLLOUT.md` and `*-verified.json`.

### Deferred Cerebras experiment

Before release, the optional Cerebras research feature was shelved in the QMD repo
(`/Users/bek/Desktop/unblocked_agents/qmd`), not removed from storage consolidation.
Recoverable stash: `770ee0267f511309d0b14bb446e726e9ee18a4a5`, named
`deferred: Cerebras memory research before storage consolidation release`.
It contains the implementation, tests, SDK/CLI/MCP wiring and feature documentation.
The ordinary TypeSafe-ranked query implementation and unrelated README edits remain.
Four stale compiled research artifacts were moved to
`/tmp/qmd-cerebras-deferred.trVyQc/compiled-research/`; QMD was rebuilt without them.
Source/test stash contents were verified byte-for-byte against the pre-stash backup.

Restore later, then rebuild and revalidate:

```sh
git -C /Users/bek/Desktop/unblocked_agents/qmd stash apply 770ee0267f511309d0b14bb446e726e9ee18a4a5
```

Unblock Memory typecheck and all 316 tests still pass.
QMD build/typecheck pass; targeted tests pass 177/178. The one JSON-versus-SSE MCP
transport expectation failure reproduces on an isolated, unchanged HEAD checkout
with the same dependencies and is unrelated to the shelved feature.
