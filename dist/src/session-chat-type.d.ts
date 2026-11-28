export type SessionChatType = "direct" | "group" | "channel";
/**
 * Best-effort chat type from a session key when the host supplied none: strips an optional `agent:<id>:` prefix first
 * so the agent id itself can never be mistaken for a chat type, then parses canonical per-peer (`direct:<peer>`,
 * `dm:<peer>`), provider-scoped (`<provider>:<type>:<id>`), and account-scoped (`<provider>:<account>:<type>:<id>`)
 * positions (`direct`, `dm` -> `direct`, `group`, `channel`), plus untyped main DM keys (`agent:<id>:main`, `main`).
 * Ambiguous keys where both positions name different types fail closed (`"direct"` if either side is direct, else
 * `undefined`). Synthetic keys (`agent:<id>:cron:…`, `agent:<id>:subagent:…`, custom `agent:<id>:inbox`) stay `undefined`.
 */
export declare function chatTypeFromSessionKey(sessionKey: string | null | undefined): SessionChatType | undefined;
