# People learning

People Whisperer enables private nightly dreaming at **03:10** and complete weekly
validation on **Sunday at 04:00**. Each configured agent owns its jobs, exports,
receipts and resumable backlog. No workspace runbook or external registry is required.

This incorporates the unpublished preference implementation from commits
`278f3ed` and `b21a3f6`: scoped preference storage, assertion-specific evidence
review, per-turn injection, expiry, and before/after dossier history are preserved.

## Configuration

Enable People Whisperer as usual:

```json
{
  "people": {
    "enabled": true,
    "whisperer": { "enabled": true }
  }
}
```

Learning defaults on only when both switches are on. It does not enable TypeSafe,
People Primer, response audits, additional senders, or new corpora.

Optional settings under `people.learning`:

| Setting | Default |
| --- | --- |
| `enabled` | Follows People Whisperer |
| `nightly` / `weekly` | `true` |
| `nightlySchedule` | `10 3 * * *` |
| `weeklySchedule` | `0 4 * * 0` |
| `timezone` | Host `agents.defaults.userTimezone`, otherwise host timezone |
| `agents.<id>` | Per-agent overrides of these settings |
| `legacyJobIds` | Extra exact legacy job IDs, matched with the review runbook signature |

For example:

```json
{
  "people": {
    "enabled": true,
    "whisperer": { "enabled": true },
    "learning": {
      "agents": {
        "research": { "enabled": false },
        "support": {
          "timezone": "Europe/London",
          "nightlySchedule": "30 3 * * *",
          "weeklySchedule": "0 5 * * 0"
        }
      }
    }
  }
}
```

Use `learning.enabled: false` to opt out completely, or `nightly: false` /
`weekly: false` independently. Config owns these schedules; use config rather
than manually editing a plugin-owned job. The global opt-out overrides per-agent enables.

## Review behavior

Nightly inventory covers the previous **completed local calendar day**, not a
rolling 24 hours. Weekly inventory covers the seven completed local days before
the run. DST days can be 23 or 25 hours.

Identities come from each agent's PeopleSQL directory/host observations, matched
by exact provider, account scope and external sender ID. Names never join records.
Synchronize the local directory before rollout. Unknown senders, ambiguous
attribution and missing directory coverage remain source gaps, not guessed people.
Bots are excluded; a human needs trusted host metadata or directory confirmation.
There is no organization-specific roster or fixed sender list.

The native transcript reader scans the session catalog, including reused DMs,
groups and channels. It exports full relevant active exchanges, including later
repair and observable failures. Excluded-account boundaries apply to the whole
exchange. Native external-user input is included; native media references,
non-text content and tainted output require original-source review. Cold,
unready, unreadable, oversized or missing transcripts remain unresolved.
Network-source tool bodies are withheld. Hidden reasoning is excluded without
creating a visible-output gap; delivered assistant media remains explicit work.
It does not claim coverage of messages the host never ingested, attachments it
cannot read, or history unavailable to the native transcript database.

The agent reviews the actual request, its behavior, the human response and repair.
Quality/sentiment are leads under existing approvals. Neutral corrections,
repeated instructions, failed work and positive examples all matter. Missing
feedback is unknown. The agent chooses useful lessons and keeps saved copy concise;
unnecessary caveats do not belong in preferences.

`responseAudit.intervalMinutes: 0` remains manual-only: scheduled reviews can
read cached leads but cannot initiate external analysis.

Explicit preferences retain attribution and scope. Inferred adjustments use
`agent_assessment`, exact sources, `reviewedAt` and `expiresAt`: a seven-day
trial by default, at most thirty days. General execution fixes belong in the
private follow-up queue. Existing notes are not evidence for renewing themselves.

Weekly reviews enumerate every blurb sentence and section claim for people with
activity that week. Source gaps conservatively include all dossiers because
activity is unknown. Every unverified legacy dossier, including prose-only blurbs, triggers full-dossier bootstrap,
including inactive records; missing scope/review dates and legacy inferred profiles
are excluded from injection until verified. Legacy dates alone are not verification:
the whole dossier is withheld until a source-verified revision or complete validation receipt
before default injection resumes. Paused/inactive people remain
review-only. No restoration or injection-permission changes occur.

## Scheduling and migration

Validated against the installed **OpenClaw 2026.11.5** SDK (Node 24.22.1).
Its installed-plugin service context exposes `getCron()`. The runtime forwards
full cron declarations through the host normalizer, including `agentId`,
`agentTurn.message`, `delivery.mode` and `declarationKey`, despite narrower
TypeScript input types. The plugin uses this service-owned API, not
bundled-only `scheduleSessionTurn`, private host imports, SQLite scheduler writes,
or a shell cron.

Stable declaration keys are:

```text
unblock-memory:people-learning:<agentId>:nightly
unblock-memory:people-learning:<agentId>:weekly
```

Startup and cron/config reload reconcile these declarations. Failed reconciliation
retries through the host service scheduler when available. Existing jobs named
“People Whisperer — nightly dreaming and interaction learning” and
“People Whisperer — full weekly statement validation” are replaced only for
their exact configured owning agent. Extra IDs require the matching runbook
signature. The SDK cannot update declaration keys: keyed replacements are created
disabled, legacy jobs are disabled, then replacements are enabled. Original job IDs,
creation times and scheduler history remain on the disabled originals. Duplicates are
disabled, never deleted; unrelated jobs are untouched. Previously disabled legacy
jobs remain paused; set `learning.agents.<id>.enabled: true` to resume deliberately.

