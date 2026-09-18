# Pre-release enhancement checks

Run deterministic tests with `npm run preflight`. New coverage is in
`tests/{evidence-review,cluster-review,quality-triage,review-tools}.test.ts` and
the existing whisperer/parser suites. All are offline and credential-free.

## Live synthetic prompt comparison

```sh
node eval/enhancements/check.mjs PLUGIN_ROOT KEY_FILE NEW_REPORT_DIRECTORY
```

Calls the real TypeSafe API with synthetic labeled cases only. It compares the
baseline top-two selection against complementary hints, tests source support
(person/date/scope/negation/certainty), and checks mixed ingestion defects/useful
content. Reports include latency and probabilities. They do not log credentials.
Output creation is exclusive; do not overwrite earlier trials. A small passing
sample does not establish domain-wide calibration. Complementary hints remain
opt-in; the configured total before-turn deadline is unchanged.

## On-host corpus and packaged upgrade rehearsal

Use a fresh private directory outside corpus roots. Build and pack both repositories,
unpack the artifacts into an isolated `node_modules/@unblocklabs/` tree, and resolve
the existing host dependencies without overwriting their install. Never use this
workflow to replace the live plugin implicitly. The plugin's published QMD pin is
a separate release prerequisite; local packages sharing a version are identified by
their hashes, not their version labels.

```sh
node eval/enhancements/prepare-corpus.mjs LIVE_STATE_ROOT INSTALLED_PLUGIN_ROOT NEW_SNAPSHOT
node eval/enhancements/upgrade.mjs SNAPSHOT INSTALLED_PLUGIN_ROOT CANDIDATE_PLUGIN_ROOT \
  NEW_REPORT_DIRECTORY KEY_FILE ANALYSIS_EXECUTABLE
```

`prepare-corpus` takes SQLite backups with the input databases opened read-only,
copies the manifest, and reconstructs approved source files from indexed content.
It rekeys collection names for the private copy and preserves review tasks/cache.
The snapshot is **indexed content, not proof of latest filesystem content**.
It contains private data: keep it on its host, outside corpus roots, mode 0700.
Do not commit reports or credentials. The manifest stability check detects session
sync changes; SQLite backups are consistent individually, not a cross-database
transaction. The shadow/runtime checks are required before accepting the snapshot.

Run `eval/noise-parser/shadow.mjs` and `verify-runtime.mjs` against the frozen
snapshot as documented in that directory. They establish projection equivalence,
preservation and citations independently of the live model tests.

`upgrade` clones the index and projections again for before/after runs. The old
plugin supplies baseline searches; the candidate performs real re-projection and
embedding, source-range retrieval checks, an audit page, one claim review, and
reclustering/cluster review. It never starts watchers or changes the Gateway config.
Nine corpus-derived probes are sentence-level retrieval smoke tests, not a broad
retrieval benchmark. Corpus excerpts are sent only under the explicitly approved
corpora. All on-host reports remain private; stdout contains counts/stages only.

If a check fails, inspect the failing state rather than relaxing preservation or
freshness checks. Do not promote a synthetic fixture result into a claim about
production behavior. Record exact outcomes and release prerequisites in
`RELEASE-ENHANCEMENTS.md`.
