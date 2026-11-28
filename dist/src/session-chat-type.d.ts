export type SessionChatType = "direct" | "group" | "channel";
/**
 * Best-effort chat type from a session key when the host supplied none: a typed `:direct:` / `:group:` / `:channel:`
 * segment as before, `:dm:` as `direct`, and the exact untyped main DM keys (`agent:<id>:main`, `main`) as `direct`.
 * Synthetic keys (`agent:<id>:cron:…`, `agent:<id>:subagent:…`, …) carry no chat type and stay `undefined`.
 */
export declare function chatTypeFromSessionKey(sessionKey: string | null | undefined): SessionChatType | undefined;
