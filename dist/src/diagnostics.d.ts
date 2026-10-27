import { RetrievalTelemetry } from "./retrieval-telemetry.js";
type Whisperer = "skill" | "memory" | "safety";
type Outcome = "missing_key" | "typesafe_disabled" | "no_candidates" | "rejected" | "cooldown" | "emitted" | "failed" | "timed_out" | "cancelled" | "unavailable" | "payload_limit" | "redundancy_unavailable" | "recall_not_needed" | "queries_generated" | "judge_candidate_failed" | "input_too_large" | "excluded" | "no_scenarios" | "empty_request" | "no_match" | "flagged" | "missing_identity" | "partial_response";
/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export declare class WhispererDiagnostics {
    #private;
    static shared(): WhispererDiagnostics;
    record(agentId: string, whisperer: Whisperer, outcome: Outcome): void;
    /** Scenario IDs are operator configuration, not conversation content. */
    recordSafetyMatch(agentId: string, scenarioId: string): void;
    measureMemory(agentId: string, observation: Parameters<RetrievalTelemetry["record"]>[1]): void;
    measureSearch(agentId: string, observation: Parameters<RetrievalTelemetry["record"]>[1]): void;
    snapshot(agentId: string): {
        skill: {
            cancelled?: number | undefined;
            unavailable?: number | undefined;
            rejected?: number | undefined;
            failed?: number | undefined;
            timed_out?: number | undefined;
            missing_key?: number | undefined;
            typesafe_disabled?: number | undefined;
            no_candidates?: number | undefined;
            cooldown?: number | undefined;
            emitted?: number | undefined;
            payload_limit?: number | undefined;
            redundancy_unavailable?: number | undefined;
            recall_not_needed?: number | undefined;
            queries_generated?: number | undefined;
            judge_candidate_failed?: number | undefined;
            input_too_large?: number | undefined;
            excluded?: number | undefined;
            no_scenarios?: number | undefined;
            empty_request?: number | undefined;
            no_match?: number | undefined;
            flagged?: number | undefined;
            missing_identity?: number | undefined;
            partial_response?: number | undefined;
        };
        memory: {
            cancelled?: number | undefined;
            unavailable?: number | undefined;
            rejected?: number | undefined;
            failed?: number | undefined;
            timed_out?: number | undefined;
            missing_key?: number | undefined;
            typesafe_disabled?: number | undefined;
            no_candidates?: number | undefined;
            cooldown?: number | undefined;
            emitted?: number | undefined;
            payload_limit?: number | undefined;
            redundancy_unavailable?: number | undefined;
            recall_not_needed?: number | undefined;
            queries_generated?: number | undefined;
            judge_candidate_failed?: number | undefined;
            input_too_large?: number | undefined;
            excluded?: number | undefined;
            no_scenarios?: number | undefined;
            empty_request?: number | undefined;
            no_match?: number | undefined;
            flagged?: number | undefined;
            missing_identity?: number | undefined;
            partial_response?: number | undefined;
        };
        safety: {
            matchedScenarios: {
                [k: string]: number;
            };
            cancelled?: number | undefined;
            unavailable?: number | undefined;
            rejected?: number | undefined;
            failed?: number | undefined;
            timed_out?: number | undefined;
            missing_key?: number | undefined;
            typesafe_disabled?: number | undefined;
            no_candidates?: number | undefined;
            cooldown?: number | undefined;
            emitted?: number | undefined;
            payload_limit?: number | undefined;
            redundancy_unavailable?: number | undefined;
            recall_not_needed?: number | undefined;
            queries_generated?: number | undefined;
            judge_candidate_failed?: number | undefined;
            input_too_large?: number | undefined;
            excluded?: number | undefined;
            no_scenarios?: number | undefined;
            empty_request?: number | undefined;
            no_match?: number | undefined;
            flagged?: number | undefined;
            missing_identity?: number | undefined;
            partial_response?: number | undefined;
        };
        telemetry: {
            scope: string;
            operations: {
                [k: string]: {
                    calls: number;
                    outcomes: {
                        cancelled?: number | undefined;
                        ok?: number | undefined;
                        partial?: number | undefined;
                        skipped?: number | undefined;
                        failed?: number | undefined;
                        empty?: number | undefined;
                        timed_out?: number | undefined;
                        degraded?: number | undefined;
                    };
                    slowestRecent: {
                        outcome: "cancelled" | "ok" | "partial" | "skipped" | "failed" | "empty" | "timed_out" | "degraded";
                        setupMs?: number | undefined;
                        queueWaitMs?: number | undefined;
                        metadataMs?: number | undefined;
                        storeSetupMs?: number | undefined;
                        bm25Ms?: number | undefined;
                        vectorMs?: number | undefined;
                        vectorIndexCheckMs?: number | undefined;
                        vectorScopeMs?: number | undefined;
                        embeddingMs?: number | undefined;
                        vectorScanMs?: number | undefined;
                        hydrationMs?: number | undefined;
                        vectorMappingMs?: number | undefined;
                        vectorOtherMs?: number | undefined;
                        passageMs?: number | undefined;
                        candidatePrepMs?: number | undefined;
                        retrievalOtherMs?: number | undefined;
                        otherMs?: number | undefined;
                        retrievalMs?: number | undefined;
                        judgeMs?: number | undefined;
                        metadataReloads?: number | undefined;
                        vectorScanAttempts?: number | undefined;
                        elapsedMs?: number | undefined;
                        gateMs?: number | undefined;
                        generationMs?: number | undefined;
                        candidates?: number | undefined;
                        eligible?: number | undefined;
                        results?: number | undefined;
                        contextChars?: number | undefined;
                        requestsSucceeded?: number | undefined;
                        requestsFailed?: number | undefined;
                        fallbackKeyUnavailable?: number | undefined;
                        fallbackAllJudgmentsFailed?: number | undefined;
                    }[];
                    measurements: {
                        [k: string]: {
                            total: number;
                            samples: number;
                            recentSamples: number;
                            p50: number | null;
                            p95: number | null;
                        };
                    };
                };
            };
        };
        scope: string;
    };
}
export {};
