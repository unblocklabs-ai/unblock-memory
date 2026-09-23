import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
/** CLI only: no scheduler, tools, hooks, or live memory-index changes. */
export declare function registerMemoryTraining(api: OpenClawPluginApi, config: UnblockMemoryConfig): void;
