/** Stop waiting without cancelling shared work that other callers still need. */
export declare function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T>;
