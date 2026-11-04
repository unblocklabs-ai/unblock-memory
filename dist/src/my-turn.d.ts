import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
export type MyTurnConfig = {
    enabled: boolean;
    historyMessages: number;
    channels: Record<string, {
        enabled: boolean;
    }>;
};
export declare function resolveMyTurn(value: unknown): MyTurnConfig;
export declare function registerMyTurn(api: OpenClawPluginApi, config: MyTurnConfig, typesafe: UnblockMemoryConfig["typesafe"], diagnostics?: WhispererDiagnostics): Parameters<typeof api.on<"before_prompt_build">>[1] | undefined;
