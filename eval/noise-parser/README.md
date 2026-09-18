# Noise parser: shadow verification

**Frozen shadow baseline; runtime integration now implemented locally.** `parser.ts`
is retained as the independent approved baseline. Production envelope handling
lives in `src/session-noise.ts` and `src/session-projector.ts`; source-aware chunk
eligibility lives in the companion QMD repository. Neither change is deployed.
The original shadow harness proposes narrow cleanups, then compares
them with every currently indexed chunk in the configured quality-audit corpora.
It does not edit memories, projections, indexes, or review tasks. It makes no AI calls.

## Rules

1. **Dreaming scaffolding:** exclude a chunk only when its entire span lies inside
   the exact `## REM Sleep` + opening REM marker. Never remove the REM section or
   its reflections. Original Markdown and source offsets remain unchanged.
2. **Internal task envelopes:** require an exact raw-message match in the owning
   session, trusted inter-session provenance, and a complete known grammar. Keep
   the result verbatim, task/status, and an explicit untrusted historical label.
3. **Attachment/scaffolding cleanup:** unwrap complete matched external file
   envelopes, preserving filename, MIME type, trust label and payload. Simplify
   only the exact legacy HTML export shell; retain visible text and entities
   verbatim. A standalone closing code fence is eligible only with a verified
   matching opening fence and substantive preceding content.

Unknown/malformed shapes and fenced/indented examples are retained. There are no
generic short-text, JSON, UUID, punctuation, HTML, or low-value-content filters.

## Run

```sh
npx tsc -p eval/noise-parser/tsconfig.json
node --import tsx --test tests/noise-parser.test.ts
node eval/noise-parser/shadow.mjs STATE_ROOT INSTALLED_PLUGIN_ROOT \
  reports/noise-parser/build/parser.js NEW_REPORT_DIRECTORY
```

Requires Node with `node:sqlite`, the installed plugin, and the host's main-agent
state. For remote runs, transfer only the compiled parser and harness, then run on
the host. Do not copy credentials or private corpus reports into the repository.
The output directory must be new and outside corpus roots. Reports are private
(directory 0700, files 0600).

SQLite connections are read-only, with read transactions per database. The report
records document/parser/manifest hashes and checks for concurrent database or
manifest changes. `inputsStable: false` means rerun before drawing conclusions.
This does not assert that indexed content matches the latest filesystem content.

Reports contain exact removed/replacement spans, retained chunk text, task IDs,
and rejected candidate messages. Every character outside proposed edits is
checked against the transformed output; protected payload spans cannot overlap
edits. Chunk outcomes are also deduplicated by task ID.

## Pearl verification — 2026-09-18 UTC

Host report: `/Users/pearlperelel/.openclaw/noise-parser-shadow-20260918/run-3/`.
Scope: memory, knowledge, sessions (configured approved session scope).

- 539 documents / 31,118 existing chunk occurrences; inputs stable during scan.
- All 177 pending quality-review tasks matched indexed chunks.
- Proposed text cleanup: 41 documents, 160 edits, 70 preserved payloads.
- 11,928,675 original UTF-16 code units outside edits verified unchanged.
- No whole message emptied.

| Existing chunks | Structure only | Partial wrapper cleanup | Unchanged |
| --- | ---: | ---: | ---: |
| Flagged occurrences | 78 | 10 | 91 |
| Unflagged occurrences | 21 | 88 | 30,830 |
| Unique review tasks | 76 | 10 | 91 |

The 76 unique structure-only task matches are 6 REM markers, 52 internal-envelope
chunks, 17 attachment-envelope chunks, and 1 source-confirmed closing fence.
Duplicate occurrences explain the difference between 177 tasks and 179 flagged
chunk occurrences. Ten partially changed flagged chunks retain payloads (six HTML
shell cleanups, four attachment prefixes).

Reviewed all 21 unflagged structure-only spans: two background-task prefixes and
19 exact action/routing footers. These are expected boilerplate beyond the audit
flags, not newly inferred low-value memories. Unflagged partial changes are 66
internal-envelope, 18 attachment-envelope, and 4 HTML-shell cleanups; their
payloads remain covered by the retained-span checks.

The 91 untouched tasks remain deliberately unresolved: 64 lack an exact raw
message match, 11 lack trusted internal provenance, 4 fail the complete grammar,
and 12 are outside these message shapes (including staged dreaming candidates,
opaque filenames, and other fragments). Missing raw matches are an evaluation
coverage limitation, not evidence that those chunks are safe or valuable. Do not
broaden deletion rules just to make the audit count fall.

