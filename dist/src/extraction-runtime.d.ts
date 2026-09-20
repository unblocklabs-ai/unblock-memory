import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { QmdMemoryRuntime } from "./runtime.js";
export declare function registerExtraction(api: OpenClawPluginApi, config: UnblockMemoryConfig, runtime?: QmdMemoryRuntime): void;
