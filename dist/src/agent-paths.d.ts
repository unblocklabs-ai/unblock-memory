import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
/** This plugin's per-agent state: QMD index, durable stores and session projections. */
export declare function agentStateDir(agentId: string, stateRoot?: string): string;
/** The host's per-agent transcript database. */
export declare function agentTranscriptDatabase(cfg: OpenClawConfig, agentId: string): string;
