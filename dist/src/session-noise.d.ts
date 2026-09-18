/** Conservative cleanup of generated session envelopes. Source events are never modified. All offsets are UTF-16. */
type Edit = {
    start: number;
    end: number;
    replacement: string;
    reason: string;
};
type Proposal = {
    edits: Edit[];
    preserved: {
        start: number;
        end: number;
    }[];
    budgetSkipped?: boolean;
};
/** Only authenticated provenance plus a complete known grammar permits rewriting. */
export declare function parseInternalMessage(text: string, trustedInterSession: boolean): Proposal;
export declare function parseAttachments(text: string): Proposal;
export declare function applyProposal(text: string, proposal: Proposal): string;
export {};
