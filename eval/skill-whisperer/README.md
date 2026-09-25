# Skill Whisperer comparison

An opt-in experiment; it does not change plugin runtime behavior or add dependencies.
Both API arms reuse the production per-candidate Noul selector and shared transport.

## Run

From the repository root:

```sh
npx tsc -p eval/skill-whisperer/tsconfig.json
node --import tsx eval/skill-whisperer/compare.ts
node --env-file=.env --import tsx eval/skill-whisperer/compare.ts --live
```

The default invocation validates fixtures without inference. `--live` uses
`TYPESAFE_API_KEY`, real QMD local embeddings, and one TypeSafe request per skill
per arm per case (up to 760 requests with the current 40-case/16-skill fixtures).
It may download QMD's default embedding model if absent. It reads no fleet configs,
conversation logs, memory documents, or dossiers. Only synthetic requests/history
and snapshotted skill names/descriptions go to TypeSafe. Source paths are not sent.

Results, input/selector hashes, model ID, timings, token usage and the
isolated QMD database remain in a unique ignored `reports/skill-whisperer/` directory.
Each arm is checkpointed. Candidate requests run concurrently without retries.
Candidate-level HTTP status and timing are logged without secrets. Partial failures
preserve successful siblings, matching production, and are counted in the report.
If every candidate fails, the run stops without substituting a prediction; incomplete
runs do not produce an aggregate report.

## Arms

1. Production `QmdMemoryManager.searchSkills` plus its default 0.5 gate.
2. The same query's top three, **without** that gate, scored independently by TypeSafe.
3. Independent per-skill scoring over the entire 16-skill fixture roster.

Labels are fixed in `cases.ts`, permit multiple valid skills, and are never sent
to the API. All descriptions are normalized to one line for equal input content;
this does not exercise production multiline frontmatter parsing. The production
usefulness threshold is 0.7: highest qualifying probability wins, ties retain input
order, and none qualifying means no hint. No threshold is fitted to these cases.
The full-roster arm diagnoses shortlist loss but needs a
larger-inventory test before a production recommendation.

This evaluates fresh-turn selection, not cooldown behavior or whether an agent
actually follows a suggestion. Existing whisperer tests cover hook/cooldown rules.
Use an independently labeled, approved traffic sample before claiming fleet gains.

References checked 2026-09-24:
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/cookbooks/rerank_typesafe
- https://docs.typesafe.ai/models
