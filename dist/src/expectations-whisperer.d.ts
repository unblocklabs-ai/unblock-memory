import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { WhispererPrompt } from "./whisperer-prompt.js";
export type ExpectationsWhispererConfig = {
    enabled: boolean;
    maxHints: number;
    cooldownTurns: number;
    dueLeadMs: number;
    maxPayloadChars: number;
    includeWorkspaceBlockers: boolean;
};
export declare const EXPECTATIONS_WHISPERER_DEFAULTS: Readonly<ExpectationsWhispererConfig>;
type ChatType = "workspace" | "channel" | "group" | "direct";
type TurnAudience = {
    chatType?: ChatType;
    /** The conversation's native id (scopes channel/group audiences). */
    channelId?: string;
    /** Every channel id the host exposed for this turn (`nativeChannelId`, `chatId`, `channelContext.chat.id`, `channelId`). */
    channelIds?: readonly string[];
    channelLabel?: string;
    provider?: string;
    accountId?: string;
    senderId?: string;
};
export type ExpectationsQuery = TurnAudience & {
    agentId: string;
    nowMs: number;
    prompt?: string;
    personId?: string;
    dueLeadMs?: number;
    includeWorkspaceBlockers?: boolean;
};
type ExpectationKind = "commitment" | "prediction" | "blocker" | "decision_outcome" | "todo";
type Reason = "channel_match" | "person_match" | "due_or_overdue" | "active_blocker" | "keyword_match";
type HintStatus = "overdue" | "due_soon" | "open";
type TriggeredExpectation = {
    id: string;
    kind: ExpectationKind;
    status: HintStatus;
    dueAtMs: number | null;
    channel: string | null;
    subject: string | null;
    summary: string;
    expectedState: string;
    reasons: Reason[];
    updatedAtMs: number;
};
/** Return eligible, triggered open rows in display order. Does not write or apply session/payload limits. */
export declare function selectTriggeredExpectations(db: DatabaseSync, query: ExpectationsQuery): TriggeredExpectation[];
export declare function createExpectationsWhisperer(api: Pick<OpenClawPluginApi, "on">, dbPathForAgent: (agentId: string) => string, config?: Partial<ExpectationsWhispererConfig>): WhispererPrompt;
export {};
