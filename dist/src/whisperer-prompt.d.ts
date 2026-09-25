import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
/** One host contribution keeps every whisperer after the user in a stable order. */
export declare function registerWhispererPrompt(api: OpenClawPluginApi, whisperers: Partial<Record<"memory" | "skill" | "people", Parameters<typeof api.on<"before_prompt_build">>[1]>>): void;
