import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
declare const ORDER: readonly ["memory", "skill", "people", "safety"];
/** One host contribution keeps every whisperer after the user in a stable order; safety stays closest to the reply. */
export declare function registerWhispererPrompt(api: OpenClawPluginApi, whisperers: Partial<Record<(typeof ORDER)[number], Parameters<typeof api.on<"before_prompt_build">>[1]>>): void;
export {};
