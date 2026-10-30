/** Stop waiting without cancelling shared work that other callers still need. */
export declare function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T>;
/** Whether the signal fired because an `AbortSignal.timeout` deadline elapsed. */
export declare function abortedByTimeout(signal: AbortSignal | undefined): boolean;
