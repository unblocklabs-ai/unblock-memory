import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

/** This plugin's per-agent state: QMD index, durable stores and session projections. */
export function agentStateDir(agentId: string, stateRoot = resolveStateDir()): string {
  return join(stateRoot, "agents", agentId, "unblock-memory");
}

/** The host's per-agent transcript database. */
export function agentTranscriptDatabase(cfg: OpenClawConfig, agentId: string): string {
  return join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite");
}
