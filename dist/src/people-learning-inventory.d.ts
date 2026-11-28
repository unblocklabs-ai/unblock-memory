import type { PeopleStore, PersonDossier } from "./people-store.js";
import { reviewWindow } from "./people-learning-time.js";
export type ReviewKind = "nightly" | "weekly";
type ReviewGap = {
    id: string;
    reason: string;
    sessionId?: string;
};
export type ReviewAssertion = {
    id: string;
    personId: string;
    category: string;
    statement: string;
    claim?: PersonDossier["sections"][number]["claims"][number];
};
type ReviewPerson = {
    personId: string;
    name: string;
    status: string;
    injectionEnabled: boolean;
    identities: {
        provider: string;
        accountScope: string;
        externalId: string;
    }[];
    sessionIds: string[];
};
export type ReviewManifest = {
    id: string;
    agentId: string;
    kind: ReviewKind;
    createdAt: string;
    refreshedAt?: string;
    window: ReturnType<typeof reviewWindow>;
    fullValidation: boolean;
    roster: ReviewPerson[];
    assertions: ReviewAssertion[];
    sourceGaps: ReviewGap[];
    sessions: {
        sessionId: string;
        file: string;
        revision: string;
    }[];
    inventoryPending?: boolean;
};
/**
 * Trimmed, non-empty sentence spans of a blurb: `[start, end)` is the trimmed sentence and `segmentEnd` the end of its
 * segment (trailing whitespace included). This order IS the blurb-assertion order of `dossierAssertions`.
 */
export declare function blurbSentenceSpans(blurb: string): {
    start: number;
    end: number;
    segmentEnd: number;
}[];
export declare function dossierAssertions(personId: string, dossier: PersonDossier): ReviewAssertion[];
/** Atomically publishes a flushed 0o600 private JSON artifact; never accepts a truncated partial file. */
export declare function privateJson(root: string, name: string, value: unknown): string;
/** Publishes a review manifest's private artifact under its content revision. */
export declare function publishPeopleManifest(root: string, manifest: ReviewManifest): string;
export declare function inventoryPeople(options: {
    agentId: string;
    timezone: string;
    kind: ReviewKind;
    now?: number;
    day?: string;
    people: PeopleStore;
    databasePath: string;
    exportRoot: string;
}): ReviewManifest;
export {};
