import { linkSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
/** Write JSONL to a private same-filesystem temp file and publish atomically without overwriting. */
export declare function writeTrainingExportJsonl(output: string, data: Iterable<unknown>, link?: typeof linkSync): number;
/** CLI only: no scheduler, tools, hooks, or live memory-index changes. */
export declare function registerMemoryTraining(api: OpenClawPluginApi, config: UnblockMemoryConfig): void;
