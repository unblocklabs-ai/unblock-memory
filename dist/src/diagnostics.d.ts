type Whisperer = "skill" | "memory";
type Outcome = "missing_key" | "typesafe_disabled" | "no_candidates" | "rejected" | "cooldown" | "emitted" | "failed" | "timed_out" | "cancelled" | "unavailable" | "payload_limit" | "redundancy_unavailable";
/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export declare class WhispererDiagnostics {
    #private;
    record(agentId: string, whisperer: Whisperer, outcome: Outcome): void;
    snapshot(agentId: string): {
        skill: {
            unavailable?: number | undefined;
            rejected?: number | undefined;
            failed?: number | undefined;
            missing_key?: number | undefined;
            typesafe_disabled?: number | undefined;
            no_candidates?: number | undefined;
            cooldown?: number | undefined;
            emitted?: number | undefined;
            timed_out?: number | undefined;
            cancelled?: number | undefined;
            payload_limit?: number | undefined;
            redundancy_unavailable?: number | undefined;
        };
        memory: {
            unavailable?: number | undefined;
            rejected?: number | undefined;
            failed?: number | undefined;
            missing_key?: number | undefined;
            typesafe_disabled?: number | undefined;
            no_candidates?: number | undefined;
            cooldown?: number | undefined;
            emitted?: number | undefined;
            timed_out?: number | undefined;
            cancelled?: number | undefined;
            payload_limit?: number | undefined;
            redundancy_unavailable?: number | undefined;
        };
        scope: string;
    };
}
export {};
