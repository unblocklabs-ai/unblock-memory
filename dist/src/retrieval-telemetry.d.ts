type RetrievalOperation = "vector" | "lexical" | "memoryWhisperer";
type RetrievalOutcome = "ok" | "empty" | "failed" | "cancelled" | "timed_out" | "skipped";
declare const fields: readonly ["elapsedMs", "retrievalMs", "judgeMs", "candidates", "eligible", "results", "contextChars"];
type Field = typeof fields[number];
export type RetrievalObservation = {
    outcome: RetrievalOutcome;
    elapsedMs: number;
} & Partial<Record<Field, number>>;
/** Only fixed operation/outcome names and nonnegative numbers enter this store. */
export declare class RetrievalTelemetry {
    #private;
    record(operation: RetrievalOperation, observation: RetrievalObservation): void;
    snapshot(): {
        scope: string;
        operations: {
            [k: string]: {
                calls: number;
                outcomes: {
                    ok?: number | undefined;
                    skipped?: number | undefined;
                    failed?: number | undefined;
                    empty?: number | undefined;
                    cancelled?: number | undefined;
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
}
export {};
