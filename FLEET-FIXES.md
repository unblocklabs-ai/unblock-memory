# Fleet fixes

**Checkout reconciliation (2026-09-21):** the original local checkout now includes
released main plus the retained documentation, fleet tooling and People fixes.
Its QMD pin and installed dependency are 2.10.1. References below to the original
dirty checkout's 2.9.6 pin describe the earlier release-time state, not the current checkout.

Reviewed, fixed, released, and verified on **billsmacmini 2026-09-20**. This is the actionable backlog for Bek's controlled fleet, not the full QMD audit. The five recorded fixes were delivered in **Memory 0.3.21 / QMD 2.10.1**. The issue descriptions below record the original defects; the follow-up below supersedes M2 as a remediation requirement.

## Follow-up: query replaces the xsearch prototype

The M2 defect was confined to the leftover Memory prototype. QMD **2.10.0** had already moved its hybrid retrieval/TypeSafe ranking into the existing `query` entry point, with correct lexical chunk selection. Repairing and publishing the duplicate `memory_xsearch` in Memory 0.3.21 was unnecessary; it was not a missing QMD fix.

After validating the published QMD **2.10.1** artifact against the prototype, `memory_xsearch` was removed from both working copies and shipped in **Memory 0.3.22**: implementation, config/schema, registration, documentation, exclusive tests and generated artifacts. `memory_search` remains vector-only. QMD's interface is not a drop-in replacement for the prototype's OpenClaw session filters, response shape or partial-success behavior.

