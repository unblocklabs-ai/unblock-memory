import type { DatabaseSync } from "node:sqlite";
import type { ResponseResult } from "./response-store.js";
export declare const RESPONSE_REVIEW_POLICY = "response-review-v2";
export type ResponseReviewStatus = "pending" | "resolved" | "dismissed" | "deferred";
export type ResponseReviewDecisionOptions = {
    expectedInputHash?: string;
    expectedEvidenceHash?: string;
};
/** Operator-only tasks, intentionally not exposed as memory-curation agent tools. */
export declare class ResponseReviews {
    #private;
    private readonly db;
    constructor(db: DatabaseSync);
    sync(cohort: string, episodeId: string, inputHash: string, result: ResponseResult, now: number): void;
    refresh(cohort: string, since: number): number;
    reconcile(cohort: string, sessionId: string): void;
    list(cohort: string, id?: string): {
        id: string;
        episodeId: string;
        family: string;
        status: string;
        cohort: string;
        inputHash: string;
        evidenceHash: string;
        evidenceStatus: string;
        reviewerKind: import("node:sqlite").SQLOutputValue;
        resolutionNote: import("node:sqlite").SQLOutputValue;
        createdAt: import("node:sqlite").SQLOutputValue;
        updatedAt: import("node:sqlite").SQLOutputValue;
        evidence: unknown;
    }[];
    decisions(taskId?: string, cohort?: string): {
        id: number;
        taskId: string;
        status: ResponseReviewStatus;
        reviewerKind: "human" | "agent";
        note: string;
        decidedAt: number;
        cohort: string | null;
        inputHash: string | null;
        evidenceHash: string | null;
    }[];
    decide(cohort: string, id: string, status: ResponseReviewStatus, reviewer: "human" | "agent", note: string, now?: number, options?: ResponseReviewDecisionOptions): {
        taskId: string;
        status: ResponseReviewStatus;
        reviewerKind: "agent" | "human";
        note: string;
        decidedAt: number;
        cohort: string;
        inputHash: string;
        evidenceHash: string;
    };
    annotate(occurredAt: number, kind: string, note: string): `${string}-${string}-${string}-${string}-${string}`;
    annotations(since: number, until: number): Record<string, import("node:sqlite").SQLOutputValue>[];
}
