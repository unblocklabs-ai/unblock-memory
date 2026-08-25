import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export declare function resolveFlushPlan(params?: {
    cfg?: OpenClawConfig;
    nowMs?: number;
}): {
    softThresholdTokens: number;
    forceFlushTranscriptBytes: number;
    reserveTokensFloor: number;
    model: string | undefined;
    prompt: string;
    systemPrompt: string;
    relativePath: string;
} | null;
export declare function registerUnblockMemory(api: OpenClawPluginApi): void;