The conventional workspace `logs/people-reflection/backlog.json`, when present,
is copied into a private, content-addressed legacy backlog item. It is not
silently cleared. Imports require an exact `agentId` in the backlog or a workspace
owned by exactly one configured agent. Shared, unowned backlogs remain unresolved
without copying their contents into another agent's state. An unchanged import
retains its first-seen metadata across review days and kinds. Existing legacy
receipts and runbooks remain untouched.

Older hosts without service `getCron` log scheduling as incomplete; upgrade
before fleet rollout. Host cron must be enabled and normal scheduled-tool policy
must permit these tools. The plugin does not grant tool approvals.

## Private progress and coverage

State is discovered through host service/agent resolvers:

Here, `<agent-state>` is `<stateDir>/agents/<agentId>/unblock-memory/`.

- `<agent-state>/unblock-memory.sqlite`: append-only inventory snapshots, receipt history,
  latest dispositions, recorded analysis attempts and backlog.
- `<agent-state>/people-learning/`: private JSON manifests and raw exports
  (directories 0700, files 0600), outside indexed corpus roots.

The scheduling prompt and inventory/coverage helpers ship in the package.
`memory_people_learning` exists only in exact owned cron sessions. It supports
`inventory`, `inspect`, `signals` and incremental `checkpoint` operations.
The returned receipt schema defines the required fields. Checkpoints merge
dispositions without clearing omitted work; completed later dates never clear
older unfinished runs. Missed daily/weekly windows since the last recorded run
become pending inventory entries; inspecting one materializes its sources.
Inspecting incomplete runs refreshes recovered sources and expands their backlog.
Original exports, assertions and run start dates remain in history; changed sources
require fresh review rather than inheriting old dispositions. Newly saved weekly
assertions are added before checkpoint coverage is accepted. Receipt history is
append-only; rejected attempts do not replace valid resumable progress.
Rejected attempts also leave the last accepted completion status intact.
Resumed windows keep their original timezone after configuration changes.
Full-validation completion is published only after dossier verification persists;
legacy dossiers without revision history receive a baseline snapshot, without
rewriting their contents or original dates. Failed verification remains backlog.
Revalidation dates live in the receipts and verification records; unchanged
claim dates and expiries are not renewed. Completion is conditional on the exact
staged inventory still being current. Analysis completion is bound to its
approved cohort and inventory revision.

Every nightly person/session and weekly saved assertion needs a disposition.
Missing work is partial; malformed or unverified dispositions are invalid.
Unresolved sources and failed/deferred analysis remain backlog. Verified dates
cannot precede the inventory or lie in the future. Corrected/retired statements
must actually change in the people store and have real change IDs. The agent
still owns evidence interpretation; coverage checks cannot prove a model read
or understood a source correctly.

Cron delivery and failure alerts are disabled. Scheduled tools are restricted to
source reads, people inspection/curation and the private review tool. A tool-call
guard blocks sends, exec, spawning, configuration changes, and changes to
paused/inactive people.

Operator inspection:

```sh
openclaw memory-people-learning inventory --agent AGENT_ID --kind nightly
openclaw memory-people-learning status --agent AGENT_ID
openclaw memory-people-learning status --agent AGENT_ID --run weekly:YYYY-MM-DD
node scripts/people-review-coverage.mjs MANIFEST_JSON RECEIPT_JSON
```

Inventory writes a private resumable snapshot, never preferences. `--date
YYYY-MM-DD` selects a completed local day for backfill. The standalone checker
validates coverage; the live checkpoint additionally verifies saves and actual
analysis attempts.

## Later fleet rollout

1. Use release `0.12.0`, or build its exact tagged source on Node 24.22.1 with the
   supported OpenClaw SDK:
   `npm ci && npm run build && npm run typecheck && npm test && npm pack`.
   Package publication and fleet deployment are separate operations.
2. Back up every target agent's `unblock-memory.sqlite`, legacy people database
   if present, and the host scheduler state. Keep the prior package for rollback.
3. Upgrade target hosts to OpenClaw 2026.11.5 or a requalified compatible version.
   Install the reviewed tarball with `openclaw plugins install /absolute/path/package.tgz`.
4. Merge the People Whisperer settings above into
   `plugins.entries.unblock-memory.config`. Preserve existing hook permissions,
   tool policies, corpus approvals, TypeSafe settings and response-audit sender
   approvals. Set the host timezone or explicit per-agent overrides.
5. Synchronize exact local identities using the existing PeopleSQL directory
   workflow (`memory_people_sync` where approved). Confirm the roster, accounts,
   and any nonstandard legacy job IDs.
6. Restart the target Gateway in the approved rollout window. Check
   `openclaw plugins inspect unblock-memory --runtime --json` and
   `openclaw cron list --all --json`: exactly two intended declarations per
   participating agent, correct timezone, isolated session, delivery none.
7. Run one owned job with `openclaw cron run JOB_ID` in the pilot window.
   Inspect `memory-people-learning status --agent AGENT_ID`, actual save
   history, privacy controls and unresolved work before expanding the rollout.
   A green scheduler run alone is not review completion.
8. To stop learning, set `people.learning.enabled: false` and reload/restart.
   Jobs are disabled and history remains. Before reverting the package, disable
   its declarations; restore a database backup only if an approved rollback
   requires it.
