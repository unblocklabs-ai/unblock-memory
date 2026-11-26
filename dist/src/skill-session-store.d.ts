export type ActiveSkillEntry = {
    canonicalPath: string;
    name: string;
    description: string;
    source: "whisperer" | "read";
    score?: number;
    addedTurn: number;
    addedAtMs: number;
    lastUsedAtMs: number;
    openedAtMs?: number;
};
export declare class SkillSessionStore {
    #private;
    constructor(dbPath: string);
    list(scope: string): ActiveSkillEntry[];
    upsert(scope: string, entries: readonly ActiveSkillEntry[]): void;
    rebindSession(scopes: readonly string[], successor: string, entries: readonly ActiveSkillEntry[]): void;
    pruneMissing(scope: string, validCanonicalPaths: Iterable<string>): void;
    deleteSession(scope: string): void;
    pruneExpired(cutoffMs: number): void;
    close(): void;
}
