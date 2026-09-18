import { Type } from "typebox";
import { Value } from "typebox/value";
export const peoplePrimerSchema = Type.Object({
    enabled: Type.Boolean({ default: false }),
    corpora: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
    hitsPerQuestion: Type.Integer({ minimum: 1, maximum: 40, default: 30 }),
    minScore: Type.Number({ minimum: 0, maximum: 1, default: 0.35 }),
    minUsefulness: Type.Number({ minimum: 0.5, maximum: 1, default: 0.8 }),
    maxEvidencePerQuestion: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
    timeoutMs: Type.Integer({ minimum: 1, maximum: 60000, default: 30000 }),
}, { additionalProperties: false });
export function resolvePeoplePrimer(value, corpora, peopleEnabled) {
    if (value === undefined)
        return { enabled: false, corpora: [], hitsPerQuestion: 30,
            minScore: 0.35, minUsefulness: 0.8, maxEvidencePerQuestion: 3, timeoutMs: 30000 };
    let config;
    try {
        const withDefaults = Value.Default(peoplePrimerSchema, value);
        if (!Value.Check(peoplePrimerSchema, withDefaults))
            throw new Error("Invalid config");
        config = withDefaults;
    }
    catch {
        throw new Error("Invalid peoplePrimer configuration");
    }
    if (config.corpora.some(name => !corpora.some(c => c.name === name && c.kind !== "skills"))) {
        throw new Error("peoplePrimer.corpora must list configured non-skill corpora");
    }
    if (config.enabled && (!peopleEnabled || !config.corpora.length)) {
        throw new Error("peoplePrimer requires people.enabled and explicit approved corpora");
    }
    return { ...config, corpora: [...new Set(config.corpora)] };
}
