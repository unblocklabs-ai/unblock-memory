# Code Simplifier Audit — `@unblocklabs/unblock-memory`

> **Post-Batch 2 Re-Audit (2026-11-24 · GPT-6.2 `--effort high` source verification of all 82 findings at `HEAD` `def90e4`):**
> - **Current Scoreboard (82 historical findings — 19 High / 42 Medium / 21 Low; current scope: 105 impl files / 21,989 LOC):**
>   - **CLOSED (33):**
>     - *High (13/19):* **#4** (`memory-whisperer.ts`), **#5** (`typesafe-review.ts`), **#6** (`people-background.ts` + callers), **#7** (`people-learning-inventory.ts`), **#9** & **#10** (`people-learning-runtime.ts`), **#11** (`inside-out.ts`), **#12** (`emotion-baselines.ts`), **#13** (`session-sync.ts`), **#14** (`extraction-worker.ts`), **#15** (`response-store.ts` `report()`), **#18** (`training-retrieval.ts`), **#19** (`prepare-query-training.py`).
>     - *Medium (14/42):* **#26** (`runtime.ts`), **#28** (`typesafe.ts`/`typesafe-review.ts`), **#29** (`memory-whisperer.ts` `abortable`), **#30** (`whisperer-context.ts` `takeRecentWithinTokens`), **#31** (`safety-whisperer.ts`), **#32** (`my-turn.ts`), **#39** & **#41** (`people-store.ts`), **#44** (`people-learning-store.ts`), **#48** (`extraction-source.ts`), **#52** (`inside-out-store.ts`), **#56** (`training*.ts`), **#57** (`response-audit.ts`/`response-stages.ts`), **#58** (`response-episodes.ts`).
>     - *Low (6/21):* **#65** (`skill-whisperer.ts`), **#71** (`people-hooks.ts`), **#72** (`people-learning-cron.ts`), **#73** (`people-store.ts`), **#79** (`response-store.ts`), **#80** (`training-store.ts`).
>   - **PARTIALLY CLOSED (7):**
>     - *High (4):* **#1** (`config.ts` decision delegation done; hand-rolled field guards remain), **#8** (`people-primer.ts` 6 invariants hoisted; `Candidate` wrapper & `.includes()` remain), **#16** (`response-judge.ts` static schemas/fresh path done; cached sentiment still validated twice), **#17** (`training-queries.ts` phase helpers done; scope-matching overlap remains).
>     - *Medium (3):* **#42** (`people-dossier-review.ts` `agentName` hoisted; setup overlap with `people-primer-tool.ts` remains), **#43** (`people-tools.ts` dispatch/helpers done; pagination schema bounds repeated), **#45** (`inside-out-runtime.ts` timer cleanup/abort guards fixed; 3 interval runners not yet unified).
>   - **OPEN — WORTH DOING (18):**
>     - *High (1):* **#3** (`manager.ts` `#renderSearchHits` double URI parse & interleaved session/passage logic).
>     - *Medium (15):* **#21** (`memory-database.ts`), **#22** (`manager.ts` RRF fusion), **#23** (`manager.ts` double `getStatus()` at startup), **#24** (`manager.ts` `#currentExtracted` Map/Set round-trip), **#27** (`manager.ts` quadratic `buildReadResult` shrink loop), **#35** (`analysis.ts` redundant noise count), **#36** (`quality-audit.ts`), **#38** & **#40** (`people-store.ts`), **#47** (`session-projector.ts`/`session-noise.ts` shared fence state), **#49** (3 session metadata SQL joins), **#50** (`inside-out.ts` repeated timestamp parsing), **#53** (`session-sync.ts` duplicate schema checks), **#55** (`training*.ts` worker pool), **#59** (`response-text.ts` `matchAll` allocation).
>     - *Low (2):* **#74** (`session-sync.ts` up to 50k unneeded row clones for unread `sessionId`), **#81** (`response-runtime.ts` validate `--bucket` before opening SQLite).
>   - **OPEN — LOW-ROI / DEFERRED (24):** High **#2** (`plugin.ts` wrappers); Medium **#20**, **#25**, **#33**, **#34**, **#37**, **#46**, **#51**, **#54**, **#60**, **#61**; Low **#62–#64**, **#66–#70**, **#75–#78**, **#82** *(note: `#67` `src/mlx-query-worker.py` has no in-repo caller but is intentionally shipped in `package.json` & documented in `docs/retrieval.md` for standalone use)*.
> - **Cross-Cutting Themes Status:** Theme 1 (monolithic orchestrators) is **mostly resolved (9/10 split)**; Themes 2 & 3 are **partially resolved**; Theme 4 (duplicated domain rules) is **2/4 resolved** (People interaction rules & whisperer token trimming shared; SQL joins & fence scanners remain). Top remaining quick wins: **#23**, **#27**, **#35**, **#74**, **#81**.

## Summary

- **Mode:** `--audit` (read-only; **zero** repository files edited)
- **Scope scanned:** Entire production codebase — **105 source files (~17,504 LOC)** across [index.ts](../../index.ts), `src/` (95 files: `.ts` + `.py`), and `scripts/` (9 files: `.mjs` + `.py`).
- **Exclusions:** `dist/`, `node_modules/`, `.git/`, `tests/` (test suite inspected for invariants only), `eval/` offline benchmarks, lockfiles, tokenizer binary/JSON assets (`src/query-tokenizer/`), and `.gitignore`d paths (`reports/`).
- **Conventions respected:** TypeScript `ES2023` + `NodeNext` + `strict: true`, Node 22+ built-in `node:sqlite`, TypeBox runtime validation, `knip` zero-dead-export enforcement, compact functional-modular style, worker-thread `openclaw`-free isolation in [inside-out-store.ts](../../src/inside-out-store.ts), standalone SSH-streamed isolation in [typesafe-fleet-remote.mjs](../../scripts/typesafe-fleet-remote.mjs), and strict error-sanitization / TOCTOU security invariants.
- **Finding counts:** **19 High** · **42 Medium** · **21 Low** (**82 total**; **78 `Safe`**, **4 `Needs Review`**). *(33 small/focused files had no worthwhile findings.)*

