/** Measure UTF-8 bytes of the serialized state, including the Decisions array wrapper. */
export declare function decisionStateBytes(state: object): number;
/** Pack in input order, surfacing an oversized singleton without ever sending it. */
export declare function packDecisionState<T, S extends object>(items: readonly T[], maxItems: number, maxBytes: number, stateFor: (items: readonly T[]) => S): Generator<{
    items: T[];
    state: S | undefined;
}>;
