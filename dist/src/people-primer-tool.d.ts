import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";
import type { QmdMemoryRuntime } from "./runtime.js";
export declare function registerPeoplePrimerTool(api: OpenClawPluginApi, runtime: QmdMemoryRuntime, stores: PeopleStores, config: UnblockMemoryConfig): void;
