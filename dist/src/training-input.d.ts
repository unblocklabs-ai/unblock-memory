export declare const TRAINING_PREPARATION = "visible-history-v1";
export type TrainingInput = {
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    currentRequest: string;
};
export type TrainingExample = {
    seq: number;
    timestamp: number;
    input: TrainingInput;
    inputHash: string;
    contextLimited: boolean;
};
type Row = {
    seq: number;
    eventJson: string;
    createdAt: number;
};
export declare const trainingHash: (value: unknown) => string;
/** The following answer establishes eligibility, but is never part of that example's input. */
export declare function trainingExamples(rows: Iterable<Row>): {
    examples: TrainingExample[];
    coverage: {
        users: number;
        filtered: number;
        oversized: number;
        unanswered: number;
    };
};
/** Only active events; no Markdown projections, archived branches, or tool bodies. */
export declare class TrainingTranscriptReader {
    #private;
    constructor(path: string, agentId: string);
    sessions(): string[];
    /** null = absent/ineligible. Oversized sessions are not evidence of deletion. */
    read(sessionId: string): {
        examples: TrainingExample[];
        coverage: {
            users: number;
            filtered: number;
            oversized: number;
            unanswered: number;
        };
    } | {
        oversized: true;
    } | null;
    close(): void;
}
export {};
