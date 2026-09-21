# People Whisperer: Agent-Owned Dossiers

Status: implemented direction, recorded 2026-09-18. The living documentation is
[People dossiers and whispering](../peoplesql.md), with the canonical agent
procedure in the [packaged People Whisperer skill](../../skills/people-whisperer/SKILL.md).

## Decision

The agent owns dossier research, writing and maintenance. The plugin stores people,
exact identities, background-only dossiers and durable injection receipts; it
matches the Slack speaker and injects the saved blurb. The optional TypeSafe
primer/reviewer assists evidence selection and checks, not dossier generation.

Recognition snippets describe explicit identity, organization and person-agent
relationship—not behavioral profiles or task history. Unknown background may stay
unknown, and a maintenance cycle may correctly update nobody.

The plugin does not own a dossier refresh schedule, cursor, dirty queue, evidence
packet or refinement workflow. An operator can invoke the packaged skill manually
or through an existing agent automation. Current limits, tool contracts, save-review
gates, privacy approvals and state operations belong in the linked living references,
rather than duplicated in this historical decision record.

Broader entity whispering and consolidation designs remain planning material.
