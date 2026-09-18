export function resolveResponseAudit(value, corpora) {
    const defaults = { enabled: false, sentimentEnabled: true, senderIds: [], chatTypes: ["direct"],
        historyMessages: 6, lookbackDays: 30, maxEpisodes: 20, intervalMinutes: 60, memoryCorpora: [] };
    if (value === undefined)
        return defaults;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("responseAudit must be an object");
    const v = value;
    for (const key of Object.keys(v))
        if (!Object.hasOwn(defaults, key))
            throw new Error(`unknown responseAudit property: ${key}`);
    const enabled = v.enabled ?? false;
    if (typeof enabled !== "boolean")
        throw new Error("responseAudit.enabled must be boolean");
    const sentimentEnabled = v.sentimentEnabled === undefined ? true : v.sentimentEnabled;
    if (typeof sentimentEnabled !== "boolean")
        throw new Error("responseAudit.sentimentEnabled must be boolean");
    const strings = (key) => {
        const raw = v[key] ?? defaults[key];
        if (!Array.isArray(raw) || raw.length > 50 || !raw.every((x) => typeof x === "string" && !!x.trim())) {
            throw new Error(`responseAudit.${key} must be a bounded string array`);
        }
        return [...new Set(raw.map(x => x.trim()))];
    };
    const senderIds = strings("senderIds"), chatTypes = strings("chatTypes"), memoryCorpora = strings("memoryCorpora");
    if (!chatTypes.length || !chatTypes.every((x) => ["direct", "group", "channel"].includes(x))) {
        throw new Error("responseAudit.chatTypes must specify direct, group or channel");
    }
    if (enabled && !senderIds.length)
        throw new Error("responseAudit requires explicit approved human senderIds");
    if (memoryCorpora.some(name => !corpora.some(c => c.name === name && c.kind === "files"))) {
        throw new Error("responseAudit.memoryCorpora must name configured file corpora");
    }
    const integer = (key, min, max) => {
        const n = v[key] ?? defaults[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
            throw new Error(`invalid responseAudit.${key}`);
        return n;
    };
    return { enabled, sentimentEnabled, senderIds, chatTypes, memoryCorpora, historyMessages: integer("historyMessages", 0, 20),
        lookbackDays: integer("lookbackDays", 1, 90), maxEpisodes: integer("maxEpisodes", 1, 100),
        intervalMinutes: integer("intervalMinutes", 0, 1440) };
}