**Released and verified on Bill:** [Memory 0.3.22](https://github.com/unblocklabs-ai/unblock-memory/releases/tag/v0.3.22), commit/main/tag `105e769cf318e1fbc306138b425a2e5daa750241`, npm `latest` 0.3.22, with QMD 2.10.1 unchanged. [Release CI](https://github.com/unblocklabs-ai/unblock-memory/actions/runs/35557388169) passed the fresh install and full 304-test preflight. The actual npm artifact matches the local/CI package shasum.

Bill had no explicit `xsearch` config or stale tool references, so no config edit was necessary. A backed-up, exact-version **0.3.21 → 0.3.22** update and automatic Gateway restart succeeded. Live search/cited reads, removal of the xsearch tool, index readiness, Gateway/RPC and Slack HTTP-200 probe all passed. Config hashes are unchanged, and only unblock-memory changed in the plugin inventory. Bill's installed QMD CLI/MCP query also passed an isolated synthetic-provider fixture. See [0.3.22 release validation](/tmp/unblock-xsearch-release-20260920-6mCTm3/RELEASE-VALIDATION.md).

Before updating any other node, remove an explicitly configured `xsearch` key or `memory_xsearch` tool reference if present; the strict config parser no longer accepts the key. The original dirty checkout still pins QMD 2.9.6 and was not force-synchronized; the released artifact and Bill use 2.10.1. Bill's config and four database backups are retained at `/Users/billjohansson/.openclaw/backups/unblock-memory-20260920-0.3.22`.

Detailed parity, package and post-removal checks: [query validation](/tmp/unblock-query-validation-20260920-8rKT7O/VALIDATION.md). Removed local files are recoverable from [the pre-removal archive](/tmp/unblock-query-validation-20260920-8rKT7O/memory-before-removal.tgz); the release-worktree versions remain in Git at `4ae6355fd3f50c7564a861335544f80021fc29f1`.

**Validation:** paired recall/ranking and published CLI/MCP probes passed with synthetic provider responses; QMD contract suites passed **145 tests each under Node and Bun** (14/16 skips). After removal, full Memory preflight passed **304 tests in the release worktree / 312 in the original checkout**, plus build, typecheck, Knip, static/runtime inspectors and package previews. No stale prototype references remain in either package's 104 files. No new actionable regressions were found. Live model-quality evaluation was not performed; deployment validation subsequently passed as recorded above. Inspector privacy/dependency-install proof gaps remain documented, with fresh-install coverage separately supplied by CI.

## Work list

- [x] **M1 · P2:** close resources after failed manager startup.
- [x] **Q4 · P2:** stop returning old content after a file is blanked; shipped in QMD 2.10.1.
- [x] **Q6 · P2:** persist vector metadata and vector data atomically; shipped in QMD 2.10.1.
- [x] **M2 · Historical prototype-only P2:** repaired in 0.3.21; superseded by removal in 0.3.22 after validating QMD query; verified on Bill.
- [x] **M3 · P3:** retain Slack bot and deactivation flags for directory/people features.

Bill's settings were inspected and preserved: people/primer/Skill Whisperer enabled; xsearch is now absent. M2 and M3 were conditional work, not blanket rollout blockers. Q6 was worth fixing, but its narrow failure window was not a release emergency.

## Original 0.3.21 release and Bill verification (historical)

- **QMD 2.10.1:** [release](https://github.com/unblocklabs-ai/qmd/releases/tag/v2.10.1), commit `063ca7b0f95763d577662f0f5377d8b7308d4dcf`. Delivered through the established GitHub release tarball, not npm.
- **Memory 0.3.21:** [release](https://github.com/unblocklabs-ai/unblock-memory/releases/tag/v0.3.21), commit/main/tag at that release `4ae6355fd3f50c7564a861335544f80021fc29f1`; npm `latest` was 0.3.21 and pinned QMD 2.10.1. The registry artifact matched the locally validated package shasum.
- **Checks:** fresh locked installation, release version check and full preflight passed locally and in [GitHub release CI](https://github.com/unblocklabs-ai/unblock-memory/actions/runs/35554760435): **314 tests passed, zero failures**. This clean release excludes unrelated local fleet-tooling tests. QMD's complete offline suites again passed **1,220 Node / 1,220 Bun** tests, with 72/81 model-backed or runtime-specific skips.
- **WAL blocker resolved:** only `SQLITE_BUSY` while enabling WAL is retried within the existing five-second budget; other errors propagate. The database suite passed 9 tests, and simultaneous first-open coverage passed 10 repeated runs. No generic retry layer or migration was added.
- **Review:** source/callers/tests, release diff, manifest/tool contracts, generated files and package pins were rechecked. No new actionable regressions found in the reviewed/exercised scope. Inspector reports zero compatibility breakages; its existing privacy-boundary capture gap remains a limitation, not a newly demonstrated defect. Fresh-install/CI evidence separately covers its dependency-install proof gap.
- **Bill:** narrow pinned update **0.3.20 → 0.3.21**, automatic managed Gateway restart, runtime plugin loaded with empty diagnostics. OpenClaw remains **2026.9.2**; the before/after plugin inventory differs only for unblock-memory.
- **Live functionality:** Gateway tool calls returned three semantic memory results with citations, read the cited source successfully, and confirmed xsearch stays disabled. Index diagnostics report zero pending embeddings, zero sessions needing projection, and embedding readiness. Slack is connected with a successful HTTP 200 credential probe and no channel error. No chat messages were sent.
- **Installed QMD behavior on Bill:** isolated temporary fixtures passed blank → restore retrieval, failed-vector rollback, pending-work detection, and preservation of the previous vector on failed replacement. No production index rebuild or failure injection was performed.
- **Preservation:** complete configuration and plugin-configuration hashes are unchanged. Permission-restricted config and four SQLite online backups remain at `/Users/billjohansson/.openclaw/backups/unblock-memory-20260920-0.3.21`.
- **Working copies:** releases were prepared in isolated worktrees based on current remote main, preserving the original dirty checkouts and unrelated work. Their old local package pins are not the deployed versions.

Detailed release evidence: [validation report](/tmp/unblock-release-20260920-ialifP/RELEASE-VALIDATION.md). Live xsearch/TypeSafe judging and model-download integration tests were deliberately not exercised.

## Implementation and verification record

**Review result:** no new regressions found in the changed code, its callers, or the exercised tests. Review covered startup ownership and retry/shutdown behavior, QMD's SDK/CLI indexing and embedding retry/cleanup paths, FTS normalization and stored-span boundaries, Slack ingestion and existing person-wide deactivation policy, and compiled/package output. Existing unrelated working-tree changes were preserved.

- **M1:** runtime cleanup and local unassigned-store cleanup implemented. Tests exercise two failed starts followed by a successful retry/shutdown, real watcher closure, failure before store assignment, and preservation of the original error when cleanup also rejects. See [runtime tests](/Users/bek/Desktop/openclaw-plugins/unblock-memory/tests/runtime.test.ts:30) and [manager tests](/Users/bek/Desktop/openclaw-plugins/unblock-memory/tests/manager.test.ts:73).
- **Q4:** both indexers remove successfully blanked paths from `seenPaths`. SDK and CLI tests cover empty/whitespace → restored content, search visibility, and removal counts. The existing unreadable-file test now also verifies that previously indexed content stays active. See [SDK tests](/Users/bek/Desktop/unblocked_agents/qmd/test/sdk.test.ts:66), [CLI tests](/Users/bek/Desktop/unblocked_agents/qmd/test/cli.test.ts:1290), and [store tests](/Users/bek/Desktop/unblocked_agents/qmd/test/store.test.ts:2856).
- **Q6:** metadata and vector upsert share one synchronous SQLite transaction. Native dimension-fault tests verify rollback for new/replacement writes and successful full embedding retry on the next run. Existing lazy-migration tests also pass. See [vector transaction tests](/Users/bek/Desktop/unblocked_agents/qmd/test/store.test.ts:3326) and [embedding retry test](/Users/bek/Desktop/unblocked_agents/qmd/test/store.test.ts:4365).
- **M2 (historical 0.3.21 implementation):** FTS highlights replace exact-token rescoring; whitespace-free offsets map CJK-normalized index text back to complete original spans. Tests cover stemming, diacritics/CJK offset shifts, title-only fallback, missing spans, and existing scope-before-limit behavior. See [published prototype tests](https://github.com/unblocklabs-ai/unblock-memory/blob/4ae6355fd3f50c7564a861335544f80021fc29f1/tests/xsearch.test.ts#L129). These duplicate sources/tests were subsequently removed locally.
- **M3:** optional flags flow through parsing, change detection, and upsert. Tests cover bot/deactivated primer exclusion, missing versus false, flag-only updates, linked-identity person-wide deactivation, and no implicit reactivation. See [Slack tests](/Users/bek/Desktop/openclaw-plugins/unblock-memory/tests/slack-directory.test.ts:86).

### Initial implementation checks (before release delivery)

- New regression assertions were checked against isolated copies of the original source: **five Memory tests and four QMD tests failed for the expected defects**; all pass with the fixes. The unreadable-file preservation check also passes against the original source.
- **Memory:** focused suite **58 passed**; final xsearch suite **8 passed**. Full suite with pinned QMD 2.9.6: **320 passed, one pre-existing failure**. Typecheck, Knip, build, static/runtime plugin inspector, and package dry-run passed. Inspector still lists two proof gaps (conversation-access privacy probes and clean dependency installation), not compatibility breakages.
- **QMD:** full Node suite **1,220 passed / 72 skipped**; full Bun suite **1,220 passed / 81 skipped**. Typecheck, Knip, build, and local tarball packing passed. Model-backed integration cases were skipped; no model downloads or live provider calls were required.
- **Cross-package:** an isolated Memory copy using the actual packed, fixed QMD 2.10.0 artifact passed typecheck and produced the same full-suite result: **320 passed, the same one pre-existing failure**. Artifact-level SDK blank/restore, vector rollback/pending detection, replacement preservation, and CLI `--help` checks passed. This reused installed transitive dependencies; it was not a clean network installation.
- **Diff review:** both repositories pass `git diff --check`. Hash comparison against the start-of-task snapshot shows only the intended source/test changes, corresponding Memory build output, and this status document. Dependency pins/lockfiles are unchanged.

### Initial blockers — now resolved

1. **Pre-existing P2 concurrency defect:** simultaneous first opens could throw `database is locked` while enabling WAL, including against unchanged baseline source under Node 22.23.1. The authorized release follow-up added the narrow busy-only retry and focused test in `src/memory-database.ts` / `tests/memory-database.test.ts`. The release preflight is now fully green.
2. **Dependency delivery:** the original dirty Memory checkout retains its old QMD 2.9.6 pin. The isolated release worktree, npm package and Bill installation use the corrected **QMD 2.10.1** tarball. No local-path dependency was published and no fleet index was rebuilt.

Detailed local logs and the pre-change snapshot are in [verification artifacts](/tmp/unblock-fleet-fixes-20260920-dSlvWY/REVIEW.md). These files are temporary; the substantive results are recorded above.

## M1 — Failed startup abandons a partially initialized manager

**P2 · Immediate · Memory-owned**

**Location:** [src/runtime.ts:290](/Users/bek/Desktop/openclaw-plugins/unblock-memory/src/runtime.ts:290); initialization cleanup in [src/manager.ts:561](/Users/bek/Desktop/openclaw-plugins/unblock-memory/src/manager.ts:561), lines 561–596.

**Problem and impact:** `manager.start()` starts the file watcher before its initial sync. If that sync rejects, the runtime discards the rejected promise without closing the manager. Retrying can accumulate abandoned watchers, background sync work, and store resources in the long-lived host. This is an ordinary startup-failure path, not a hostile-input scenario. Nonpersistent watchers do not necessarily prevent process exit.

**Evidence:** manager startup at lines 466–472 precedes sync; runtime lines 139–141 remove the failed promise; manager `close()` at lines 1242–1254 releases owned resources. The isolated lifecycle probe ran real startup logic with an injected sync failure twice: two managers were created and runtime shutdown closed zero. A separate ownership gap exists before `this.#store` is assigned: the existing local cleanup only covers semantic initialization, not the earlier setup steps.

**Lean fix:** catch startup failure at the runtime owner, await `manager.close()`, then preserve the original startup error even if cleanup also fails. Widen the existing local-store initialization `try`/cleanup to cover all setup after `createStore()` and before assignment. Runtime cleanup alone cannot close an unassigned local store. No lifecycle framework is needed.

**Done when:** focused failure tests cover failure after watcher creation and after store creation, followed by retry and shutdown. Every failed attempt releases its resources once, and the original startup failure remains visible.

## Q4 — Blanked files retain searchable old content

**P2 · Immediate · QMD dependency**

**Location:** [src/store.ts:1811](/Users/bek/Desktop/unblocked_agents/qmd/src/store.ts:1811), lines 1811–1814; duplicate CLI branch at [src/cli/qmd.ts:1983](/Users/bek/Desktop/unblocked_agents/qmd/src/cli/qmd.ts:1983), lines 1983–1986.

**Problem and impact:** an indexed file is successfully read as empty or whitespace, but the indexer skips it after marking its path as seen. The old document stays active and searchable. This affects Memory's ordinary SDK sync: clearing a note does not reliably clear its search result. Missing files already follow a different path; transient read failures intentionally preserve prior content.

**Evidence:** `seenPaths.add(path)` at store line 1794, the empty-content skip, and the deactivation pass at lines 1849–1859 establish the failure. Memory consumes this update path at manager lines 645–668. The completed audit reproduced index → blank → update → old phrase still searchable in both installed QMD 2.9.6 and checkout 2.10.0.

**Lean fix:** remove a successfully empty file's path from `seenPaths` before continuing. Reuse the existing deactivation, removal-count, and cleanup pass. Make the same small correction in the duplicate CLI branch; do not extract the entire indexer or change unreadable-file handling.

**Done when:** a focused nonempty → whitespace → nonempty test verifies retrieval and removal counts through SDK and CLI. A read-error case still preserves prior indexed state. The guarantee is current index visibility and normal cleanup, not erasure of every historical copy or backup.

## Q6 — Failed vector writes can look complete

**P2 · Reliability backlog · QMD dependency**

**Location:** [src/store.ts:4697](/Users/bek/Desktop/unblocked_agents/qmd/src/store.ts:4697), lines 4697–4704; incomplete-embedding cleanup at lines 4715–4717.

**Problem and impact:** metadata replacement and vector deletion/insertion are separate writes. If a later vector write fails or execution stops between statements, metadata can exist without its vector. Completion checks then skip the affected hash on future embedding runs. Vector retrieval becomes missing or partial; lexical document content remains available.

**Likelihood:** this needs a write failure or interruption in a narrow window. The reproduction deliberately injected a later dimension fault; ordinary initial model/table dimension mismatches are caught earlier. It is not evidence that approved fixed models normally emit inconsistent dimensions.

**Evidence:** the full `generateEmbeddings` probe exercised retries and cleanup in both QMD versions. First run: one error; persisted state: metadata=1, vectors=0, pending=0. The next run processed zero documents and reported zero errors, leaving the missing vector unrepaired.

**Lean fix:** use one synchronous SQLite transaction around metadata replacement plus vector delete/insert, following the existing transaction pattern. No new retry service, scheduler, or recovery framework.

**Done when:** an insertion failure rolls back the metadata/vector pair; a failed replacement preserves the previous pair, while a failed first insertion leaves the hash pending. A subsequent embedding run succeeds. The fix prevents new inconsistencies; inspect and repair affected hashes only if existing damage is demonstrated. Do not require a blanket fleet index rebuild.

## M2 — Historical prototype lexical retrieval defect (superseded)

**Historical P2 · Only when xsearch is enabled · Memory-owned · No remaining implementation requirement**

**Historical location:** `src/xsearch-bm25.ts:32–36`; manager caller at line 1111 in the audited snapshot. The duplicate files no longer exist locally. QMD query already performed correct lexical selection; the following records the original prototype-only defect and its now-superseded repair.

**Problem and impact:** FTS uses stemming/normalization, while chunk selection counts exact query tokens. A document can match FTS but score zero in every stored chunk, causing the earliest unrelated chunk to be sent to the xsearch judge. That can lose or misrepresent a useful lexical candidate. Ordinary vector `memory_search` is unaffected, and xsearch's vector branch may independently recover the result. Xsearch is disabled by default.

**Evidence:** the isolated probe queried `running`; FTS matched a later chunk containing `runs`, but the adapter selected an unrelated oranges introduction. The index uses `porter unicode61`, unlike the adapter's exact-token comparison.

**Lean fix:** obtain FTS body highlights in the existing query and select an existing stored span by overlap with actual matches. Map normalized offsets back to the original source before selecting the span. The inspected QMD 2.10 [src/query.ts:15](/Users/bek/Desktop/unblocked_agents/qmd/src/query.ts:15), lines 15–40 and 117–146, provides a reference for a small local helper; do not add a separate stemmer or require a QMD-wide upgrade just for this fix. Preserve the existing no-stored-span behavior.

**Done when:** a later stemmed match beats an unrelated intro; a normalization case and title-only fallback behave correctly; returned evidence remains an exact, complete stored source span.

## M3 — Slack directory ingestion discards bot/deactivation flags

**P3 · When directory/people features are used · Memory-owned**

**Location:** [src/slack-directory.ts:45](/Users/bek/Desktop/openclaw-plugins/unblock-memory/src/slack-directory.ts:45), mapping at lines 45–57 and change detection/upsert at lines 138–150.

**Problem and impact:** Slack's `is_bot` and `deleted` values are dropped before storage, even though the people store supports both. Newly ingested bots and deactivated identities can appear unknown-bot/active and remain eligible for the human-background primer. This is incorrect directory state and unnecessary or inappropriate primer work, not a demonstrated corpus/provider authorization bypass.

**Evidence:** the directory → real people store → primer probe supplied true bot/deactivation flags but stored `isBot: null` and `isDeactivated: false`; the primer performed three searches instead of excluding the identity. Its gate is at [src/people-primer.ts:44](/Users/bek/Desktop/openclaw-plugins/unblock-memory/src/people-primer.ts:44).

**Lean fix:** propagate optional booleans through entry typing, mapping, change detection, and upsert, preserving absent versus explicit false. Keep the existing skip for unavailable/soft-deleted people. Do not automatically reactivate people or re-enable injection.

**Important existing behavior:** forwarding `deleted=true` invokes [src/people-store.ts:472](/Users/bek/Desktop/openclaw-plugins/unblock-memory/src/people-store.ts:472), which marks the entire person unavailable and disables injection, including when other identities are linked. Preserve and test that contract rather than silently redesigning identity policy. Reactivation remains an explicit `restore_person` action followed by ordinary sync.

**Done when:** bot and deactivated-user ingestion each prevent primer searches; false/missing values are mapped correctly; linked-identity behavior is covered; unavailable/soft-deleted people remain untouched as required by [tests/slack-directory.test.ts:81](/Users/bek/Desktop/openclaw-plugins/unblock-memory/tests/slack-directory.test.ts:81), lines 81–122.

## Scope and delivery notes

- **Audited snapshot:** Memory 0.3.18 at `f3ebd383f7cd1a169d214950afd6367cfb479d4e`, including pre-existing working-tree changes; QMD checkout 2.10.0 at `9e19f2c8a13d70027ad35f89424ebf9cc3d5800d`. Line references describe this snapshot and may move.
- **Dependency delivery:** the audited local snapshot pins QMD **2.9.6** in [package.json:38](/Users/bek/Desktop/openclaw-plugins/unblock-memory/package.json:38), where Q4/Q6 also reproduce. The subsequently authorized release ships corrected QMD 2.10.1 through Memory 0.3.21 and has been verified on Bill. The original dirty checkout was not force-synchronized to the release worktree.
- **Evidence provenance:** these are source/call-site checks and completed isolated audit probes, not live-node failure rates or production inference tests. Detailed evidence remains in the temporary [revalidated report](/tmp/unblock-review-20260920-KwCjfA/REVALIDATED.md). The trigger, impact, and expected correction are recorded here so this backlog does not depend on retaining that temporary directory.
- **Excluded:** the broader standalone CLI/MCP, unused SDK-mutator, benchmark, training, and experimental-tooling findings are not fleet remediation tasks. Q9's non-destructive model validation is optional cheap hardening, not a sixth required issue. Revisit CLI trust findings if agents run QMD inside untrusted third-party checkouts: a controlled host does not make repository configuration trusted.
- **Keep changes lean:** focused tests for these behaviors, no broad refactor, generic lifecycle/recovery framework, new ACL system, or speculative test matrix.
