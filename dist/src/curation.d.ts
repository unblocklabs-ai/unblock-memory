declare const TEMPORAL_BASES: readonly ["path", "frontmatter", "session", "agent_verified"];
export type TemporalBasis = typeof TEMPORAL_BASES[number];
declare const MAINTENANCE_TASK_TYPES: readonly ["ambiguous_event_time", "exact_duplicate"];
export type MaintenanceTaskType = typeof MAINTENANCE_TASK_TYPES[number];
declare const MAINTENANCE_STATUSES: readonly ["pending", "resolved", "deferred", "irrelevant"];
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number];
export type TemporalAnnotation = {
    corpus: string;
    collection: string;
    path: string;
    contentFingerprint: string;
    eventTime: string;
    basis: TemporalBasis;
    evidence: string;
    qmdHash: string | null;
    qmdSeq: number | null;
    createdAt: string;
    updatedAt: string;
};
export type MaintenanceTask = {
    id: string;
    type: MaintenanceTaskType;
    corpus: string;
    collection: string;
    path: string;
    reason: string;
    contentFingerprint: string;
    detail: string | null;
    resolutionNote: string | null;
    status: MaintenanceStatus;
    createdAt: string;
    updatedAt: string;
};
export declare function chunkFingerprint(text: string): string;
export declare class CurationStore {
    #private;
    constructor(path: string);
    close(): void;
    annotations(): TemporalAnnotation[];
    addTask(candidate: {
        type: MaintenanceTaskType;
        corpus: string;
        collection: string;
        path: string;
        reason: string;
        contentFingerprint?: string;
        detail?: string;
    }): void;
    listTasks(params?: {
        status?: MaintenanceStatus;
        limit?: number;
    }): MaintenanceTask[];
    updateTask(params: {
        id: string;
        status: Exclude<MaintenanceStatus, "pending">;
        note?: string;
        annotation?: {
            scope: "chunk" | "document";
            eventTime: string;
            basis: TemporalBasis;
            evidence: string;
        };
    }): MaintenanceTask | undefined;
    updateAnnotationLocation(params: {
        annotation: TemporalAnnotation;
        qmdHash: string | null;
        qmdSeq: number | null;
    }): void;
}
export {};
