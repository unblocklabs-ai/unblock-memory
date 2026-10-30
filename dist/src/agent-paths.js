import { join } from "node:path";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
/** This plugin's per-agent state: QMD index, durable stores and session projections. */
export function agentStateDir(agentId, stateRoot = resolveStateDir()) {
    return join(stateRoot, "agents", agentId, "unblock-memory");
}
/** The host's per-agent transcript database. */
export function agentTranscriptDatabase(cfg, agentId) {
    return join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite");
}
