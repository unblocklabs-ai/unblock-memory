import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type UnblockMemoryConfig } from "./config.js";
import { PeopleStores } from "./people-store.js";
export declare function registerPeopleLearning(api: OpenClawPluginApi, initial: UnblockMemoryConfig, stores: PeopleStores): void;
/** Operator CLI keeps raw review output private; no main-agent default. */
export declare function registerPeopleLearningCli(api: OpenClawPluginApi, config: UnblockMemoryConfig): void;
