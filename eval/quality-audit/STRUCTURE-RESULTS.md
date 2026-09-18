# Bill: corpus audit and JSON prompt comparison

Run: 2026-09-17. Baseline: installed `0.3.13` / repository commit `fed4634`.
Model: `jev-1.13.0`. Bill's installed plugin and configuration were not replaced.

## Complete baseline audit

Approved corpora: memory, knowledge and sessions, including configured direct
conversations. The installed Gateway tool completed 667 pages:

- 13,329 indexed chunk occurrences scanned; no stale/oversized skips or partial pages.
- 12,870 model judgments, 453 cached occurrences; remaining differences reflect
  within-batch deduplication and deterministic empty-content checks.
- 209 flagged occurrences: 187 memory, 22 sessions, 0 knowledge.
- 207 deduplicated maintenance tasks across 92 documents: 73 memory, 19 sessions.
- Sources were not edited, moved, deleted or suppressed; review statuses were not changed.

The inbox contains 145 complete backfill-comment-only chunks, 38 separator-only
chunks, 2 session headers, 8 meeting-notification wrappers, 1 deduplicated empty
chunk task, and 13 other indicators. The empty task covers three occurrences.
Categories describe the visible chunk, not proof that its source document is junk.

The clearest repair opportunity is keeping transport/formatting artifacts out of
indexed text while retaining source/provenance. Meeting notifications also carry
useful evidence and should not be discarded wholesale. A note describing prior
noise removal was flagged: a likely semantic false positive. Human/agent source
review remains necessary; this audit does not establish precision or recall.

## Controlled comparison

Only instruction/criteria organization changed. Existing prose was separated into
labeled JSON fields, skill names/descriptions kept separate, and criteria wrapped
in definition/inclusion/exclusion fields. No examples, thresholds, model or
retrieval changes were introduced. The runtime quality cache version becomes
`jev-1.13.0:quality-v2-json`.

- 203 fixed corpus-sample chunks: 100 memory, 100 sessions, all 3 eligible unique
  knowledge chunks. Selection is deterministic by content hash, not a labeled
  or fleet-representative test set.
- 80 additional baseline-noise-enriched chunks, 40 each from memory and sessions.
  This diagnostic group is not a prevalence sample.
- 40 synthetic Skill Whisperer cases with frozen top-three shortlists from the
  earlier evaluation; 12 newly labeled synthetic Memory Whisperer cases; 8
  existing synthetic quality cases. Labels were not sent to TypeSafe.
- Two passes per format, alternating execution order: 500 successful requests.
  The runner verified identical state hashes per pair/repeat and exact model IDs.
- Real corpus text and detailed snapshots stayed on Bill in a mode-700 directory,
  with mode-600 report files. The comparison did not write live caches or inbox tasks.

## Results

| Test | Prose | Structured JSON |
| --- | --- | --- |
| Skill fixtures, each pass | 40/40 | 40/40 |
| Memory fixtures, each pass | 10/12 | 10/12 |
| Synthetic quality fixtures, each pass | 8/8 | 8/8 |
| Corpus-sample review decisions, 203 chunks x 2 passes | 6/406 | 7/406 |
| Noise-enriched review decisions, 80 chunks x 2 passes | 75/160 | 80/160 |

There were six paired quality-decision disagreements across five real chunks.
JSON additionally flagged a backfill marker, a `NO_REPLY` fragment, two queued-message
markers and an audio-attachment pointer. Only one queued-message marker was an
additional JSON flag in both passes. The attachment pointer may be useful provenance;
it is not automatically junk. No paired skill or memory decisions changed.

Repeat variation: prose changed one quality decision between passes; JSON changed
three. Therefore some threshold crossings are unstable, not robust improvements.
Both memory formats scored the useful preference and incident-precedent fixtures
at about 0.82, below the unchanged 0.9 gate. JSON organization did not fix those misses.

| Request family | Prose median / p95 | JSON median / p95 | JSON input-token increase |
| --- | --- | --- | --- |
| Quality (batches up to four) | 175 / 324 ms | 172 / 311 ms | 21.8% |
| Skill | 164.5 / 244 ms | 172.5 / 279 ms | 13.7% |
| Memory | 169.5 / 275 ms | 169 / 260 ms | 12.7% |

No request exceeded 1.5 seconds. The experiment used a 10-second timeout to
separate model behavior from timeout policy; these are request latencies, not
end-to-end whisperer latency. Synthetic fixtures do not validate live retrieval,
cooldowns, agent adoption, or real-traffic accuracy.

## Conclusion

JSON organization makes the policies easier to maintain and modestly increases
audit sensitivity on this sample. It did not improve either whisperer's labeled
accuracy and costs more input tokens. Do not claim a general quality or speed gain.
Keep the structural change separate from future examples or threshold experiments.
The complete corpus audit is the strongest practical result: it identified a
specific ingestion-layer cleanup opportunity without authorizing automatic deletion.

Validation: full preflight passed (170 tests), plus the evaluation TypeScript
check and Python syntax checks. Changes remain uncommitted/unreleased. Bill stays
on the baseline `0.3.13`; only the isolated comparison used the JSON implementation.

Private artifacts on Bill:
`/Users/billjohansson/.openclaw/typesafe-structure-eval-20260917/`.
See the adjacent README for reproduction, privacy boundaries and limitations.
