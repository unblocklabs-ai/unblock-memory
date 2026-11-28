// Plain module (no `openclaw` import): loaded by the Gateway hooks and by plain-Node steward workers alike.

export type SessionChatType = "direct" | "group" | "channel";

const TYPED_SEGMENT = /:(direct|group|channel|dm):/iu;
/** OpenClaw's canonical main DM session (`dmScope=main`): `agent:<id>:main`, or a bare `main`. */
const MAIN_DM_SESSION = /^(?:agent:[^:]+:)?main$/iu;

/**
 * Best-effort chat type from a session key when the host supplied none: a typed `:direct:` / `:group:` / `:channel:`
 * segment as before, `:dm:` as `direct`, and the exact untyped main DM keys (`agent:<id>:main`, `main`) as `direct`.
 * Synthetic keys (`agent:<id>:cron:…`, `agent:<id>:subagent:…`, …) carry no chat type and stay `undefined`.
 */
export function chatTypeFromSessionKey(sessionKey: string | null | undefined): SessionChatType | undefined {
  const key = sessionKey?.trim();
  if (!key) return undefined;
  const typed = TYPED_SEGMENT.exec(key)?.[1]?.toLowerCase();
  if (typed) return typed === "dm" ? "direct" : typed as SessionChatType;
  return MAIN_DM_SESSION.test(key) ? "direct" : undefined;
}
