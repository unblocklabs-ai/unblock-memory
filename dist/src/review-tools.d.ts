import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
export declare function registerReviewTools(api: OpenClawPluginApi, runtime: QmdMemoryRuntime, config: UnblockMemoryConfig, diagnostics: WhispererDiagnostics): void;
