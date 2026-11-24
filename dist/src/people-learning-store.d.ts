import { Type, type Static } from "typebox";
import type { ReviewManifest } from "./people-learning-inventory.js";
export declare const LEARNING_RECEIPT_SCHEMA: Type.TObject<{
    manifestRevision: Type.TOptional<Type.TString>;
    peopleReviews: Type.TArray<Type.TObject<{
        reason: Type.TString;
        sourceRefs: Type.TArray<Type.TString>;
        reviewedAt: Type.TString;
        personId: Type.TString;
        status: Type.TEnum<["reviewed", "no_interactions", "unresolved"]>;
        sessionIds: Type.TArray<Type.TString>;
    }>>;
    assertionReviews: Type.TArray<Type.TObject<{
        reason: Type.TString;
        sourceRefs: Type.TArray<Type.TString>;
        reviewedAt: Type.TString;
        assertionId: Type.TString;
        disposition: Type.TEnum<["revalidated", "corrected", "retired", "unresolved"]>;
        correctionsCheckedAt: Type.TOptional<Type.TString>;
    }>>;
    sourceGapReviews: Type.TArray<Type.TObject<{
        reason: Type.TString;
        sourceRefs: Type.TArray<Type.TString>;
        reviewedAt: Type.TString;
        sourceGapId: Type.TString;
        status: Type.TEnum<["resolved", "unresolved"]>;
    }>>;
    analysis: Type.TObject<{
        status: Type.TEnum<["complete", "not_approved", "unresolved"]>;
        reason: Type.TString;
    }>;
    changes: Type.TArray<Type.TObject<{
        personId: Type.TString;
        changeId: Type.TString;
    }>>;
    executionFollowups: Type.TArray<Type.TString>;
}>;
export type LearningReceipt = Static<typeof LEARNING_RECEIPT_SCHEMA>;
export type RecordAnalysisOptions = {
    expectedManifestRevision?: string;
    startedAt?: number;
    recordedAt?: number;
    generation?: number;
    sequence?: number;
    instanceId?: string;
};
export declare function manifestRevision(manifest: ReviewManifest): string;
export declare function verifyLearningCoverage(manifest: ReviewManifest, receipt: LearningReceipt, now?: number): {
    status: "partial" | "complete" | "invalid";
    expectedPeople: number;
    expectedSessions: number;
    expectedAssertions: number;
    missing: string[];
    errors: string[];
    unresolved: string[];
};
export declare class PeopleLearningStore {
    #private;
    readonly agentId: string;
    constructor(path: string, agentId: string);
    close(): void;
    recordAnalysis(id: string, status: "complete" | "unresolved", result: unknown, basis: string, options?: RecordAnalysisOptions): {
        recorded: boolean;
        reason?: "manifest_changed" | "superseded";
    };
    analysis(id: string): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
    begin(manifest: ReviewManifest, beforeCommit?: (manifest: ReviewManifest) => void): {
        manifest: ReviewManifest;
        manifestRevision: string;
        receipt: {
            manifestRevision?: string | undefined;
            analysis: {
                status: "complete" | "unresolved" | "not_approved";
                reason: string;
            };
            changes: {
                personId: string;
                changeId: string;
            }[];
            peopleReviews: {
                status: "reviewed" | "no_interactions" | "unresolved";
                personId: string;
                reason: string;
                reviewedAt: string;
                sessionIds: string[];
                sourceRefs: string[];
            }[];
            assertionReviews: {
                correctionsCheckedAt?: string | undefined;
                reason: string;
                reviewedAt: string;
                sourceRefs: string[];
                assertionId: string;
                disposition: "retired" | "unresolved" | "revalidated" | "corrected";
            }[];
            sourceGapReviews: {
                status: "resolved" | "unresolved";
                reason: string;
                reviewedAt: string;
                sourceRefs: string[];
                sourceGapId: string;
            }[];
            executionFollowups: string[];
        } | undefined;
        status: string;
        coverage: unknown;
    };
    planMissedWindows(manifest: ReviewManifest): void;
    matchesRevision(id: string, expectedRevision?: string): boolean;
    get(id: string): {
        manifest: ReviewManifest;
        manifestRevision: string;
        receipt: {
            manifestRevision?: string | undefined;
            analysis: {
                status: "complete" | "unresolved" | "not_approved";
                reason: string;
            };
            changes: {
                personId: string;
                changeId: string;
            }[];
            peopleReviews: {
                status: "reviewed" | "no_interactions" | "unresolved";
                personId: string;
                reason: string;
                reviewedAt: string;
                sessionIds: string[];
                sourceRefs: string[];
            }[];
            assertionReviews: {
                correctionsCheckedAt?: string | undefined;
                reason: string;
                reviewedAt: string;
                sourceRefs: string[];
                assertionId: string;
                disposition: "retired" | "unresolved" | "revalidated" | "corrected";
            }[];
            sourceGapReviews: {
                status: "resolved" | "unresolved";
                reason: string;
                reviewedAt: string;
                sourceRefs: string[];
                sourceGapId: string;
            }[];
            executionFollowups: string[];
        } | undefined;
        status: string;
        coverage: unknown;
    } | undefined;
    backlog(): {
        id: string;
        status: string;
        coverage: unknown;
    }[];
    checkpoint(id: string, input: unknown, now?: number, checkSaves?: (receipt: LearningReceipt) => string[], finalize?: (receiptId: string) => void, expectedManifestRevision?: string): {
        receiptId: string;
        manifestRevision: string;
        backlog: ReturnType<PeopleLearningStore["backlog"]>;
    } & {
        status: "partial" | "complete" | "invalid";
        expectedPeople: number;
        expectedSessions: number;
        expectedAssertions: number;
        missing: string[];
        errors: string[];
        unresolved: string[];
    };
}
