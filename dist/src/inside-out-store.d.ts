import type { DatabaseSync } from "node:sqlite";
import { refreshEmotionBaselines } from "./emotion-baselines.js";
export declare const PERSON_MATCH = "SELECT min(i.person_id) person_id FROM person_identities i\n  WHERE i.provider=e.channel AND i.external_id=e.sender_id\n  AND (i.account_scope=json_extract(e.human_key,'$[1]') OR substr(json_extract(e.human_key,'$[1]'),1,8)='session:')\n  HAVING count(DISTINCT i.person_id)=1";
export declare function openInsideOutStore(path: string): DatabaseSync;
/**
 * Refresh People links without loading transcripts or calling Jev. Known accounts stay exact.
 * Purged grades stay unlinked. Matching is a read; only changed links are written, in short batches.
 */
export declare function linkInsideOutPeople(path: string): {
    updated: number;
    linked: number;
    unlinked: number;
};
type BaselineOptions = {
    minInteractions?: number;
    now?: number;
    recompare?: boolean;
    link?: boolean;
};
type BaselineResult = ReturnType<typeof refreshEmotionBaselines>;
/** Rebuild local statistics from existing grades, refreshing exact People links first unless the caller just did. */
export declare function refreshInsideOutBaselines(path: string, options?: BaselineOptions): BaselineResult;
/**
 * Worker entry, also behind the synchronous API. `unless`: the fingerprint left by this store's
 * previous refresh; unchanged inputs skip the pass.
 * @public loaded by name from the worker thread
 */
export declare function refreshWithFingerprint(path: string, options: BaselineOptions & {
    unless?: string;
}): {
    result: {
        snapshots: number;
        comparisons: number;
    };
    fingerprint?: undefined;
} | {
    result: {
        snapshots: number;
        comparisons: number;
    };
    fingerprint: string;
};
/**
 * Keep historical aggregation off the Gateway event loop; serialize refreshes per store, and skip
 * one whose inputs have not changed since this process's previous refresh of that store.
 * Aborting skips queued work and terminates a running worker. Its connection closes with the
 * worker, so SQLite rolls back the open batch; committed batches are idempotent and the next refresh resumes.
 */
export declare function refreshInsideOutBaselinesAsync(path: string, options?: BaselineOptions, signal?: AbortSignal): Promise<{
    snapshots: number;
    comparisons: number;
}>;
/** Operator erasure for one person; see purgeEmotionProfile. */
export declare function purgeInsideOutPerson(path: string, personId: string, options?: {
    grades?: boolean;
}): {
    baselines: number;
    assessments: number;
    grades: number;
};
export {};
