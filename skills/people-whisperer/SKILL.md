---
name: people-whisperer
description: Remember who each person is, their interaction preferences, and evidence-backed lessons from working with them. Curate feedback during nightly dreaming and revalidate every saved statement weekly.
---

# People Whisperer

Help future sessions recognize the person and work better with them. Save specific,
scoped adjustments grounded in actual exchanges. The agent decides which lessons
are useful, and distinguishes explicit human preferences from its own hypotheses.

## Review feedback during nightly dreaming

Identify the exact Slack account/sender with `memory_people_inspect` view `person`.
Read their current dossier before replacing it. During nightly dreaming, review
continuing interaction preferences and corrections from the day's exchanges.
Decide which updates are useful and save verified changes. Preserve other
verified claims and their original scope. A one-off task request is not automatically
a permanent preference. If duration is ambiguous, use the narrowest supported scope.

Research original sources using `memory_people_prime`, `memory_search` and
`memory_get`. The primer covers identity, organization, agent relationship,
preferences and working-style feedback, including corrections. Sync sessions with
`memory_sync_sessions` and inspect `memory_sync_status` when needed. Existing
dossiers and the agent's earlier assertions are not independent evidence. Do not
send evidence outside the approved corpora to the decision endpoint.

## Store a compact, sourced dossier

Keep the `blurb` an identity/background paragraph of at most 70 words. Store each
ongoing preference separately under `preferences` or `workingStyle`; these sections
are also supplied to the agent. New dossiers allow `role`, `relationship`,
`preferences` and `workingStyle` sections. Cite original evidence for EVERY claim.
Use `scope` to retain channel, project or interaction limits, and `reviewedAt` for
the actual last verification time. Source `observedAt` is the source's time, not the
review time. Preserve source attribution and uncertainty.

Explicit human preferences use `reported` (or directly observed facts use
`observed`). Agent-derived improvements use `agent_assessment`, an explicit scope,
`reviewedAt`, and `expiresAt` no more than 30 days later; default to a seven-day
trial. These are provisional agent lessons, never human-stated instructions. Decide
whether a small, reversible adjustment is justified by the complete exchange.
Do not infer psychological traits, emotions as enduring personality, permissions,
or new responsibilities. Sentiment alone does not establish the desired adjustment.

Use `memory_people_update` action `replace_dossier` with a complete replacement
and a concise reason. The tool reviews the identity blurb and every stored claim
against its own evidence. Indexed evidence needs exact `qmd://path#Lstart-Lend`
references (1–3 per assertion, at most 120 lines each and 6,000 characters total).
A failed, uncertain or unavailable review leaves the dossier unchanged.

For direct feedback in the current conversation, authoritative directory data,
non-indexed evidence or an unavailable/incorrect automated review, use a
source-specific `manualVerification` ONLY after independently checking every
retained assertion, attribution, scope and any newer corrections. Record the
original Slack message/account/sender/time or authoritative source; do not invent
indexed citations. Manual verification is recorded as manual, not a provider pass.

If a concurrent change returns `conflict`, inspect again and merge deliberately.
Respect the configured combined-context character limit. Never silently drop
preferences merely to fit a new claim. Only actionable claims and the blurb are
injected; evidence and full change history remain in storage. Expired claims are
omitted from injection automatically. Context refreshes on every user turn; a retry
of the exact same run replays its original snapshot.

## Nightly dreaming: did I show up well for each teammate?

Use `memory_people_learning` action `inventory`, kind `nightly`, in the private
plugin-owned review session. Follow its manifest and exact local identities. Review every
team member's interactions in the completed local day, plus unfinished review
backlog. Record people with no interactions rather than inventing observations.
Use response-quality/sentiment reports to find leads, then read the full relevant
request, agent response, human reaction and subsequent repair in original sessions.
Also inspect neutral corrections, explicit preferences, repeated constraints,
avoidable rework and examples that worked well. No complaint is not proof of success.

Ask: what did the person need, what did I do, how did they respond, and what
specific adjustment would improve the next relevant interaction? Separate agent
execution/delivery mistakes, changing requirements and external frustration from
personal interaction preferences. Record general execution fixes as agent work;
keep person dossiers focused on how to collaborate with that person.
Keep saved lessons concise; do not add unnecessary or irrelevant caveats.

The agent decides whether to save an explicit preference, trial an inferred lesson,
revise an existing claim, or make no change. Check for newer contradictions and
avoid duplicates. Preserve what worked. Do not learn blanket avoidance, unsupported
personality labels, authority grants, or misleading explanations of an error.
Revisit earlier provisional lessons; retain only evidence-supported adjustments,
revise ineffective ones, and let unconfirmed trials expire. Never extend an expiry
merely because the lesson was already saved.

## Complete weekly validation

Use `memory_people_learning` action `inventory`, kind `weekly`. The manifest
enumerates every statement for people with activity in the past completed local
week, plus unverified legacy dossiers for bootstrap. Source gaps conservatively
include all dossiers. Enumerate people with `memory_people_inspect` view `people`,
`includeInactive: true`, following every page, to reconcile any concurrent additions.
Never reactivate anyone or change injection permissions during an audit.
For each assertion in the blurb AND every section, inspect its original evidence
and search for newer changes, contradictions, retractions, completed contexts or
superseding feedback. Old evidence can still be valid; age alone is not staleness.
A previous saved statement is never evidence for retaining itself.

Classify every statement as revalidated, corrected, retired, or unresolved.
Update `reviewedAt` only after actual verification. Remove contradicted, superseded,
expired or unsupported claims from the active dossier; replacements/deletions retain
before/after history and reasons. Preserve independently verified claims. If all
useful claims are invalid, delete the dossier with an evidence-based reason. For
inactive people, inspect/report needed changes without restoring or enabling them.
Do not pretend a source/provider outage proves a claim false; mark it unresolved
and retain an explicit backlog for retry. Do not reset its review date.

Checkpoint with `memory_people_learning`, preserving its run ID and receipt schema.
Use `inspect` to resume each pending run and `signals` with its run ID for approved
analysis. Include person/claim coverage counts, dispositions, source
references, actual save results, gaps and carried backlog. A run is fully complete
only when every existing statement has a disposition; a time limit is partial,
never success-by-sampling. Resume unfinished people first next time. Recheck all
current claims for every person active that week, even if their dossier is unchanged.
An old backlog remains pending even after a later run completes.

## State and reporting

Use `delete_dossier` for an invalid dossier; preserve raw memory and change history.
Respect paused, archived and unavailable people. Restore and injection changes are
separate deliberate operations. Report saved snippets, concrete adjustments,
retired claims, evidence limitations and unresolved work. Do not send team messages
or modify configuration/schedules from maintenance runs.
