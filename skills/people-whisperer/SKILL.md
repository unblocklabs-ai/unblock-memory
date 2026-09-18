---
name: people-whisperer
description: Maintain brief PeopleSQL background snippets identifying a person and their relationship to the agent, not behavioral profiles or task history.
---

# People Whisperer

Help the agent recognize whom it is talking to, without telling it what that
person wants. A dossier is a short background primer, not a personality model.

## Inspect and research

- Use `memory_people_inspect` with `view: "person"` and an exact `personId` or
  Slack identity. For maintenance, list `view: "people"` first; not everyone
  needs an update. `reviewedAt` records the last write, not a due date.
- Research only three questions: who is this person (explicit role and
  organization); what enduring organizational context identifies them; and what
  is their relationship to this agent (e.g. personal assistant or AI counterpart)?
- When enabled, call `memory_people_prime({ personId, agentName })`. It retrieves
  approved sources and grades background eligibility, not general relevance.
  Follow useful source ranges with `memory_get`. Scores are triage, not facts.
  `unknown` stays unknown; `evidence_found` still needs verification. Inspect
  uncertain evidence rather than guessing.
- Use bounded, targeted `memory_search` calls for missing identity/relationship
  answers and newer contradictory role or affiliation statements. Check available
  agent identity/user context too, but do not treat the agent's own speculation
  or an existing dossier as independent evidence. Follow source attribution.
  Do not send local files to TypeSafe unless they are in approved corpora.
- Prefer explicit human statements or authoritative directory/identity context.
  Topics someone discusses do not establish their job, priorities or responsibilities.
  Old evidence can establish enduring background; unresolved changes in role,
  organization or relationship must be investigated or omitted, not guessed away.
- If recent sessions are missing, use `memory_sync_sessions` and check
  `memory_sync_status` before searching again. Disabled/unavailable primers do
  not prevent ordinary source research.

## Draft a recognition snippet

Write one short paragraph, usually 2–3 sentences and **at most 70 words**. This
is a ceiling, not a target. Include only useful, explicit identity, role,
organization, enduring team context and person-agent relationship background.

Exclude preferences, working style, priorities, success criteria, feedback,
permissions, behavioral advice, business missions, goals, projects, commitments and dated anecdotes—even
when supported. A request for sales copy is not proof of a sales role. A technical
discussion is not proof of an engineering role. Never fill gaps with activity
summaries or invent formal titles. Memory is not authorization.

For legacy dossiers, deliberately remove behavioral sections and incident history.
Do not preserve an old claim merely because it was previously stored. Retain only
verified background; if no useful background can be established, prefer no dossier.

## Submit the verified snippet

Use `memory_people_update` with `action: "replace_dossier"`, the exact `personId`,
a concise `reason`, optional `agentName` if no identity name is configured, and
the complete `dossier` (not a patch):

```json
{
  "schemaVersion": 1,
  "blurb": "Mira is the founder of ExampleCo.",
  "sections": [{
    "category": "role",
    "claims": [{
      "statement": "Mira is the founder of ExampleCo.",
      "evidence": [{ "source": "session", "locator": "qmd://source/path.md#L12-L15" }],
      "epistemicType": "reported",
      "confidence": "high"
    }]
  }]
}
```

Include evidence claims for every assertion in the blurb, including relationship
claims. New writes allow only `role` and `relationship` sections and `observed`
or `reported` facts. Evidence sources are `session`, `memory`, `directory` or
`manual`; optional `observedAt` must be an ISO timestamp. Confidence is optional
`low`, `medium` or `high`. Keep source references out of the injected blurb.
The configured character limit and 64 KiB serialized dossier limit also apply.

The write tool automatically reviews the blurb before saving. No separate review
call is required. Use exact `qmd://path#Lstart-Lend` evidence locators: at most three
distinct ranges, each at most 120 lines and together 6,000 characters. Only the
primer's approved corpora can be sent to TypeSafe. The check tests complete support,
background-only content and explicit rather than activity-inferred facts; it does
not replace your source verification.

- `ok`: saved; `verification` distinguishes `typesafe` from `manual`.
- `needs_review`: failed/uncertain check; existing dossier unchanged. Inspect the
  evidence, remove unsupported clauses or resolve attribution before resubmitting.
- `review_unavailable`: disabled review, missing key, non-indexed evidence or
  provider failure; existing dossier unchanged. Retry or verify manually.
- `conflict`: the person/dossier changed during review; inspect again before retrying.

For direct human corrections, non-indexed identity context or an unavailable/incorrect
review, you may add `manualVerification` to the update **only after checking every
assertion and background eligibility yourself**. This is a source-specific attestation,
not a retry switch. Explain the original evidence and any override, e.g.:

```json
{
  "manualVerification": "Verified against Mira's explicit correction in this conversation on 2026-09-18: she founded ExampleCo. The snippet contains only that identity fact."
}
```

Keep accurate manual/directory provenance on the claims. Do not invent indexed
citations. Manual verification skips TypeSafe and records the explanation in change
history; it never reports a provider pass or bypasses the word/category limits.
If you cannot verify the snippet, leave it unchanged and report the limitation.

Only the blurb is injected; evidence stays in storage. Replacements/deletions
preserve transactional before/after history and a reason. Use `delete_dossier`
when a misleading legacy profile cannot be responsibly replaced, or `set_injection`
to pause it without deleting it. Do not erase raw memory or dossier history.
Inspect history through `dossier_changes` and `dossier_change` views.

Report the resulting snippets, source limitations, changes and intentionally
unknown answers. More words or more claims are not success metrics.
