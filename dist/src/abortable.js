/** Stop waiting without cancelling shared work that other callers still need. */
export async function abortable(pending, signal) {
    if (!signal)
        return pending;
    let onAbort = () => { };
    const cancelled = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted)
            onAbort();
    });
    try {
        // Observe late failures even when cancellation wins the race.
        const result = await Promise.race([pending, cancelled]);
        signal.throwIfAborted();
        return result;
    }
    finally {
        signal.removeEventListener("abort", onAbort);
    }
}
