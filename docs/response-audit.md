# Response quality and sentiment

[Overview](../README.md) · [Configuration and credentials](configuration.md)

`responseAudit` evaluates bounded human-agent exchanges in the background. It is
separate from chunk-quality auditing and never changes memories or prompts. It
creates private response-review tasks, not memory-curation tasks.
Its primary purpose is tracking delivery quality over time: visible fulfillment,
deliverable fit, clear underdelivery and its observable reason. Memory gaps are only
an optional diagnostic lead, not a proxy for performance.

This reads the host transcript database directly: it does not require a `sessions`
corpus, People Primer, whisperers or clustering. Configure [shared TypeSafe
credentials](configuration.md#shared-typesafe-credentials) separately. Begin with
the dry-run command below before requesting inference.
Only approved Slack sender IDs with trusted `senderKind: human` or owner metadata
qualify (older Slack records use unknown senderKind even for known owners).
Explicit bots, unverified identities, internal messages, other senders and thread changes form
hard boundaries. Synthetic delivery mirrors and gateway-injected answers are excluded.
Assistant progress messages are grouped with the terminal answer.
Recognized Slack envelopes are stripped even inside `upstreamUserText`; embedded
history is not treated as current human text. Ambiguous envelopes are excluded.
Removed history marks the context as limited; ordinary Markdown/JSON is preserved.
Human feedback closes when the next assistant turn starts. Still-open feedback,
no-response exchanges, incomplete/failed turns and oversized inputs are not graded.

Place this fragment under `plugins.entries.unblock-memory.config`. The optional
`memoryCorpora` names must already exist as file corpora; use `[]` to omit memory
investigation while still tracking response quality and sentiment.

```json
{
  "responseAudit": {
    "enabled": true,
    "sentimentEnabled": true,
    "senderIds": ["YOUR_SLACK_USER_ID"],
    "chatTypes": ["direct"],
    "historyMessages": 6,
    "lookbackDays": 30,
    "maxEpisodes": 20,
    "intervalMinutes": 60,
    "memoryCorpora": ["memory", "knowledge"]
  }
}
```

This is explicit approval to send those exchanges to TypeSafe. Sender IDs apply
across the agent's Slack accounts; use only identities approved in all such accounts.
`memoryCorpora` is optional and separately approves configured **file** corpora for
memory-gap investigation. Leave it empty to send no indexed memory evidence.
`typesafe.enabled: false` or missing credentials prevents evaluation. An interval
of zero means manual-only. Defaults are disabled, no approved senders, direct chats,
6 preceding visible messages, 30 days, 20 episodes per run and a 60-minute interval.
`sentimentEnabled` defaults to **true within that opt-in audit**; it does not bypass
approved senders or TypeSafe credentials. Set it false to omit polarity, annoyance,
frustration and intensity questions while retaining quality/repair judgments.
`intervalMinutes` controls their shared cadence; no second sentiment timer is needed.
For example, `720` means every 12 hours; `0` means manual-only. `maxEpisodes`
defaults to 20 per run (maximum 100), so one scheduled run may not clear a backlog.
The Gateway checks a durable per-agent due time on startup and every minute (no
agent-turn cron or separate launchd job). First enablement waits one interval;
restarts preserve the due time and an overdue schedule gets one bounded catch-up,
not one run per missed interval. Each attempt advances the due time before work,
including missing-key skips, failures or interrupted runs, to prevent retry storms.
Changing the interval recalculates the due time from the last scheduled attempt
(or initial enablement). The Gateway must be running; manual audits do not change
the automatic schedule. Missing/unreadable credentials skip all quality and sentiment
inference without failing Gateway startup or normal memory functionality.
Changing the interval does not invalidate cached results. Changing the sentiment
toggle selects a separate reporting cohort, so older missing sentiment is not
treated as neutral; unchanged quality/feedback stages are reused across the toggle.

Operator commands (not agent tools):

```sh
openclaw memory-responses audit --agent main --dry-run
openclaw memory-responses audit --agent main
openclaw memory-responses report --agent main
openclaw memory-responses report --agent main --episode EPISODE_ID
openclaw memory-responses report --agent main --sender SLACK_USER_ID --account ACCOUNT_SCOPE --bucket day --since 2026-09-01 --until 2026-10-01
openclaw memory-responses report --agent main --person PERSON_ID
openclaw memory-responses tasks --agent main
openclaw memory-responses review --agent main --id TASK_ID --status deferred --reviewer human --note "Review the linked exchanges before changing preferences"
openclaw memory-responses annotate --agent main --date 2026-09-18 --kind prompt --note "Known prompt revision deployed"
openclaw memory-responses retry-failed --agent main
```

Reports group by scoped human identity as well as task/model/time. Names are not
identity keys. Existing active people-store links are resolved read-only at assessment
time; missing links do not prevent analysis. Unknown account scopes stay isolated
per session. No new identity fields are sent to TypeSafe. Date ranges are UTC with
an inclusive start and exclusive end. `periodStart` identifies a day/week bucket;
legacy `week`/`fromWeek`/`toWeek` fields remain aliases. `--task-type` and `--model`
further narrow comparisons. Human-specific scores are not rankings of the humans:
task difficulty, feedback habits and selection bias remain important.

Session checkpoints hash bounded active source bytes; unchanged sessions skip
extraction and all inference. Changed sessions are re-extracted within the existing
budget, then stage hashes reuse unchanged quality, feedback, sentiment and later
evidence judgments. Only hashes/counts are checkpointed, never a transcript copy.
A persisted cursor rotates through discovery and tracked-session reconciliation;
`deferredByLimit` includes known backlog and a lower-bound marker for unvisited
sessions. `stages` exposes pending/failed/succeeded counts and exhausted retries
for the cohort/date range, before person filters. `retry-failed` only resets failed
work; successful stages remain cached. Source freshness is checked before activation.

Review tasks distinguish `delivery_quality` shortfalls from `human_experience`
complaints. The latter requires at least 0.8 probability mass at intensity levels
2/3, at least 0.8 combined mass across agent-related/mixed targets, and annoyance
or frustration yes-probability of at least 0.8. It uses grouped probabilities, not
an expected-intensity cutoff or certainty about one precise target. These are
review leads, not proof the agent was at fault. Status can be `pending`, `resolved`,
`dismissed` or `deferred`, with a required review note.
Stable task keys include exchange, scoped human and issue
family. Decisions survive rescoring; stale source evidence and superseded findings
are labeled separately. Review status/provenance never changes the raw judgments.
Tasks and change annotations are operator-only and stay out of memory/whisperer
prompts. `--reviewer` records human/agent provenance, not authentication or a new
permission grant. Task lists disclose their 1,000-item cap. There are no automatic
dossier updates: review the evidence and approve any concrete preference separately.
Old cohorts remain stored; the first staged-cohort run does not silently import
unverified older rubric judgments. Audit-history retention is not automatic.

Separate original-answer and feedback passes prevent human feedback from influencing the original
fulfillment/deliverable-fit grade. The feedback pass distinguishes acceptance,
correction, continuation, unrelated replies, expressed sentiment, repeated constraints
and avoidable rework. Current-index memory investigation runs only for a strong
memory-gap signal: lexical retrieval selects up to three whole short documents from
approved collections. This is an investigation lead, **not proof of historical
availability, factual truth, or agent fault**. Tool-call counts do not establish what
the model saw or whether it should have searched. Unseen artifacts are unassessable.

Deliverable kind/format/scope has its own assessability gate, independent of whether
execution or external facts can be verified. Feedback attribution distinguishes the
current answer, earlier behavior, delivery, missing proactive action, external events,
new work and mixed/unclear targets. A reported forgotten instruction does not prove
searchable memory existed. A third, separate request examines the original exchange,
human feedback and available next assistant block for specific reported shortfalls,
acknowledgment, explicit factual corrections, delivery failures and regressions. These are
retrospective signals, not independently verified facts and never inputs to the
original grade. Clean text preceding a synthetic error/delivery notice can be assessed
as **partial** evidence; the notice itself is excluded and no successful completion
is inferred. Later evidence is capped at six messages/12K characters; incomplete,
unsafe or oversized blocks stay explicitly pending/unavailable/oversized. New later
evidence changes the input hash; only changed assessment stages are re-evaluated,
within normal audit budgets. Successful stages survive failures in later stages.
When the next block is unavailable, the third pass uses only the original exchange
and feedback; it cannot infer a missing delivery from missing later evidence.

Code combines narrow, confident evidence into an **observed outcome**, preserving
its basis and reason. A concrete original-answer shortfall or later admission takes
precedence over praise. Broad reported failures are used only when they do not
depend on a newly introduced requirement. Accurate explanations of earlier mistakes,
ordinary follow-ups, necessary clarification and unseen work are not automatically
failures. Sentiment and earlier-workflow complaints remain separate review signals.
Sentiment includes independent annoyance and frustration yes-probabilities (both
can apply), plus an expressed-dissatisfaction intensity score from 0 to 3. Intensity
means no expressed displeasure / restrained displeasure / pointed complaint /
explicit rejection or loss of trust. It is **not confidence or failure severity**.
External frustration, brevity and factual corrections alone do not establish
annoyance or frustration; mixed praise and complaints can still carry both signals.
Daily/weekly reports show dissatisfaction, annoyance and frustration rates, intensity
means, unknown counts and their own assessment denominators. Unassessed results
are never counted as neutral. Sentiment deltas require 20 samples in both periods
and matching assessment coverage; they remain descriptive, not causal evidence.
Outcome, evidence basis and failure reasons remain distinct: a correction does not
automatically mean `incorrect_claim`. Confident reason judgments and direct
delivery/regression admissions supply reasons; otherwise `reasonStatus` is
`uncertain`. `reasonDetails` retain each label's source and strength, distinguishing
Choice confidence from Noul yes-probability. Multiple supported reasons can coexist.
`reportVersion` identifies composition/reporting semantics independently of the
judge rubric, allowing cached judgments to be re-reported without re-inference.

Results live in operator-only tables in the agent's private
`unblock-memory/unblock-memory.sqlite`, outside the memory index. These tables
are not searched or injected into agent prompts. They store judgments and source event references/hashes, not copies
of conversations. Identical successful inputs are cached; source rewrites invalidate
in-scope results on the next scan. Reports partition by fixed judge/rubric/context
configuration, scoped human, UTC day/week, task type and agent model. They expose eligible/assessed
counts, excluded cases, confidence-qualified score means with per-dimension denominators, rework rates with Wilson
intervals, and evidence IDs. Small groups (<20) are marked explicitly. Confidence
thresholds are provisional, not calibrated guarantees. Human-reviewed evaluation
data is still needed before drawing performance conclusions.
Reports include dated clear-underdelivery examples and reason counts. Descriptive
score deltas compare successive available UTC buckets within the same human, task type,
agent model and rubric/configuration, with at least 20 confident scores per dimension
in each period and unchanged scored coverage; changed coverage withholds the score
delta. Outcome trends show acknowledgment, reported-shortfall and unknown rates
against **all evaluated exchanges**, with at least 20 evaluated exchanges per period.
Read the three rates together: fewer acknowledgments can mean more unknowns, not
more failures. Every delta includes before/after values, sample counts, denominator
and coverage-change flags. Unknown task types/models cannot produce deltas. These
are not statistical change-point detections or proof of causality; model/version
changes remain visible as separate groups rather than silently mixing cohorts.
The legacy `observedSuccessRate` group field remains acknowledgment / known outcomes
for compatibility, but is not used for trends. Unknowns are never successes.
Coverage changes and threshold variability can move rates; acknowledgment is not
factual verification. Week buckets
may be partial, and several exchanges in one session are not independent. Wilson
intervals are descriptive, not calibrated confidence about overall agent ability.

Each run selects at most 100 recent sessions for inference, each at most 2,000 active events/2M
characters; episodes must fit 24K characters and six feedback messages without
truncating the answer. Coverage counts describe the scanned sessions; only episodes
within `lookbackDays` are judged. Caps, failures and no-feedback cases remain visible.
Saved sessions in the report window are also reconciled independently of that
selection, so removing an entire active branch retires its scores. Oversized saved
sessions defer reconciliation rather than being treated as deleted; the report
exposes `reconciledSessions` and `reconciliationDeferred`. All reconciliation shares
the run deadline. Freshness checks compare the assessed episode, not unrelated
later session activity. Actual snapshot races do not exhaust provider retries.
The whole run has a two-minute deadline, at most three provider attempts per input (ten-minute
backoff), and a cross-process lease. Scheduling never starts inference on the agent
turn path or boots a QMD manager. No model downloads or source re-indexing occur.
The report is observational: different task mixes, selective human replies and judge
changes can produce apparent trends. It does not automatically declare regressions,
rewrite prompts, or treat silence as success.
