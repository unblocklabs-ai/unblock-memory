import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { type PeopleRefinementRunner } from "./people-refinement.js";
export declare function registerPeopleCli(api: OpenClawPluginApi, config: UnblockMemoryConfig["people"], runner?: PeopleRefinementRunner): void;
