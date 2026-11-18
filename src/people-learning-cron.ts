import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { record, nonBlank } from "./guards.js";
import { learningForAgent, type PeopleLearningConfig } from "./people-learning-config.js";
import { resolveTimezone } from "./session-projector.js";
import { peopleLearningPrompt } from "./people-learning-prompt.js";

const PREFIX = "unblock-memory:people-learning:";
const legacyNames = {
  nightly: "People Whisperer — nightly dreaming and interaction learning",
  weekly: "People Whisperer — full weekly statement validation",
};
function containsDeclaration(actual: unknown, expected: unknown): boolean {
  const fields = record(expected), source = record(actual);
  return fields && source ? Object.entries(fields).every(([key, value]) => containsDeclaration(source[key], value))
    : isDeepStrictEqual(actual, expected);
}
export const LEARNING_TOOLS = ["read", "memory_people_learning", "memory_people_inspect", "memory_people_update",
  "memory_people_prime", "memory_search", "memory_get"];

export type PeopleCron = Pick<NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext["getCron"]>>>, "list" | "add" | "update">;

export type LearningJob = { id: string; agentId: string; kind: "nightly" | "weekly" };
/** Service-owned cron, not bundled-only scheduleSessionTurn.
 * Stable declarations make a lost add response/reload safe. Legacy history stays on disabled originals.
 */
export async function reconcilePeopleLearning(cron: PeopleCron, cfg: OpenClawConfig, config: PeopleLearningConfig,
  active: () => boolean = () => true): Promise<LearningJob[]> {
  const jobs: Record<string, unknown>[] = [];
  {
    const all = await cron.list({ includeDisabled: true });
    if (!Array.isArray(all)) throw new Error("Unsupported service cron.list response");
    for (const item of all) {
      const job = record(item);
      if (!job || !nonBlank(job.id)) throw new Error("Invalid cron job inventory");
      jobs.push(job);
    }
  }
  const result: LearningJob[] = [], owned = new Set<string>();
  for (const agentId of listAgentIds(cfg)) {
    const options = learningForAgent(config, agentId);
    for (const kind of ["nightly", "weekly"] as const) {
      const key = `${PREFIX}${agentId}:${kind}`;
      const matches = jobs.filter(job => job.agentId === agentId && (job.declarationKey === key ||
        job.name === key || job.name === legacyNames[kind] ||
        (options.legacyJobIds?.includes(String(job.id)) && record(job.payload)?.kind === "agentTurn" &&
          String(record(job.payload)?.message).includes(`people-${kind === "nightly" ? "nightly-dreaming" : "weekly-validation"}.md`))));
      const primary = matches.find(job => job.declarationKey === key);
      const legacy = matches.filter(job => job.declarationKey !== key);
      const migrationPaused = config.agents?.[agentId]?.enabled !== true &&
        (primary ? String(primary.description).includes("[migration-paused]") : legacy.length > 0 && legacy.every(job => job.enabled === false));
      const enabled = options.enabled && options[kind] && !migrationPaused;
      if (!primary && !legacy.length && !enabled) continue;
      const desired = {
        declarationKey: key, agentId, name: key,
        description: "Plugin-owned private People Whisperer review; opt out in people.learning." + (migrationPaused ? " [migration-paused]" : ""),
        enabled, schedule: { kind: "cron", expr: options[`${kind}Schedule`],
          tz: options.timezone ?? resolveTimezone(cfg.agents?.defaults?.userTimezone), staggerMs: 0 },
        sessionTarget: "isolated", wakeMode: "now", deleteAfterRun: false,
        payload: { kind: "agentTurn", message: peopleLearningPrompt(kind, agentId), timeoutSeconds: kind === "nightly" ? 2700 : 3600,
          toolsAllow: LEARNING_TOOLS },
        delivery: { mode: "none" }, failureAlert: false,
      };
      if (!active()) return result;
      let id: string;
      if (primary) {
        id = String(primary.id);
      } else {
        // declarationKey is creation-only in the installed SDK. Never "migrate"
        // it through update, which silently ignores that field. Create disabled
        // before pausing the originals so a lost reply cannot leave two runners.
        const added = record(await cron.add({ ...desired, enabled: false }));
        const addedId = nonBlank(added?.id) ?? nonBlank(record(added?.job)?.id);
        if (!addedId) throw new Error("Cron creation unconfirmed; retry reconciliation with the same declaration key");
        id = addedId;
      }
      owned.add(id);
      result.push({ id, agentId, kind });
      // Keep duplicate IDs and histories recoverable, but prevent a second run.
      for (const duplicate of matches) if (duplicate.id !== id && duplicate.enabled !== false && active()) {
        await cron.update(String(duplicate.id), { enabled: false });
      }
      const { declarationKey: _key, ...patch } = desired;
      if (active() && (!primary || !containsDeclaration(primary, patch))) await cron.update(id, patch);
    }
  }
  // Only this exact namespace is owned. Never sweep other agents' maintenance jobs.
  for (const job of jobs) if (String(job.declarationKey ?? "").startsWith(PREFIX) && !owned.has(String(job.id)) && job.enabled !== false && active()) {
    await cron.update(String(job.id), { enabled: false });
  }
  return result;
}

export function learningSession(sessionKey: string | undefined, jobs: readonly LearningJob[]) {
  if (!sessionKey) return undefined;
  return jobs.find(job => sessionKey === `agent:${job.agentId}:cron:${job.id}` ||
    sessionKey.startsWith(`agent:${job.agentId}:cron:${job.id}:run:`));
}