Validation: all 184 repository tests pass; build, typecheck, knip, parser compile,
and harness syntax check pass. Review caught and fixed an EOF fence false-positive:
an unclosed block ending with a shorter or different fence must remain unchanged.

## Runtime integration verification

`verify-runtime.mjs` compares the built runtime projector with the frozen approved
parser, then compares QMD v6/v7 semantic chunking using deterministic hash vectors
and a character-count tokenizer. It opens the index and raw-event databases
read-only and checks the shadow report's input hashes. It never loads an embedding
model or changes an index. Run arguments:

```text
STATE_ROOT INSTALLED_PLUGIN_ROOT SHADOW_REPORT BUNDLE_DIRECTORY NEW_REPORT_DIRECTORY
```

The isolated bundle contains built `session-projector.js`, `session-noise.js`,
`loggie-projection.js`, QMD's `semantic-chunking.js`, `structural-noise.js`, and
the compiled frozen parser as `baseline-parser.mjs`. The installed plugin's
sibling QMD package supplies the pre-change chunker.

Pearl final report: `/Users/pearlperelel/.openclaw/noise-parser-shadow-20260918/runtime-check-3/`,
using refreshed shadow snapshot `run-4` (same document, task, and edit counts).
The freshness guard rejected the older manifest after a normal live sync; the
comparison was rerun against fresh inputs rather than weakening the guard.

- All 45,015 active events in the indexed sessions matched the approved parser's
  expected projection. 114 events changed, across 48 sessions. Raw-event parsing
  reaches cases the shadow's exact-text lookup could not match; the rules did not
  broaden.
- Compared all 539 indexed documents plus the complete 48 changed session
  projections reconstructed in active-event order.
- At a 300-token ceiling: 29,779 baseline chunks versus 29,679 after cleanup;
  8 normalized chunks omitted by the structural eligibility check.
- At a 128-token ceiling: 41,479 versus 41,135; 10 structural omissions.
- Both passes checked 13,063,331 retained UTF-16 code units, exact source slices,
  non-overlapping citations, and coverage of previously indexed substantive text.
  No unexpected loss; inputs stable throughout the comparison.

The new chunker must produce exactly the baseline chunker's output on normalized
text minus the frozen parser's approved structural-only spans. Independently,
retained non-whitespace characters covered before cleanup must remain covered
afterward unless they belong to those approved structural spans.

Validation now includes 186 plugin tests and full plugin preflight, plus 297 QMD
semantic/store tests on both Node and Bun, typecheck, build, knip, and lint. Migration tests cover v5
session re-projection without raw-event writes and retirement of stale vectors
for newly empty structural-only documents.

## Release boundary and remaining limits

`structuralOnly` describes the original chunk's content, **not a prediction of
future chunk counts**. Generated replacement labels may produce different chunks.
The runtime verification exercises new chunk boundaries and source offsets under
deterministic model doubles. It is not a production-tokenizer/vector-quality or
live retrieval benchmark.

No deployment, production reindex, source edits, task deletion, or release was
performed. The plugin still pins the published QMD 2.9.5 artifact: publish the
companion QMD changes and update that pin/lockfile before releasing the plugin.
The new semantic fingerprint intentionally makes existing embeddings stale;
plan for re-embedding during rollout. Missing provenance remains fail-closed.

## Review fixes

- Runtime attachment matching now bounds candidate-count × message-length to
  1,000,000 UTF-16 scan units before running the envelope regex. Exceeding the
  budget skips **all** attachment edits for that message; its content is retained
  verbatim. Ordinary under-budget matching uses the same verified grammar. A
  focused test includes a valid attachment before a malformed tail to ensure the
  fallback cannot partially rewrite a message. The 3.12 MB repeated-opener probe
  improved from about 1.85 seconds to about 3 milliseconds through projectSession.
- The verifier ignores blank JSONL lines, including completely empty edits files.
  CLI tests cover clean and REM-only corpora, with synthetic chunker fixtures and
  real read-only SQLite inputs. No production index or model is used.

The frozen baseline intentionally remains unchanged. Its strict runtime comparison
will still flag any budget-induced non-edit that differs from the old baseline;
inspect that difference as retained content rather than weakening the safety gate.
