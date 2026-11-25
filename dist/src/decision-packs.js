/** Measure UTF-8 bytes of the serialized state, including the Decisions array wrapper. */
export function decisionStateBytes(state) {
    return Buffer.byteLength(JSON.stringify([state]));
}
/** Pack in input order, surfacing an oversized singleton without ever sending it. */
export function* packDecisionState(items, maxItems, maxBytes, stateFor) {
    let pack;
    for (const item of items) {
        if (pack && pack.items.length < maxItems) {
            const items = [...pack.items, item];
            const state = stateFor(items);
            if (decisionStateBytes(state) <= maxBytes) {
                pack = { items, state };
                continue;
            }
        }
        if (pack)
            yield pack;
        const items = [item];
        const state = stateFor(items);
        if (decisionStateBytes(state) <= maxBytes) {
            pack = { items, state };
        }
        else {
            pack = undefined;
            yield { items, state: undefined };
        }
    }
    if (pack)
        yield pack;
}
