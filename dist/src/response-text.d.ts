/** Parse only recognized transport envelopes. Ambiguous wrappers are excluded,
 * never flattened into a human's request or used to approve embedded speakers. */
export declare function responseUserText(input: string, senderId: string): {
    text: string;
    contextLimited: boolean;
} | undefined;
