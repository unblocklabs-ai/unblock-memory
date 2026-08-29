import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";
export declare function renderPeopleWhisper(blurb: string, maxChars: number): string | undefined;
export declare function registerPeopleHooks(api: OpenClawPluginApi, stores: PeopleStores, config: UnblockMemoryConfig["people"]): void;
