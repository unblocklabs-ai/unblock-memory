# Session memory extraction

Opt-in lasting-fact extraction: **Luna proposes facts → code checks exact quotes →
Jev checks support and retention → SQLite stores accepted facts → optional QMD search.**
It is independent of Inside Out: emotion scores do not select or strengthen memories.
It never writes `MEMORY.md`, daily Markdown, or people dossiers.

## Enable in shadow mode first

Merge this fragment under `plugins.entries.unblock-memory.config`, preserving
existing corpora and settings. Extraction chat types must be explicitly approved
and be a subset of the configured sessions corpus. This is channel agnostic.

```json
{
  "corpora": [
    { "name": "memory", "kind": "files", "paths": ["MEMORY.md", "USER.md", "memory/**/*.md"] },
    { "name": "sessions", "kind": "sessions", "chatTypes": ["channel", "group"] }
  ],
  "extraction": {
    "enabled": true,
    "publish": false,
    "chatTypes": ["channel", "group"],
    "intervalMinutes": 60,
    "historyMessages": 6,
    "maxBatches": 5,
    "minSupport": 0.90,
    "minRetention": 0.90,
    "minReplacement": 0.90
  }
}
```

Configure [TypeSafe credentials](configuration.md#typesafe-and-whisperers).
Manual runs use the same Gateway-owned worker as scheduled runs; the Gateway must
be running and the CLI caller needs `operator.admin`. Reports can be read offline.
Requires host visible-transcript delta reads and working isolated LLM completion
(validated on OpenClaw 2026.9.2 with Codex 0.159.2). The native harness must be
installed through OpenClaw, not merely added to `plugins.load.paths`. Grant this
host policy **alongside `config`** in the plugin entry:

```json
{
  "llm": {
    "allowAgentIdOverride": true,
    "allowModelOverride": true,
    "allowedModels": ["openai/gpt-5.6-luna"],
    "allowedCompletionModels": ["openai/gpt-5.6-luna"]
  }
}
```

Luna uses the host's configured agent runtime and credentials, with zero tools and
no alternate-model/provider fallback. Missing TypeSafe credentials prevent source
scans and model calls. Enabling approves sending selected conversation text to
Luna and Jev; tool calls/results and hidden thinking are removed first.

## Run, backfill, inspect

```sh
openclaw memory-extract run --agent main --since 2026-09-01 --session SESSION_ID
openclaw memory-extract report --agent main
openclaw memory-extract run --agent main --since 2026-09-01
```

Without `--since`, the first enabled run establishes a live start time; historical
messages require an explicit backfill. Runs process at most `maxBatches` session
chunks; repeat the same command to continue. The approved backfill boundary and
cursors persist across restarts and scheduled runs. An earlier `--since` replays
history without deleting retained facts. Unchanged reruns make no model calls;
new messages resume from each session's cursor. Failed chunks do not advance it.

## Retention and thresholds

Retain explicit identities, relationships, ongoing responsibilities, stable
preferences, enduring project purposes, and adopted standing rules. Omit guesses,
hypotheticals, one-off tasks, temporary status, release/incident details, generic
technical knowledge, and credentials. The original transcripts remain searchable.

A blue guess followed by a human correction to red retains only the red preference.
Each proposal needs exact supporting quotes and new-message evidence. Jev checks
support and retention independently in one request; replacements also require an
explicit update to the same fact. All applicable thresholds must pass, and support
must select `supported`, even if its threshold is lowered.

The three thresholds accept 0–1 and default to 0.90. Lowering retention changes
certainty about category membership, not the categories themselves. Agents can
edit configuration when instructed, then reload/restart the Gateway; they must
not silently lower thresholds. Decisions store their probabilities and thresholds
for inspection. Changing thresholds affects future processing, not existing records;
rejected proposals are not kept for automatic regrading.

## Storage, search, and limits

Three tables in the existing agent `unblock-memory.sqlite` store worker state,
session checkpoints, and versioned facts/evidence/judgments. Facts and checkpoints
commit together. Deduplication/corrections are per session, not cross-session;
older evidence cannot overwrite a newer observation. Source resets/deletions
withdraw affected facts when the worker next checks them. Reports include accepted
facts, judgments, checkpoints, and source/proposal/validation/commit failure stages
without leaking provider errors or source text into error messages.

`publish: false` stores accepted facts for evaluation only. `publish: true` indexes
them in the existing QMD `index.sqlite`; `memory_search` includes them by default,
or use `corpora: ["extracted"]`. `memory_get` checks the current active revision.
No automatic whisperer/dossier changes are introduced. Published facts can be
retrieved across this agent's audiences; this is **not per-person access control**.
Do not approve private conversations for a shared agent unless sharing is intended.

The Gateway owns the scheduler; no cron/launchd job is added. Interval 0 means
manual-only; the maximum is 1,440 minutes (daily). Defaults are disabled, unpublished,
no approved chat types, hourly, six overlap messages, and five chunks per run.

Chunks target 24k input tokens and cap at 28k, including Luna instructions, prior
facts and overlap, leaving room for Jev's 32k state-plus-longest-question limit.
`o200k_base` is a budgeting proxy, not an exact Jev/host token count. Quotes are
limited to 512 characters each. Up to six overlap messages fit within 8k tokens by
default. Oversized messages split losslessly with resumable offsets and original
message-ID citations. A session above 100 retained facts or 40k characters of prior
facts pauses rather than silently dropping comparison context. The output limit
is advisory on some host runtimes; malformed/truncated JSON is retried, never saved.

This is a conservative v1, not a calibrated guarantee of memory recall or truth.
Start with a single-session shadow run and inspect the retained facts before publishing.
