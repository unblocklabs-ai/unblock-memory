/** Narrowing for untrusted JSON-shaped input such as transcripts and API responses. */
export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** A plain object, or undefined for null, arrays and primitives. */
export function record(value) {
    return isRecord(value) ? value : undefined;
}
/** A trimmed non-empty string, or undefined. */
export function nonBlank(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