### Biggest Cross-Cutting Simplification Themes

1. **Monolithic multi-phase orchestrators (105–186 lines, 4–6 nesting levels):** Core entrypoints across every subsystem ([response-store.ts](../../src/response-store.ts), [training-queries.ts](../../src/training-queries.ts), [memory-whisperer.ts](../../src/memory-whisperer.ts), [people-learning-inventory.ts](../../src/people-learning-inventory.ts), [people-learning-runtime.ts](../../src/people-learning-runtime.ts), [session-sync.ts](../../src/session-sync.ts), [inside-out.ts](../../src/inside-out.ts), [emotion-baselines.ts](../../src/emotion-baselines.ts), [training-retrieval.ts](../../src/training-retrieval.ts), [prepare-query-training.py](../../scripts/prepare-query-training.py)) fuse DB reads, async I/O, ranking/validation math, and write-back inside deeply nested functions with shared mutable closure state.
2. **Repeated boilerplate despite existing repo primitives:** [config.ts](../../src/config.ts) hand-rolls 13 plain-object/allowlist checks and 8 boolean/range checks without using `isRecord`/`nonBlank` from [guards.ts](../../src/guards.ts); [plugin.ts](../../src/plugin.ts) and [review-tools.ts](../../src/review-tools.ts) repeat identical tool registration wrappers; [training.ts](../../src/training.ts) and [training-queries.ts](../../src/training-queries.ts) duplicate worker pools and HTTP error classification; [inside-out-runtime.ts](../../src/inside-out-runtime.ts) and [extraction-runtime.ts](../../src/extraction-runtime.ts) duplicate non-overlapping interval runners (with minor cleanup drift).
3. **Loop-invariant rebuilding & avoidable O(N²) / duplicate work:** Multiple hot paths rebuild static decision-model prompts and TypeBox schemas inside functions or per-item loops ([response-judge.ts](../../src/response-judge.ts), [people-primer.ts](../../src/people-primer.ts), [typesafe-review.ts](../../src/typesafe-review.ts), [typesafe.ts](../../src/typesafe.ts), [my-turn.ts](../../src/my-turn.ts)), query SQLite redundantly ([people-learning-inventory.ts](../../src/people-learning-inventory.ts), [people-learning-runtime.ts](../../src/people-learning-runtime.ts), [inside-out-store.ts](../../src/inside-out-store.ts), [analysis.ts](../../src/analysis.ts)), or re-validate/re-parse identical payloads multiple times ([response-judge.ts](../../src/response-judge.ts), [extraction-source.ts](../../src/extraction-source.ts), [people-background.ts](../../src/people-background.ts)).
4. **Duplicated domain rules across parallel modules:** Interaction-claim TTL/scope rules appear in 4 People files; OpenClaw `session_windows` + `conversations` SQL joins appear in 3 session-reading modules; CommonMark fence state machines appear in 2 session modules; reverse token-budgeted history trimming appears 3 times across whisperers.

---

## High Priority Findings (19)

### Core, Config, Plugin & Manager

