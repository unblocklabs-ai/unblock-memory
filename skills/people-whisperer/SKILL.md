---
name: people-whisperer
description: Maintain useful PeopleSQL dossiers from ordinary memory and session evidence so future conversations start with accurate person context.
---

# People Whisperer

Improve the agent's durable understanding of people it interacts with. Prefer no
write over routine, repetitive, weakly inferred, or already captured information.
The goal is a useful future conversation, not processing every interaction.

## Choose and inspect

- For a named or current person, call `memory_people_inspect` with
  `view: "person"` and their `personId` or exact Slack identity.
- For autonomous maintenance, call `memory_people_inspect` with
  `view: "people"` and an optional `limit`. Use the returned identity,
  `lastSeenAt`, dossier presence, and dossier `reviewedAt` only as context for
  your judgment. `reviewedAt` is the last dossier write, not a due date.
- Do not assume every listed person needs work. You may update several people or
  nobody.

## Investigate

1. Read the current dossier when one exists.
2. Search for meaningful information with `memory_search`. Use targeted queries,
   relevant corpora, and session metadata filters rather than treating a fixed
   recent-message window as the person's history.
3. Follow useful `qmd://` results with `memory_get`. If recent OpenClaw sessions
   are not indexed, use `memory_sync_sessions` and check `memory_sync_status`
   before searching again.
4. Prefer direct statements, repeated behavior, decisions, feedback, and
   outcomes. Distinguish observation, reported information, inference, and agent
   assessment. Do not promote small talk or one ambiguous exchange into a durable
   claim.
5. Preserve still-useful existing claims. Dossier replacement is complete, not
   a patch.

Ordinary `memory_search` supports multiple targeted calls and up to 20 results
per call. People Whisperer does not impose its own result window or require the
agent to acknowledge what it inspected.

## Write only when useful

Call `memory_people_update` with `action: "replace_dossier"`, the `personId`, a
concise `reason` for the change, and a complete dossier. The plugin records the
reason and exact before/after snapshots transactionally. Keep the complete dossier
under the plugin's 64 KiB serialized limit:

```json
{
  "action": "replace_dossier",
  "personId": "PeopleSQL person ID",
  "reason": "Added a durable preference supported by recent sessions.",
  "dossier": {
    "schemaVersion": 1,
    "blurb": "Concise context worth having before the next conversation.",
    "sections": [
      {
        "category": "preferences",
        "claims": [
          {
            "statement": "A durable, specific claim.",
            "evidence": [
              {
                "source": "session",
                "locator": "qmd://path-returned-by-memory-search",
                "observedAt": "2026-08-31T12:00:00Z"
              }
            ],
            "epistemicType": "observed",
            "confidence": "high"
          }
        ]
      }
    ]
  }
}
```

Allowed section categories are `role`, `priorities`, `preferences`,
`successCriteria`, `workingStyle`, `relationship`, and `openLoops`. Evidence
sources are `session`, `memory`, `directory`, or `manual`; `observedAt` and
`confidence` are optional. Epistemic types are `observed`, `reported`,
`inferred`, or `agent_assessment`.

Make the blurb immediately useful, concise, and honest about uncertainty. Do not
stuff it with biography or raw evidence. Claim evidence references are
provenance, not work receipts.

Use `delete_dossier` when the current dossier is too unreliable to inject and
cannot be responsibly repaired; deletion also requires a concise `reason`. Use
`memory_people_inspect` with `view: "dossier_changes"`, the `personId`, and
optional `limit`/`offset` to list small newest-first history summaries. Follow a
summary with `view: "dossier_change"`, the `personId`, and its `changeId` only
when you need the exact before/after dossier and blurb. Follow `nextOffset` to page.
Use `set_injection` to disable or re-enable
whispers for one person without deleting their dossier. Company, todo, and
person-status actions are available for the corresponding data changes.

## Finish

Report whom you investigated, which memory or sessions informed any write, what
changed, and why skipped people did not need an update. Do not manufacture a
write to show activity.
