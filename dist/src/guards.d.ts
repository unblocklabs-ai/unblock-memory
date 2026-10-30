/** Narrowing for untrusted JSON-shaped input such as transcripts and API responses. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** A plain object, or undefined for null, arrays and primitives. */
export declare function record(value: unknown): Record<string, unknown> | undefined;
/** A trimmed non-empty string, or undefined. */
export declare function nonBlank(value: unknown): string | undefined;
