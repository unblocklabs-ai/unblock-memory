import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import type { WhispererPrompt } from "./whisperer-prompt.js";
export type MyTurnConfig = {
    enabled: boolean;
    historyMessages: number;
    channels: Record<string, {
        enabled: boolean;
    }>;
};
export declare function resolveMyTurn(value: unknown): MyTurnConfig;
export declare function registerMyTurn(api: OpenClawPluginApi, config: MyTurnConfig, decisionModel: UnblockMemoryConfig["decisionModel"], diagnostics?: WhispererDiagnostics): WhispererPrompt | undefined;
