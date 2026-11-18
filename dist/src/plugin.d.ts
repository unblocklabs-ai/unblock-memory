import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export declare function resolveFlushPlan(params?: {
    cfg?: OpenClawConfig;
    nowMs?: number;
}): {
    prompt: string;
    systemPrompt: string;
    relativePath: string;
    model?: string | undefined;
    softThresholdTokens: number;
    forceFlushTranscriptBytes: number;
    reserveTokensFloor: number;
} | null;
export declare function registerUnblockMemory(api: OpenClawPluginApi): void;
