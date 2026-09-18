import { Type } from "typebox";
import { Value } from "typebox/value";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { getContext } from "./tool-context.js";
import { resolveTypeSafeApiKey } from "./typesafe.js";
import { abortable } from "./abortable.js";

const claimParameters = Type.Object({
  claim: Type.String({ pattern: "\\S", maxLength: 2000 }),
  citations: Type.Array(Type.Object({
    path: Type.String({ pattern: "^qmd://", maxLength: 2000 }),
    from: Type.Integer({ minimum: 1 }), lines: Type.Integer({ minimum: 1, maximum: 120 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });
const clusterParameters = Type.Object({ clusterId: Type.String({ pattern: "^[0-9a-f]{10}$" }) }, { additionalProperties: false });
const noParameters = Type.Object({}, { additionalProperties: false });

export function registerReviewTools(api: OpenClawPluginApi, runtime: QmdMemoryRuntime, config: UnblockMemoryConfig, diagnostics: WhispererDiagnostics) {
  api.registerTool(ctx => {
    const active = getContext(ctx);
    if (!active) return null;
    return {
      name: "memory_diagnostics", label: "Memory Diagnostics",
      description: "Read content-free whisperer counters, configuration state, projection version and index readiness. Does not call TypeSafe.",
      parameters: noParameters,
      async execute(_id: string, params: unknown) {
        Value.Parse(noParameters, params);
        let credential: "disabled" | "available" | "missing" | "unreadable" = "disabled";
        if (config.typesafe.enabled) {
          try { credential = await resolveTypeSafeApiKey(config.typesafe) ? "available" : "missing"; }
          catch { credential = "unreadable"; }
        }
        const result = { status: "ok", credential,
          enabled: { skill: config.skillWhisperer.enabled, memory: config.memoryWhisperer.enabled && config.typesafe.enabled,
            complementaryHints: config.memoryWhisperer.complementaryHints, qualityAudit: config.qualityAudit.enabled, evidenceReview: config.evidenceReview.enabled },
          whisperers: diagnostics.snapshot(active.agentId) };
        try {
          const { manager } = await runtime.getMemorySearchManager(active);
          return jsonResult({ ...result, index: manager ? await manager.diagnostics() : { status: "unavailable" } });
        } catch { return jsonResult({ ...result, index: { status: "unavailable" } }); }
      },
    };
  }, { names: ["memory_diagnostics"] });

  api.registerTool(ctx => {
    const active = getContext(ctx);
    if (!active) return null;
    return {
      name: "memory_review_claim", label: "Review Memory Claim",
      description: "Before a knowledge or dossier write, check one proposed atomic claim against cited indexed source lines. TypeSafe advisory only; does not write, authorize writes, or establish current truth. Requires evidenceReview approval for every cited corpus.",
      parameters: claimParameters,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const parsed = Value.Parse(claimParameters, params);
        if (!config.evidenceReview.enabled || !config.typesafe.enabled) return jsonResult({ status: "disabled" });
        const deadline = AbortSignal.timeout(30_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        try {
          combined.throwIfAborted();
          const apiKey = await abortable(resolveTypeSafeApiKey(config.typesafe), combined);
          combined.throwIfAborted();
          if (!apiKey) return jsonResult({ status: "unavailable", reason: "TypeSafe API key not configured" });
          const { manager } = await abortable(runtime.getMemorySearchManager(active), combined);
          combined.throwIfAborted();
          if (!manager) return jsonResult({ status: "unavailable" });
          return jsonResult(await manager.reviewClaim({ ...parsed, corpora: config.evidenceReview.corpora,
            apiKey, timeoutMs: config.typesafe.timeoutMs, signal: combined }));
        } catch { return jsonResult({ status: "unavailable", needsReview: true, reason: "Claim review failed or was cancelled; no claim verified" }); }
      },
    };
  }, { names: ["memory_review_claim"] });

  api.registerTool(ctx => {
    const active = getContext(ctx);
    if (!active) return null;
    return {
      name: "memory_review_cluster", label: "Review Cluster Ingestion",
      description: "Inspect up to six complete center/edge cluster members for recurring ingestion defects. Uses qualityAudit approved corpora and TypeSafe. Does not modify tasks, sources or clusters; findings apply only to sampled members.",
      parameters: clusterParameters,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const parsed = Value.Parse(clusterParameters, params);
        if (!config.qualityAudit.enabled || !config.typesafe.enabled) return jsonResult({ status: "disabled" });
        const deadline = AbortSignal.timeout(30_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        try {
          combined.throwIfAborted();
          const apiKey = await abortable(resolveTypeSafeApiKey(config.typesafe), combined);
          combined.throwIfAborted();
          if (!apiKey) return jsonResult({ status: "unavailable", reason: "TypeSafe API key not configured" });
          const { manager } = await abortable(runtime.getMemorySearchManager(active), combined);
          combined.throwIfAborted();
          if (!manager) return jsonResult({ status: "unavailable" });
          return jsonResult(await manager.reviewCluster({ ...parsed, corpora: config.qualityAudit.corpora,
            apiKey, timeoutMs: config.typesafe.timeoutMs, signal: combined }));
        } catch { return jsonResult({ status: "unavailable", reason: "Cluster review failed or was cancelled; no cluster judgment made" }); }
      },
    };
  }, { names: ["memory_review_cluster"] });
}
