# Skill Whisperer comparison

An opt-in experiment; it does not change plugin runtime behavior or add dependencies.
The TypeSafe skill's bounded Choice + explicit no-match pattern informs this test.

## Run

From the repository root:

```sh
npx tsc -p eval/skill-whisperer/tsconfig.json
node --import tsx eval/skill-whisperer/compare.ts
node --env-file=.env --import tsx eval/skill-whisperer/compare.ts --live
```

The default invocation validates fixtures without inference. `--live` uses
`TYPESAFE_API_KEY`, real QMD local embeddings, and 80 TypeSafe evaluations
(up to two retries each for transient HTTP errors).
It may download QMD's default embedding model if absent. It reads no fleet configs,
conversation logs, memory documents, or dossiers. Only synthetic requests/history
and snapshotted skill names/descriptions go to TypeSafe. Source paths are not sent.

Results, input snapshots, probabilities, model IDs, timings, token usage and the
isolated QMD database remain in a unique ignored `reports/skill-whisperer/` directory.
Each answer is checkpointed. Transient HTTP failures get at most two retries with
bounded backoff, included in latency; HTTP attempts are logged without secrets.
Other failures stop the run without substituting a prediction. Partial runs do
not produce an aggregate report. No automatic retry for network timeouts.

## Arms

1. Production `QmdMemoryManager.searchSkills` plus its default 0.5 gate.
2. The same query's top three, **without** that gate, then TypeSafe Choice + none.
3. TypeSafe Choice + none over the entire 16-skill fixture roster.

Labels are fixed in `cases.ts`, permit multiple valid skills, and are never sent
to the API. All descriptions are normalized to one line for equal input content;
this does not exercise production multiline frontmatter parsing. No confidence
threshold is fitted. The full-roster arm diagnoses shortlist loss but needs a
larger-inventory test before a production recommendation.

This evaluates fresh-turn selection, not cooldown behavior or whether an agent
actually follows a suggestion. Existing whisperer tests cover hook/cooldown rules.
Use an independently labeled, approved traffic sample before claiming fleet gains.

References checked 2026-09-17:
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/cookbooks/skill_suggestion
- https://docs.typesafe.ai/models
