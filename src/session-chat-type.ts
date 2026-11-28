// Plain module (no `openclaw` import): loaded by the Gateway hooks and by plain-Node steward workers alike.

export type SessionChatType = "direct" | "group" | "channel";

const CHAT_TYPES = new Set(["direct", "group", "channel", "dm"]);

function asChatType(segment: string | undefined): SessionChatType | undefined {
  const lower = segment?.trim().toLowerCase();
  if (!lower || !CHAT_TYPES.has(lower)) return undefined;
  return lower === "dm" ? "direct" : lower as SessionChatType;
}

/**
 * Best-effort chat type from a session key when the host supplied none: strips an optional `agent:<id>:` prefix first
 * so the agent id itself can never be mistaken for a chat type, then parses canonical per-peer (`direct:<peer>`,
 * `dm:<peer>`), provider-scoped (`<provider>:<type>:<id>`), and account-scoped (`<provider>:<account>:<type>:<id>`)
 * positions (`direct`, `dm` -> `direct`, `group`, `channel`), plus untyped main DM keys (`agent:<id>:main`, `main`).
 * Ambiguous keys where both positions name different types fail closed (`"direct"` if either side is direct, else
 * `undefined`). Synthetic keys (`agent:<id>:cron:…`, `agent:<id>:subagent:…`, custom `agent:<id>:inbox`) stay `undefined`.
 */
export function chatTypeFromSessionKey(sessionKey: string | null | undefined): SessionChatType | undefined {
  const key = sessionKey?.trim();
  if (!key) return undefined;
  const parts = key.split(":");
  let rest: string[];
  if (parts[0]?.trim().toLowerCase() === "agent") {
    if (parts.length < 3 || !parts[1]?.trim()) return undefined;
    rest = parts.slice(2);
  } else {
    rest = parts;
  }
  if (rest.length === 1) return rest[0]?.trim().toLowerCase() === "main" ? "direct" : undefined;
  const head = rest[0]?.trim().toLowerCase();
  if (!head || head === "agent" || head === "cron" || head === "subagent") return undefined;
  // Per-peer DM (`dmScope=per-peer`): `[agent:<id>:]direct:<peerId>` or legacy `dm:<peerId>`.
  if ((head === "direct" || head === "dm") && rest.slice(1).join(":").trim()) return "direct";
  // Standard `<provider>:<chatType>:<id>…` vs account-scoped `<provider>:<account>:<chatType>:<id>…`.
  const direct = rest.length >= 3 && rest.slice(2).join(":").trim() ? asChatType(rest[1]) : undefined;
  const scoped = rest.length >= 4 && rest[1]?.trim() && rest.slice(3).join(":").trim() ? asChatType(rest[2]) : undefined;
  if (direct && scoped && direct !== scoped) {
    // Never classify an ambiguous key (e.g. account named `group` on a DM `slack:group:direct:u1`) as shared.
    return direct === "direct" || scoped === "direct" ? "direct" : undefined;
  }
  return direct ?? scoped;
}
