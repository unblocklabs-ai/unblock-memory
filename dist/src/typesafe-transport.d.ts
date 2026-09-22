export declare const TYPESAFE_MODEL = "jev-1.13.0";
export declare class TypeSafeHttpError extends Error {
    readonly status: number;
    constructor(status: number);
}
/** Shared wire protocol; callers own deadlines, judgments and public errors. */
export declare function postTypeSafe(params: {
    apiKey: string;
    signal: AbortSignal;
}, state: unknown, questions: unknown): Promise<unknown>;
