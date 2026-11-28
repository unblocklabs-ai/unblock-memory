import { AgentTranscriptReader } from "./agent-transcript.js";
import type { ChatType } from "./config.js";
import { classifySyntheticInput, type SyntheticInputFilterConfig } from "./synthetic-input.js";
/**
 * Transcript mechanics shared by the Captain's Log and Expectations Steward passes. Audience admission, per-pass filters
 * and malformed-event errors, session caps and message projection stay with each pass.
 */
export type TranscriptRole = "user" | "assistant";
type ClassifiedInput = ReturnType<typeof classifySyntheticInput>;
/** One session of the active-window query. `provider` / `accountId` / `senderId` are selected only with `identity`. */
export type ActiveSessionWindow = {
    sessionId: string;
    sessionKey: string;
    chatType: ChatType;
    conversationKind: ChatType | null;
    conversationLabel: string | null;
    latestSeq: number;
    nativeChannelId: unknown;
    provider?: unknown;
    accountId?: unknown;
    senderId?: unknown;
};
/**
 * Opens the live agent database read-only inside one snapshot transaction and iterates every session with active-branch
 * events in `[from, to]` whose chat type is not in `excludeChatTypes` (default `["direct"]`), oldest activity first.
 * Returns `empty` when no chat type remains or the database does not exist.
 */
export declare function readActiveSessionWindows<T>(options: {
    databasePath: string;
    agentId: string;
    excludeChatTypes?: readonly ChatType[];
    from: number;
    to: number;
    identity?: boolean;
}, empty: T, read: (windows: Iterable<ActiveSessionWindow>, reader: AgentTranscriptReader) => T): T;
/** A `cron` session key is an unattended run whenever the `cron_wrapper` family is filtered. */
export declare function isCronSessionKey(sessionKey: string, syntheticInput?: SyntheticInputFilterConfig): boolean;
/**
 * The host-visible text of one parsed transcript event, classified for synthetic input. Only user and assistant messages:
 * never hidden reasoning, and an explicit empty assistant display (`[]`) shows nothing even when raw content exists.
 * `undefined` for anything else, empty text, or text opening with `injectedContext`.
 */
export declare function visibleTranscriptMessage(parsed: unknown, injectedContext: RegExp, syntheticInput?: SyntheticInputFilterConfig): {
    role: TranscriptRole;
    input: ClassifiedInput;
} | undefined;
/**
 * Per-session unattended-turn tracking, fed every visible message in active order. A cron wrapper or a non-alias
 * heartbeat control opens an unattended turn; the next human (non-synthetic) user message closes it. Returns whether
 * the message belongs to an unattended turn.
 */
export declare function unattendedTurnTracker(): (role: TranscriptRole, input: ClassifiedInput) => boolean;
/**
 * Consumes a sequence prefix of `candidates` (sorted in place by `seq`) under a per-session character budget (`0` =
 * unlimited), so the watermark never skips a message the budget excluded. Each text is redacted, then clipped to the
 * remaining budget; an empty clip is consumed but not emitted. `maxSeq` is the last consumed sequence (else `seenSeq`).
 */
export declare function budgetSequencePrefix<T extends {
    text: string;
    seq: number;
}>(candidates: T[], maxChars: number, seenSeq: number): {
    emitted: T[];
    maxSeq: number;
};
/** A redacted, human-readable channel label (`#name` when present); never for DMs or opaque native ids. */
export declare function humanChannelLabel(chatType: ChatType, rawLabel: string | null | undefined): string | undefined;
export {};
