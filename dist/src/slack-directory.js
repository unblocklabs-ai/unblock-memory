import { DEFAULTS } from "./defaults.js";
import { inspectReadOnlyChannelAccount } from "openclaw/plugin-sdk/directory-runtime";
import { nonBlank, record } from "./guards.js";
function displayName(value) {
    return nonBlank(value)?.slice(0, DEFAULTS.people.slackDisplayNameMaxChars)
        .replace(/\p{Cs}/gu, "").trimEnd() || undefined;
}
function opaqueValue(value, maxChars) {
    return typeof value === "string" && value.length > 0 && value.length <= maxChars &&
        !/[\s\p{Cc}\p{Cs}]/u.test(value) ? value : undefined;
}
function slackAvatarUrl(value) {
    const url = opaqueValue(value, DEFAULTS.people.slackAvatarUrlMaxChars);
    if (!url || !/^https?:\/\//iu.test(url))
        return undefined;
    try {
        const parsed = new URL(url);
        return parsed.username || parsed.password ? undefined : url;
    }
    catch {
        return undefined;
    }
}
function slackToken(account) {
    const key = account.userToken === undefined ? "botToken" : "userToken";
    const value = account[key];
    if (value === undefined)
        return undefined;
    const token = opaqueValue(value, DEFAULTS.people.slackTokenMaxChars);
    if (!token || !/^[!-~]+$/u.test(token)) {
        throw new Error(`Slack directory account has an invalid ${key}`);
    }
    return token;
}
function paginationCursor(value) {
    if (value === undefined)
        return undefined;
    const metadata = record(value);
    const cursor = metadata?.next_cursor;
    if (metadata && (cursor === undefined || cursor === ""))
        return undefined;
    const next = opaqueValue(cursor, DEFAULTS.people.slackCursorMaxChars);
    if (!next)
        throw new Error("Slack directory returned an invalid cursor");
    return next;
}
function slackEntry(value) {
    const member = record(value);
    const id = opaqueValue(member?.id, DEFAULTS.people.slackIdMaxChars);
    if (!id)
        return undefined;
    const profile = record(member?.profile);
    return {
        id,
        name: displayName(profile?.display_name) ??
            displayName(profile?.real_name) ??
            displayName(member?.real_name) ??
            displayName(member?.name),
        handle: opaqueValue(member?.name, DEFAULTS.people.slackHandleMaxChars),
        avatarUrl: slackAvatarUrl(profile?.image_512) ??
            slackAvatarUrl(profile?.image_192) ??
            slackAvatarUrl(profile?.image_72),
        isBot: typeof member?.is_bot === "boolean" ? member.is_bot : undefined,
        isDeactivated: typeof member?.deleted === "boolean" ? member.deleted : undefined,
    };
}
export function createOpenClawSlackDirectory(params) {
    const inspectAccount = params.inspectAccount ?? inspectReadOnlyChannelAccount;
    const request = params.request ?? fetch;
    return {
        async listUsers({ accountId, limit }) {
            const cfg = params.getConfig();
            if (!cfg)
                throw new Error("OpenClaw runtime config is unavailable");
            const account = await inspectAccount({ channelId: "slack", cfg, accountId }).catch(() => {
                throw new Error("OpenClaw could not inspect the Slack directory account");
            });
            const token = account ? slackToken(account) : undefined;
            if (!token) {
                throw new Error("Slack credentials are unavailable in the active runtime snapshot");
            }
            const entries = [];
            const cursors = new Set();
            let cursor;
            while (entries.length < limit) {
                const url = new URL(DEFAULTS.people.slackApiUrl);
                url.searchParams.set("limit", String(Math.min(limit, 200)));
                if (cursor)
                    url.searchParams.set("cursor", cursor);
                const response = await request(url, {
                    headers: { authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(DEFAULTS.people.slackTimeoutMs),
                }).catch(() => {
                    throw new Error("Slack directory request failed before receiving a response");
                });
                const payload = record(await response.json().catch(() => {
                    throw new Error("Slack directory returned an invalid response");
                }));
                if (!response.ok || payload?.ok !== true) {
                    // Do not reflect arbitrary response content back to the tool caller.
                    const detail = ["invalid_auth", "not_authed", "missing_scope", "token_revoked", "account_inactive"]
                        .find(code => code === payload?.error) ?? `HTTP ${response.status}`;
                    throw new Error(`Slack directory request failed: ${detail}`);
                }
                const next = paginationCursor(payload.response_metadata);
                if (next && cursors.has(next))
                    throw new Error("Slack directory returned a repeated cursor");
                const members = Array.isArray(payload.members) ? payload.members : [];
                for (const member of members) {
                    const entry = slackEntry(member);
                    if (entry)
                        entries.push(entry);
                    if (entries.length === limit)
                        break;
                }
                if (!next)
                    break;
                cursors.add(next);
                cursor = next;
            }
            return entries;
        },
    };
}
export async function syncSlackDirectory(params) {
    const entries = await params.reader.listUsers({
        accountId: params.accountId,
        limit: params.limit,
    });
    const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    const syncedAt = params.syncedAt ?? new Date().toISOString();
    for (const entry of entries.slice(0, params.limit)) {
        const externalId = opaqueValue(entry.id, DEFAULTS.people.slackIdMaxChars);
        if (!externalId) {
            counts.skipped += 1;
            continue;
        }
        const name = displayName(entry.name);
        const handle = opaqueValue(entry.handle, DEFAULTS.people.slackHandleMaxChars);
        const avatarUrl = slackAvatarUrl(entry.avatarUrl);
        try {
            const existing = params.store.findIdentity("slack", params.accountId, externalId);
            const existingPerson = existing ? params.store.getPerson(existing.personId) : undefined;
            if (existing && existingPerson?.status !== "active") {
                counts.skipped += 1;
                continue;
            }
            const changed = existing !== undefined &&
                ((name !== undefined && name !== existing.displayName) ||
                    (handle !== undefined && handle !== existing.handle) ||
                    (avatarUrl !== undefined && avatarUrl !== existing.avatarUrl) ||
                    (entry.isBot !== undefined && entry.isBot !== existing.isBot) ||
                    (entry.isDeactivated !== undefined && entry.isDeactivated !== existing.isDeactivated));
            const result = params.store.upsertIdentity({
                provider: "slack",
                accountScope: params.accountId,
                externalId,
                displayName: name,
                handle,
                avatarUrl,
                isBot: entry.isBot,
                isDeactivated: entry.isDeactivated,
                syncedAt,
            });
            if (result.created)
                counts.created += 1;
            else if (changed || result.person.displayName !== existingPerson?.displayName)
                counts.updated += 1;
            else
                counts.unchanged += 1;
        }
        catch {
            counts.failed += 1;
        }
    }
    return {
        status: "ok",
        accountId: params.accountId,
        received: entries.length,
        ...counts,
    };
}