1. **[config.ts](../../src/config.ts#L115-L535)** — `[High | duplication | Safe]`
   - **Issue:** Repeats hand-rolled plain-object + `assertOnlyKeys` validation **13 times**, boolean default/type checks **8 times**, `[0, 1]` unit-interval checks **3 times**, bounded integer checks **4 times**, non-skill corpus list checks **2–3 times**, and path-list trimming **2 times** — without reusing `isRecord`/`nonBlank` from [guards.ts](../../src/guards.ts). `resolveTypeSafe` (`L156-L168`) also validates `model`/`apiKey`/`apiKeyFile` in a loop and then re-checks `typeof ... === "string"` and `.trim()`s each again.
   - **Simplification:** Import `isRecord`/`nonBlank` from `./guards.js` and add local helpers (`expectObject`, `booleanField`, `unitNumber`, `integerInRange`, `resolveNonSkillCorpora`, `resolvePathList`, `optionalNonBlank`), preserving exact error messages.

2. **[plugin.ts](../../src/plugin.ts#L97-L479)** & **[plugin.ts](../../src/plugin.ts#L603-L622)** — `[High | duplication | Safe]`
   - **Issue:** All 10 tool factories repeat `getContext(ctx)` gating, `Value.Parse(schema, params)`, and tool descriptor boilerplate; 6 of them also repeat `runtime.getMemorySearchManager(active)` -> `managerUnavailable(error)` -> `jsonResult(...)` (`createReclusterTool` `L290-L293` even re-inlines `managerUnavailable`'s object shape). `registerUnblockMemory` (`L603-L622`) repeats every tool name a second time in `{ names: [...] }`.
   - **Simplification:** Extract local `registerAgentTool` and `registerManagerTool` helpers so each tool declares only `{ name, label, description, parameters, execute }`, keeping `memory_search`'s compact serialization and fallback shape strictly unchanged.

3. **[manager.ts](../../src/manager.ts#L1081-L1146)** — `[High | control-flow | Safe]`
   - **Issue:** `#renderSearchHits` packs 66 lines of URI parsing, extracted-record lookup, session verification, passage selection/expansion, and formatting into one loop with two nested ternaries (`L1109-L1113`, `L1117-L1126`), and parses `hit.file` twice (`L1093` regex + `L1101-L1103` `startsWith`/slice).
   - **Simplification:** Capture `[collection, relativePath]` in one `/^qmd:\/\/([^/]+)\/(.+)$/` match and extract `#sessionHitContext` and `#selectHitPassage`.

### Decision Client & Whisperers

4. **[memory-whisperer.ts](../../src/memory-whisperer.ts#L47-L228)** — `[High | control-flow | Safe]`
   - **Issue:** `beforePrompt` is 182 lines with an inline 105-line `run` closure (`L86-L191`) and async IIFE (`L193-L226`) mutating 10 loose closure `let` variables across normal flow, callbacks (`onCandidates`, `onJudgment`), `catch`, and `finally`.
   - **Simplification:** Group per-turn telemetry into one local state object and extract `generateQueriesWithFallback`, `selectComplementaryHints`, and `renderBoundedHints` (`L169-L181`).

5. **[typesafe-review.ts](../../src/typesafe-review.ts#L21-L79)** — `[High | control-flow | Safe]`
   - **Issue:** `reviewTypeSafeClaim` multiplexes three modes (`claim`, `personBackground` factual intro, and `personBackground` interaction preference/lesson) via 7 interleaved inline ternaries (including a nested ternary at `L37` and 300–450 char lines) and rebuilds its TypeBox `schema` on every call (`L68-L71`).
   - **Simplification:** Hoist `backgroundAnswersSchema` to module scope and replace the interleaved ternaries with an explicit mode dispatch (`"interaction" | "background" | "claim"`) backed by static question tables.

### People Subsystem

6. **[people-background.ts](../../src/people-background.ts#L10-L20)** (with [people-store.ts](../../src/people-store.ts#L1047-L1061), [people-dossier-review.ts](../../src/people-dossier-review.ts#L28-L32), [people-learning-inventory.ts](../../src/people-learning-inventory.ts#L213-L216)) — `[High | duplication | Safe]`
   - **Issue:** Interaction-claim rules (`["preferences", "workingStyle"]`, 30-day `agent_assessment` TTL, `scope`, `reviewedAt`/`expiresAt` validation) are duplicated across 4 files. `renderPeopleDossier` parses `Date.parse(claim.reviewedAt)` up to 3× and `Date.parse(claim.expiresAt)` up to 2× per claim in a single 7-line chain, and has a dead falsy ternary `claim.scope ? ... : ""` at `L17` after requiring `claim.scope` at `L13`.
   - **Simplification:** Export `INTERACTION_DOSSIER_CATEGORIES`, `AGENT_LESSON_MAX_TTL_MS`, and `isInteractionCategory` from `people-background.ts`, and extract `isRenderableInteractionClaim(claim, now)` parsing each timestamp once.

7. **[people-learning-inventory.ts](../../src/people-learning-inventory.ts#L52-L226)** — `[High | control-flow | Safe]`
   - **Issue:** `inventoryPeople` is 174 lines (up to 6 levels nested), queries `people.listIdentities(...)` with the exact same filter **twice per person** (`L70` for `manifest.roster`, then `L79-L81` for `byIdentity`), repeats `&& currentPerson` checks at `L169`/`L189`/`L192` after `L152` guarantees `currentPerson` is truthy, and maps `message.content.map(record)` twice (`L193-L195`).
   - **Simplification:** Populate `byIdentity` in the same loop as `manifest.roster`, drop redundant `&& currentPerson` checks, and split into `loadRosterAndDossiers`, `inventorySessionTranscript`, and `collectManifestAssertions`.

8. **[people-primer.ts](../../src/people-primer.ts#L23)** & **[people-primer.ts](../../src/people-primer.ts#L78-L182)** — `[High | control-flow | Safe]`
   - **Issue:** Rebuilds 6 loop-invariant values (`trust`, `questions`, `model`, `scope`, `expectedKeys`, `valid`) on every candidate inside `worker`'s `while` loop (`L92-L122`); evaluates `eligibility(g)` twice and scans `!selected.includes(g)` ($O(n^2)$) at `L173-L175`; wraps hits in a pointless single-field `type Candidate = { hit: CorpusMemorySearchResult }` (`L23`).
   - **Simplification:** Hoist all 6 invariants out of `worker`, replace the double-filter + `.includes()` with one partition loop computing `eligibility(g)` once, drop `Candidate`, and split `primePersonDossier` into `collectCandidates`, `buildPrimerQuestions`, and `rankEvidence`.

9. **[people-learning-runtime.ts](../../src/people-learning-runtime.ts#L91-L118)** — `[High | control-flow | Safe]`
   - **Issue:** `saveErrors` does repeated $O(N^2)$ work inside `for (const assertion of manifest.assertions)`: linearly scans `receipt.assertionReviews.find(...)` (`L98`), re-reads `people.getDossier` from SQLite (`L100`), re-runs `dossierAssertions` (JSON + `Intl.Segmenter` + SHA-256 over the whole dossier, `L101`), and re-queries `people.getDossierRevision` (`L108`) on *every* assertion; `L111-L116` then re-fetches dossiers and does a nested `.some` against `manifest.assertions`.
   - **Simplification:** Index `reviewsById = new Map(...)`, `manifestAssertionIds = new Set(...)`, and cache current assertions + revision per `personId` in a local `Map`.

10. **[people-learning-runtime.ts](../../src/people-learning-runtime.ts#L10-L11)**, **[L40-L89](../../src/people-learning-runtime.ts#L40-L89)** & **[L137-L375](../../src/people-learning-runtime.ts#L137-L375)** — `[High | duplication | Safe]`
    - **Issue:** `registerPeopleLearning` spans 215 lines with an 83-line inline `execute` handler, duplicate `./people-store.js` imports (`L10-L11`), 5 separate `new PeopleLearningStore(...) / try / finally { close() }` blocks, and 2–4 copies each of config resolution, `isLearningEnabled`, response-audit approval, and `responseCohort(...)` computation. `beginReview` (`L53-L83`) also recomputes `canonical(paths.workspace)` inside `.filter(...)` on every agent ID (`L61`).
    - **Simplification:** Merge the duplicate import, introduce `withLearningStore(storePath, agentId, fn)`, extract small local predicates (`isLearningEnabled`, `auditCohort`, `resolvePluginConfig`), and split `importLegacyBacklog`, `handleSignalsAction`, and `handleCheckpointAction`.

### Sessions, Extraction & Inside Out

11. **[inside-out.ts](../../src/inside-out.ts#L156-L270)** — `[High | control-flow | Safe]`
    - **Issue:** `runInsideOut` is 115 lines (5 nesting levels) driven by a labeled `processing: for (const retrying of [false, true])` loop with 6 `retrying` conditionals (`L187`, `L199`, `L203`, `L211`, `L214`, `L254`), duplicated budget exit checks (`L221`, `L256`), a 25-line inline inference/validation block (`L222-L246`), and redundant `model = config.typesafe.model` assignment at both `L222` and `L241`.
    - **Simplification:** Extract `gradeInteraction`, `loadRetryTargets`, and `reviewSource`, invoked as two flat sequential passes (discovery, then retry if budget remains), removing the labeled break and all 6 `retrying` branches.

12. **[emotion-baselines.ts](../../src/emotion-baselines.ts#L183-L302)** — `[High | control-flow | Safe]`
    - **Issue:** `refreshEmotionBaselines` is 120 lines (5 nesting levels) combining an inline `assess` closure, population refresh (redeclaring `function* rows()` inside the `for (const group of groups)` loop at `L229-L238`), orphaned population deletion, and non-comparable grade assessment.
    - **Simplification:** Extract flat module-private helpers (`createGradeAssessor`, `iterateComparableGrades`, `refreshPopulation`, `assessNonComparableGrades`), turning `refreshEmotionBaselines` into a ~25-line orchestrator with identical batch/transaction boundaries.

13. **[session-sync.ts](../../src/session-sync.ts#L319-L456)** — `[High | control-flow | Safe]`
    - **Issue:** `syncSessionProjections` (138 lines) repeats the failure handler 3 times (`L343-L347`, `L354-L358`, `L371-L375`), recomputes `projectionKey(params)` 3 times (`L328`, `L422`, `L435`), recomputes `JSON.stringify(window)` across `readSnapshot` (`L213`) and 3 branches (`L350`, `L377`, `L407`), and hides a concurrency-sensitive manifest certification invariant inside a 3-level nested ternary (`L437-L438`).
    - **Simplification:** Compute `currentProjectionKey` once and `sourceFingerprint` once per window; extract `syncWindow` and a clear `if`/`else` `resolveIndexSignature` helper preserving the 3 distinct `sessionIndexSignature` timing points.

14. **[extraction-worker.ts](../../src/extraction-worker.ts#L8-L114)** — `[High | control-flow | Safe]`
    - **Issue:** `runExtraction` (107 lines, 5 nesting levels) duplicates `reset`/`missing` handling before and after inference (`L54-L56` and `L95-L97`), runs `existing.find(...)` even for rejected proposals (`L87`), and linearly scans `messages.find(...)` twice per evidence item (`L86`, `L89`).
    - **Simplification:** Extract `processSession` and `validateProposals`, index `messageById = new Map(...)` once per chunk, add an early `if (!judgment.accepted) { rejectedCount++; continue; }` guard, and share a `handleResetOrMissing` helper.

### Response Audit, Training & Scripts

15. **[response-store.ts](../../src/response-store.ts#L190-L370)** — `[High | control-flow | Safe]`
    - **Issue:** `ResponseAuditStore.report()` is 181 lines handling SQL filtering, 33-field accumulator setup (duplicated between `new Map` type annotation `L203-L211` and fallback object `L222-L229`), summary/Wilson derivation, and trends (`L317-L347`) with 7 chained/nested ternaries, redundant condition checks (`L330-L331` re-checking `scoreDimension`, `L336` re-checking `taskType`/`agentModel` already folded into `enough`), and $O(G^2 \log G)$ `summaries.filter(...).sort(...)` per group.
    - **Simplification:** Extract `createReportGroup`, `summarizeGroup`, and `computeTrends` driven by a declarative `TREND_DIMENSIONS` descriptor table, grouping summaries by stratum once to find previous periods in linear time.

16. **[response-judge.ts](../../src/response-judge.ts#L91-L174)** & **[L200-L261](../../src/response-judge.ts#L200-L261)** — `[High | control-flow | Safe]`
    - **Issue:** Validates sentiment output **three times** (`L163` `Value.Check`, `L168` `Value.Parse`, `L169` `Value.Check`), rebuilds static prompt objects on every call (then post-hoc filters `feedbackQuestions` via `Object.entries().filter()` at `L156-L157`), and repeats the inline `params` type 4 times across `response-judge.ts` and `response-stages.ts`.
    - **Simplification:** Hoist `QUALITY_QUESTIONS`, `FEEDBACK_QUESTIONS`, `SENTIMENT_QUESTIONS`, `RETROSPECTIVE_QUESTIONS`, `MEMORY_QUESTIONS`, `memoryOpportunitySchema`, and `ResponseJudgeParams` to module scope; assemble feedback questions via direct object spread; collapse `L162-L172` into a single `if (sentimentEnabled)` validation block.

17. **[training-queries.ts](../../src/training-queries.ts#L166-L351)** — `[High | control-flow | Needs Review]`
    - **Issue:** `evaluateTrainingQueries()` is 186 lines (6 nesting levels) with a 144-line `evaluate` closure containing nested `judge`, `scoreQueries`, and memoized `revisions` closures mutating shared outer state; `L197-L207` also duplicates scope/legacy review filtering from `reviewBlocksJudge` (`L154-L159`).
    - **Simplification:** Pass a cohesive internal run-context object to module-level helpers (`blockedStepsForExample`, `judgePassageOnce`, `scoreLaneQueries`, `reviseLaneOnce`, `evaluateExample`), preserving the post-`await` `maxExamples` concurrency guard at `L246`.

18. **[training-retrieval.ts](../../src/training-retrieval.ts#L54-L197)** — `[High | control-flow | Safe]`
    - **Issue:** `historicalTrainingSource()` is 144 lines across 3 nested async scopes and copy-pastes the cooperative yield check (`if (performance.now() >= yieldAt) { await yieldToEventLoop(); ... }`) **6 times** (`L88`, `L100`, `L118`, `L132`, `L162`, `L168`).
    - **Simplification:** Extract `createYielder(budgetMs = 25)` and split into `captureSourceSessions`, `selectCutoffDocuments`, and `materializeQmdStore`.

19. **[prepare-query-training.py](../../scripts/prepare-query-training.py#L18-L33)** & **[L101-L236](../../scripts/prepare-query-training.py#L101-L236)** — `[High | control-flow | Safe]`
    - **Issue:** `prepare()` is 136 lines combining 5 phases, repeats the 3-lookup `row.get(...)` non-empty string pattern 4 times (`L123`, `L124`, `L160`, `L163`), duplicates JSONL writing 3 times (`L199-L224`), and recompiles `SECRET_PATTERNS` on every `secret_reasons()` call (`L31-L33`).
    - **Simplification:** Pre-compile `SECRET_PATTERNS` with `re.compile`, add `optional_nonempty_str` and `write_jsonl`, and split `prepare()` into `_load_cohort`, `_assign_splits`, `_load_targets`, and `_write_outputs`.

---

## Medium Priority Findings (42)

### Core, Config, Plugin & Manager
20. **[config.ts](../../src/config.ts#L435-L544)** — `[Medium | control-flow | Safe]`: `resolveConfig` inlines `evidenceReview` (validating via `try/catch` around sibling `resolveQualityAudit`), `analysis`, and `skillWhisperer`; extract uniform `resolveEvidenceReview`, `resolveAnalysis`, and `resolveSkillWhisperer`.
21. **[memory-database.ts](../../src/memory-database.ts#L72-L144)** — `[Medium | control-flow | Safe]`: `consolidate` nests 6 levels deep and duplicates `PRAGMA ...integrity_check` (`L102-L103`, `L134-L135`); extract `assertIntegrity` and `migrateLegacySource`.
22. **[manager.ts](../../src/manager.ts#L1018-L1079)** — `[Medium | control-flow | Safe]`: `searchCandidates` mixes async QMD lane orchestration/timing with inline RRF fusion math; extract pure `fuseCandidateLanes` helpers.
23. **[manager.ts](../../src/manager.ts#L525-L540)** & **[L232-L252](../../src/manager.ts#L232-L252)** — `[Medium | duplication | Safe]`: `#getStore` calls `store.getStatus()` twice on startup (once directly, once via `pruneStaleCollections`) and prepares SQL even when `staleCollections` is empty; split `findStaleCollections`/`deleteStaleCollections` and short-circuit on empty.
24. **[manager.ts](../../src/manager.ts#L302-L332)** & **[L580-L589](../../src/manager.ts#L580-L589)** — `[Medium | indirection | Safe]`: `#currentExtracted` builds a temporary `Map` -> `sessionAllowedPaths` -> `Set` round-trip to filter records; extract `compileSessionFilter(filter)` and filter directly.
25. **[plugin.ts](../../src/plugin.ts#L106-L182)** — `[Medium | control-flow | Safe]`: `createSearchTool` `execute` is 77 lines; extract pure `recordSearchOutcome` and `formatSearchPayload`.
26. **[runtime.ts](../../src/runtime.ts#L157-L228)** — `[Medium | control-flow | Safe]`: `startSessionSync` embeds a 42-line background async IIFE with nested `try/catch/finally`; extract `#runSessionSync`.
27. **[manager.ts](../../src/manager.ts#L254-L289)** — `[Medium | idiom | Safe]`: `buildReadResult` shrinks to `MAX_READ_CHARS` via an $O(n^2)$ backward `while` loop calling `.slice().join("\n")` per line; replace with a single forward length scan and one `.join("\n")`.

### Decision Client, Whisperers, Analysis & Review Tools
28. **[typesafe.ts](../../src/typesafe.ts#L72)**, **[L92-L134](../../src/typesafe.ts#L92-L134)** & **[typesafe-review.ts](../../src/typesafe-review.ts#L86-L153)** — `[Medium | duplication | Safe]`: Static `questions` and schemas are rebuilt per `.map()` iteration, and 4 call sites repeat manual `Object.keys`/`Object.hasOwn` validation; hoist static prompts/schemas with `{ additionalProperties: false }`.
29. **[memory-whisperer.ts](../../src/memory-whisperer.ts#L79-L85)** & **[L193-L226](../../src/memory-whisperer.ts#L193-L226)** — `[Medium | duplication | Needs Review]`: Hand-rolls `timedOut` + manual `Promise.race` + listener cleanup instead of the shared `abortable()` + `abortedByTimeout()` pattern used by the other three whisperers.
30. **[safety-whisperer.ts](../../src/safety-whisperer.ts#L75-L96)** & **[my-turn.ts](../../src/my-turn.ts#L140-L150)** — `[Medium | duplication | Safe]`: Reverse `MAX_STATE_TOKENS = 24_000` token-budgeted history accumulation is duplicated 3 times; extract `takeRecentWithinTokens` into [whisperer-context.ts](../../src/whisperer-context.ts).
31. **[safety-whisperer.ts](../../src/safety-whisperer.ts#L153-L177)** — `[Medium | idiom | Safe]`: Chained `isRecord(x) && isRecord(x.y) ? x.y : {}` expressions and a 4-way ternary; import `record` from `./guards.js` and extract `disabledReason`.
32. **[my-turn.ts](../../src/my-turn.ts#L104-L183)** — `[Medium | control-flow | Safe]`: `beforePrompt` recreates the 15-line static `should_respond` question object on every turn; hoist `SHOULD_RESPOND_QUESTIONS` and extract `buildMyTurnState`.
33. **[query-generator.ts](../../src/query-generator.ts#L11-L55)** — `[Medium | control-flow | Safe]`: 4-level nested ternary at `L32-L37` and a 190-char regex compiled inside the `for` loop at `L40`; hoist `INTERNAL_USER_PREFIX` and extract `extractUserContent`.
34. **[query-generator.ts](../../src/query-generator.ts#L119-L150)** — `[Medium | duplication | Safe]`: `fallbackQueries` duplicates dedup/cap logic from `extractFallbackTerms`, eagerly computes `rawTokens` even when unused, and nests ternaries for `vec`; extract `appendFallbackTerms` and `selectVecQuery`.
35. **[analysis.ts](../../src/analysis.ts#L718-L731)** — `[Medium | duplication | Safe]`: `readCluster` computes `available_size` twice for noise clusters (`clusterId === -1`) and selects a discarded dummy `0 AS available_size` for non-noise clusters; compute once.
36. **[quality-audit.ts](../../src/quality-audit.ts#L29-L168)** — `[Medium | control-flow | Safe]`: 140-line `auditQualityPage` repeats `structure` multi-way ternaries (`L132-L146`); replace with a `STRUCTURE_POLICY` map and extract `prepareAuditBatch`/`recordFlaggedGroup` (keeping post-inference TOCTOU checks intact).
37. **[review-tools.ts](../../src/review-tools.ts#L64-L102)** — `[Medium | duplication | Safe]`: `memory_review_claim` and `memory_review_cluster` duplicate the full tool-registration + `reviewRequestContext` + fallback wrapper; extract local `registerReviewTool`.

### People Subsystem
38. **[people-store.ts](../../src/people-store.ts#L387-L518)** — `[Medium | control-flow | Safe]`: 132-line `upsertIdentity` branches twice on `existing` and repeats `optional(...)` normalization; normalize inputs once and split `#insertPersonIdentity`/`#updatePersonIdentity`.
39. **[people-store.ts](../../src/people-store.ts#L658-L743)** — `[Medium | duplication | Safe]`: Same 7-column `INSERT INTO person_dossier_changes` duplicated 3 times; extract `#insertDossierChange`.
40. **[people-store.ts](../../src/people-store.ts#L940-L1011)** — `[Medium | duplication | Safe]`: `#upsertTodoRow` duplicates `UPDATE people_todos` for resolved vs active rows and repeats `SELECT * FROM people_todos WHERE id = ?` 5 times; extract `#todoById` (or use `RETURNING *`) and unify the `UPDATE` with `CASE WHEN status = 'resolved'`.
41. **[people-store.ts](../../src/people-store.ts#L629-L682)** & **[L1036-L1065](../../src/people-store.ts#L1036-L1065)** — `[Medium | duplication | Safe]`: `replaceDossier` serializes the dossier twice (once inside `validateDossier`, discarded, then again via `serializeDossier`), and public/private methods share the name `validateDossier`; consolidate into `#parseAndSerializeDossier`.
42. **[people-primer-tool.ts](../../src/people-primer-tool.ts#L45-L65)** & **[people-dossier-review.ts](../../src/people-dossier-review.ts#L49-L67)** — `[Medium | duplication | Safe]`: Duplicate 120s deadline + API key + manager + agent-identity setup, and `people-dossier-review.ts:L61` calls `resolveAgentIdentity` *inside* the per-assertion loop; hoist `agentName` and share a small review-context helper + `hasActiveHumanIdentity` predicate.
43. **[people-tools.ts](../../src/people-tools.ts#L21-L184)** & **[L223-L354](../../src/people-tools.ts#L223-L354)** — `[Medium | control-flow | Safe]`: `if`-chains with implicit fallthroughs lose TypeScript exhaustiveness on `input.view` and `input.action`; inline 27-line `replace_dossier` branch and repeated pagination schemas/meta; convert to exhaustive `switch`, extract `handleReplaceDossier` and pagination helpers.
44. **[people-learning-store.ts](../../src/people-learning-store.ts#L24-L76)**, **[L109-L154](../../src/people-learning-store.ts#L109-L154)** & **[L178-L235](../../src/people-learning-store.ts#L178-L235)** — `[Medium | control-flow | Safe]`: O(G²) `sourceGapReviews.some` before building `gaps` Map, repeated `Date.parse(manifest.createdAt)`, O(R²) `prior.roster.find` inside `begin`, and dense 58-line `checkpoint`; build maps upfront and split `#mergeReceipt`/`#publishFinalized`.

### Sessions, Extraction & Inside Out
45. **[inside-out-runtime.ts](../../src/inside-out-runtime.ts#L72-L107)** & **[extraction-runtime.ts](../../src/extraction-runtime.ts#L69-L86)** — `[Medium | duplication | Safe]`: Three copies of the same non-overlapping per-agent interval runner, with `inside-out-runtime.ts` missing `clearInterval` before reassigning on `gateway_start` (`L101`, `L103`) and missing the `lifetime.signal.aborted` early guard (`L76`, `L91`); extract a shared `createAgentInterval` helper.
46. **[session-projector.ts](../../src/session-projector.ts#L184-L206)** — `[Medium | control-flow | Safe]`: 22-line inline Loggie meeting dedup/supersession pass with duplicated prefix formatting; extract `deduplicateMeetingMessages` and `prependSupersession`.
47. **[session-projector.ts](../../src/session-projector.ts#L225-L236)** & **[session-noise.ts](../../src/session-noise.ts#L63-L77)** — `[Medium | duplication | Safe]`: Duplicate CommonMark fenced-block state machine, plus dead `closingStart` field in `session-noise.ts`; remove `closingStart` and extract a shared `nextFenceState` helper.
48. **[extraction-source.ts](../../src/extraction-source.ts#L47-L71)** — `[Medium | control-flow | Safe]`: Validates every `page` twice with `Value.Check(pageSchema, result)` (`L50` and `L57`) and allocates `resetSchema`/`missingSchema` per call; hoist schemas and check once.
49. **[session-sync.ts](../../src/session-sync.ts#L181-L205)**, **[extraction-source.ts](../../src/extraction-source.ts#L16-L28)** & **[inside-out-sources.ts](../../src/inside-out-sources.ts#L72-L78)** — `[Medium | duplication | Needs Review]`: Three independent copies of the OpenClaw `session_windows` + `conversations` + `transcript_rewrite_watermarks` join and `COALESCE` projections; centralize shared SQL fragments in `agent-transcript.ts` (carefully preserving per-caller fallbacks/`WHERE` clauses).
50. **[inside-out.ts](../../src/inside-out.ts#L71-L126)** — `[Medium | control-flow | Safe]`: `interactions` mixes sorting, 6-clause filtering, history resets, and context packing while recomputing `at(e)` (`Date.parse`) repeatedly; compute timestamp once and extract `isIgnoredMessage` + `packContextWindow`.
51. **[emotion-baselines.ts](../../src/emotion-baselines.ts#L337-L356)** — `[Medium | idiom | Safe]`: Serializes population tuples to JSON keys only to `JSON.parse` them back and double-JSON-encode snapshot keys; store typed `{ personId, rubric, model, starts }` values and a single flat tuple key.
52. **[inside-out-store.ts](../../src/inside-out-store.ts#L79-L91)** & **[L137-L149](../../src/inside-out-store.ts#L137-L149)** — `[Medium | duplication | Safe]`: `refreshWithFingerprint` opens/closes SQLite twice and `purgeInsideOutPerson` up to 3 times; extract `linkInsideOutPeopleInDb(db)` while preserving the `tableExists` guard and worker-thread `openclaw`-free isolation.
53. **[session-sync.ts](../../src/session-sync.ts#L155-L179)** — `[Medium | duplication | Needs Review]`: `readSnapshot` runs `assertSchema` then `new AgentTranscriptReader`, duplicating version/identity/`PRAGMA table_info` checks on every sync; instantiate `AgentTranscriptReader` first and narrow `assertSchema` to extra `session-sync` columns.
54. **[loggie-projection.ts](../../src/loggie-projection.ts#L6-L69)** — `[Medium | duplication | Safe]`: Redefines `record()` from [guards.ts](../../src/guards.ts) and fuses v1 HTML header parsing with legacy JSON+speaker parsing; import `record` and extract `projectLegacyLoggieMessage`.

### Response Audit, Training & Scripts
55. **[training.ts](../../src/training.ts#L62-L100)** & **[training-queries.ts](../../src/training-queries.ts#L73-L120)** — `[Medium | duplication | Safe]`: Bounded worker-pool + `Promise.allSettled` drain loop duplicated 3 times across `runTraining`, `generateTrainingQueries`, and `evaluateTrainingQueries`; extract a shared `runWorkerPool` helper.
56. **[training.ts](../../src/training.ts#L81-L87)** & **[training-queries.ts](../../src/training-queries.ts#L50-L59)** — `[Medium | duplication | Safe]`: `TypeSafeRequestError` HTTP 4xx / `retryAfter` classification duplicated (with nested ternaries in `training-queries.ts`); extract a single `classifyTrainingError` helper.
57. **[response-audit.ts](../../src/response-audit.ts#L69-L140)** & **[response-stages.ts](../../src/response-stages.ts#L15-L18)** — `[Medium | control-flow | Safe]`: 132-line `auditResponses` inlines memory-stage caching (while `response-stages.ts` casts a 4-key object to 5-key `Record<keyof ResponseStages, string>`), has a tautological guard at `L128`, duplicates coverage addition (`L83`, `L89`), and hand-rolls `setImmediate`; extract `assessMemoryOpportunity`, `addCoverage`, narrow `keys`, and use `setImmediate` from `node:timers/promises`.
58. **[response-episodes.ts](../../src/response-episodes.ts#L34-L150)** — `[Medium | dead-code | Safe]`: `meta?.turnTainted === true` at `L127` is dead (already filtered out at `L110`); `{ coverage.filteredEvents++; boundary(); continue; }` repeats 6 times; remove the dead check and add a small `filterOut()` helper.
59. **[response-text.ts](../../src/response-text.ts#L66-L132)** — `[Medium | control-flow | Safe]`: 45-line scanner with 3 nested `while` loops and `[...rest.matchAll(SLACK_MESSAGE_LINE)].length > 0` allocating all matches just to check existence (`L76`); extract block-skipping helpers and use `rest.search(SLACK_MESSAGE_LINE) >= 0`.
60. **[training-runtime.ts](../../src/training-runtime.ts#L64-L85)** — `[Medium | indirection | Safe]`: `for (const command of ["generate", "evaluate"])` branches on `command === "generate"` 3 times, widening option types; register both commands directly with a tiny shared-options helper.
61. **[typesafe-fleet-remote.mjs](../../scripts/typesafe-fleet-remote.mjs#L55-L150)** — `[Medium | control-flow | Safe]`: 96-line `deploy()` `try` block with inline `strip()` helper (`L124-L132`); hoist `stripManagedTypesafeFields` and extract `writeBackupAndKey`/`verifyAppliedState` inside the same standalone file (preserving SSH base64 self-containment).

---

## Low Priority Findings (21)

62. **[manager.ts](../../src/manager.ts#L1148-L1196)** — `[Low | control-flow | Safe]`: Extract lazy `#getSkillIndex(llm)` out of `searchSkills`.
63. **[memory-search.ts](../../src/memory-search.ts#L58-L65)** & **[memory-passage.ts](../../src/memory-passage.ts#L11-L15)** — `[Low | idiom | Safe]`: Avoid per-candidate object cloning (`{ ...candidate, text: candidate.snippet }`) and hoist `normalized(passage.text)` out of `previous.some(...)`.
64. **[sources.ts](../../src/sources.ts#L54-L55)**, **[L80-L98](../../src/sources.ts#L80-L98)** & **[L124-L142](../../src/sources.ts#L124-L142)** — `[Low | duplication | Safe]`: Deduplicate `expandHome` + double `resolve(...)`, drop redundant `configuredPath` override in `resolveSessionSource`, and inline 1-line `resolveFileSource`.
65. **[skill-whisperer.ts](../../src/skill-whisperer.ts#L13)** & **[L132-L133](../../src/skill-whisperer.ts#L132-L133)** — `[Low | dead-code | Safe]`: Remove unreachable `if (!resolved) return;` / redundant `resolved &&` after `L110` guard, and reuse `MAX_SKILL_QUERY_CHARS` from `whisperer-context.ts`.
66. **[query-generator.ts](../../src/query-generator.ts#L196-L249)** — `[Low | error-handling | Safe]`: Extract `readBoundedJson` and `rethrowQueryError` to eliminate 3 identical timeout `catch` blocks.
67. **[mlx-query-worker.py](../../src/mlx-query-worker.py#L52-L53)** — `[Low | indirection | Safe]`: Inline single-line pass-through `prompt_tokens` wrapper (`L64`, `L76`).
68. **[curation.ts](../../src/curation.ts#L6-L13)**, **[L210-L239](../../src/curation.ts#L210-L239)** & **[L317-L325](../../src/curation.ts#L317-L325)** — `[Low | idiom | Safe]`: Replace type-only runtime arrays with literal union types and use SQLite `RETURNING *` in `addTask`/`updateTask` instead of follow-up `SELECT`s.
69. **[cluster-review.ts](../../src/cluster-review.ts#L29-L31)** — `[Low | duplication | Safe]`: Avoid calling `parseSafeVirtualPath` (2× `realpathSync`) twice on the same path before inference (keeping post-inference TOCTOU check at `L50`).
70. **[analysis.ts](../../src/analysis.ts#L444-L516)** — `[Low | duplication | Safe]`: Hoist repeated date-path glob and compute `is_session`/`is_dated_path` once (or use named SQLite parameters) instead of binding `sessionCollection` 3× and `runId`/`clusterId` 2× positionally.
71. **[people-hooks.ts](../../src/people-hooks.ts#L52-L73)** & **[L135-L139](../../src/people-hooks.ts#L135-L139)** — `[Low | control-flow | Safe]`: Flatten nested dossier-verified ternary into a guard clause and extract `resolveSlackThreadKey`.
72. **[people-learning-cron.ts](../../src/people-learning-cron.ts#L30-L54)** — `[Low | control-flow | Safe]`: Drop gratuitous bare `{ ... }` block and extract `matchesLearningJob`.
73. **[people-store.ts](../../src/people-store.ts#L32-L58)** — `[Low | duplication | Safe]`: Extract shared `isoTimestampSchema` instead of repeating the 84-char ISO-8601 regex 3 times.
74. **[session-sync.ts](../../src/session-sync.ts#L102)** & **[L225-L226](../../src/session-sync.ts#L225-L226)** — `[Low | dead-code | Safe]`: Remove unread `EventRow.sessionId` property to eliminate cloning up to 50k row objects per changed session.
75. **[extraction-model.ts](../../src/extraction-model.ts#L52-L107)** — `[Low | duplication | Safe]`: Reuse cached `promptTokens` (`L73`), call `messages.map(datedMessage)` (`L107`), and hoist `responseSchema` (`L79-L80`).
76. **[inside-out.ts](../../src/inside-out.ts#L289-L291)** — `[Low | idiom | Safe]`: Unify `reportInsideOut`'s mixed `(? IS NULL OR col=?)` and concatenated SQL filters into one `clauses[]`/`params[]` builder.
77. **[extraction-config.ts](../../src/extraction-config.ts#L10-L27)** & **[inside-out.ts](../../src/inside-out.ts#L48-L57)** — `[Low | duplication | Safe]`: Reuse `isRecord` from `./guards.js` and share a bounded-integer config helper.
78. **[inside-out-sources.ts](../../src/inside-out-sources.ts#L24-L32)** — `[Low | control-flow | Safe]`: Move the `!events.some(e => e.parentId !== undefined)` fast-path return above `Map` construction and `findLast` scans.
79. **[response-store.ts](../../src/response-store.ts#L32-L59)**, **[L102-L349](../../src/response-store.ts#L102-L349)** — `[Low | duplication | Safe]`: Extract `MAX_RETRY_ATTEMPTS = 3` / `RETRY_BACKOFF_MS = 600_000` constants and use `immediateTransaction` in constructor.
80. **[training-store.ts](../../src/training-store.ts#L219-L228)** & **[L378-L391](../../src/training-store.ts#L378-L391)** — `[Low | idiom | Safe]`: Hoist `this.#db.prepare(...)` outside the loops in `retry()` and `exportRows()`.
81. **[response-runtime.ts](../../src/response-runtime.ts#L40-L58)** — `[Low | duplication | Safe]`: Validate `opts.bucket` before opening SQLite and share a `cohort()` helper inside `registerCli`.
82. **[training-models.ts](../../src/training-models.ts#L43-L64)** — `[Low | dead-code | Safe]`: Replace type-only runtime `usageSchema` with a plain TypeScript type and hoist `teacherResponseSchema` (`L60-L63`) to module scope.

---

## Next Steps

- Run `/code-simplifier --yolo` on the full repo (or target specific modules such as `src/config.ts src/plugin.ts`, `src/people-*`, `src/response-*`, `src/training-*`, or `src/inside-out*`) to autonomously apply all `Safe` simplifications and verify with `npm run preflight`.
- Or pick specific finding numbers (e.g. "apply High findings #1–#19") to land in focused, easy-to-review batches.
