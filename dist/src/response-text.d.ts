/** Infer legacy transport sender metadata only to unwrap visible conversation text. */
export declare function conversationUserText(raw: string, sender?: unknown): {
    text: string;
    contextLimited: boolean;
} | undefined;
/** Parse only recognized transport envelopes. Ambiguous wrappers are excluded,
 * never flattened into a human's request or used to approve embedded speakers. */
export declare function responseUserText(input: string, senderId: string): {
    text: string;
    contextLimited: boolean;
} | undefined;
