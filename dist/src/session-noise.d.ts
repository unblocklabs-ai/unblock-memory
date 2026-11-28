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
/** Scanners provide their own delimiter match; only the open/close rule is shared. */
export declare function nextMarkdownFence(open: string | undefined, delimiter: RegExpExecArray | null): string | undefined;
export declare function parseAttachments(text: string): Proposal;
export declare function applyProposal(text: string, proposal: Proposal): string;
export {};
