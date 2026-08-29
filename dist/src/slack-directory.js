import { inspectReadOnlyChannelAccount } from "openclaw/plugin-sdk/directory-runtime";
function text(value, maxLength) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function slackToken(account) {
    return text(account.userToken, 10_000) ?? text(account.botToken, 10_000);
}
function slackEntry(value) {
    const member = record(value);
    const id = text(member?.id, 200);
    if (!id)
        return undefined;
    const profile = record(member?.profile);
    return {
        id,
        name: text(profile?.display_name, 500) ??
            text(profile?.real_name, 500) ??
            text(member?.real_name, 500) ??
            text(member?.name, 500),
        handle: text(member?.name, 200),
        avatarUrl: text(profile?.image_512, 2_000) ??
            text(profile?.image_192, 2_000) ??
            text(profile?.image_72, 2_000),
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
            const account = await inspectAccount({ channelId: "slack", cfg, accountId });
            const token = account ? slackToken(account) : undefined;
            if (!token) {
                throw new Error(`Slack credentials for account "${accountId}" are unavailable in the active runtime snapshot`);
            }
            const entries = [];
            const cursors = new Set();
            let cursor;
            while (entries.length < limit) {
                const url = new URL("https://slack.com/api/users.list");
                url.searchParams.set("limit", String(Math.min(limit, 200)));
                if (cursor)
                    url.searchParams.set("cursor", cursor);
                const response = await request(url, {
                    headers: { authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(30_000),
                });
                const payload = record(await response.json());
                if (!response.ok || payload?.ok !== true) {
                    const detail = text(payload?.error, 200) ?? `HTTP ${response.status}`;
                    throw new Error(`Slack directory request failed: ${detail}`);
                }
                const members = Array.isArray(payload.members) ? payload.members : [];
                for (const member of members) {
                    const entry = slackEntry(member);
                    if (entry)
                        entries.push(entry);
                    if (entries.length === limit)
                        break;
                }
                const next = text(record(payload.response_metadata)?.next_cursor, 2_000);
                if (!next)
                    break;
                if (cursors.has(next))
                    throw new Error("Slack directory returned a repeated cursor");
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
        const externalId = text(entry.id, 200);
        if (!externalId) {
            counts.skipped += 1;
            continue;
        }
        try {
            const existing = params.store.findIdentity("slack", params.accountId, externalId);
            if (existing && params.store.getPerson(existing.personId)?.status !== "active") {
                counts.skipped += 1;
                continue;
            }
            const changed = existing !== undefined &&
                ((entry.name !== undefined && entry.name !== existing.displayName) ||
                    (entry.handle !== undefined && entry.handle !== existing.handle) ||
                    (entry.avatarUrl !== undefined && entry.avatarUrl !== existing.avatarUrl));
            const result = params.store.upsertIdentity({
                provider: "slack",
                accountScope: params.accountId,
                externalId,
                displayName: entry.name,
                handle: entry.handle,
                avatarUrl: entry.avatarUrl,
                syncedAt,
            });
            if (result.created)
                counts.created += 1;
            else if (changed)
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
