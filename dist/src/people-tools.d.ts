import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { type PeopleStores } from "./people-store.js";
import { type SlackDirectoryReader } from "./slack-directory.js";
export declare function registerPeopleTools(api: OpenClawPluginApi, stores: PeopleStores, config: UnblockMemoryConfig["people"], directoryReader?: SlackDirectoryReader): void;
