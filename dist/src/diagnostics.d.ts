import { RetrievalTelemetry } from "./retrieval-telemetry.js";
type Whisperer = "skill" | "memory";
type Outcome = "missing_key" | "typesafe_disabled" | "no_candidates" | "rejected" | "cooldown" | "emitted" | "failed" | "timed_out" | "cancelled" | "unavailable" | "payload_limit" | "redundancy_unavailable" | "recall_not_needed" | "queries_generated" | "query_fallback" | "judge_candidate_failed";
/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export declare class WhispererDiagnostics {
    #private;
    static shared(): WhispererDiagnostics;
    record(agentId: string, whisperer: Whisperer, outcome: Outcome): void;
    measureMemory(agentId: string, observation: Parameters<RetrievalTelemetry["record"]>[1]): void;
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
            query_fallback?: number | undefined;
            judge_candidate_failed?: number | undefined;
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
            query_fallback?: number | undefined;
            judge_candidate_failed?: number | undefined;
        };
        telemetry: {
            scope: string;
            operations: {
                [k: string]: {
                    calls: number;
                    outcomes: {
                        cancelled?: number | undefined;
                        ok?: number | undefined;
                        skipped?: number | undefined;
                        failed?: number | undefined;
                        empty?: number | undefined;
                        timed_out?: number | undefined;
                    };
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
