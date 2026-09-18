import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerReviewTools } from "../src/review-tools.js";
import { resolveConfig } from "../src/config.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";

type Tool = { name: string; execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown> };
function tools(config: ReturnType<typeof resolveConfig>, runtime: QmdMemoryRuntime, diagnostics = new WhispererDiagnostics()) {
  const registered = new Map<string, Tool>();
  registerReviewTools({ registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool) {
    const tool = factory({ agentId: "bill", config: {} } as OpenClawPluginToolContext);
    registered.set(tool.name, tool);
  } } as unknown as OpenClawPluginApi, runtime, config, diagnostics);
  return async (name: string, params = {}, signal?: AbortSignal) => {
    const result = await registered.get(name)!.execute("id", params, signal) as { content: { text: string }[] };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  };
}

test("review tools gate missing keys and disabled features before accessing memory", async () => {
  const runtime = { getMemorySearchManager() { assert.fail("must not access memory"); } } as unknown as QmdMemoryRuntime;
  for (const enabled of [false, true]) {
    const call = tools(resolveConfig({ typesafe: { apiKeyFile: "/nonexistent/unblock-review-key.env" },
      qualityAudit: { enabled, corpora: ["memory"] }, evidenceReview: { enabled, corpora: ["memory"] } }), runtime);
    const claim = await call("memory_review_claim", { claim: "Fact", citations: [{ path: "qmd://memory/note.md", from: 1, lines: 1 }] });
    const cluster = await call("memory_review_cluster", { clusterId: "0123456789" });
    assert.equal(claim.status, enabled ? "unavailable" : "disabled");
    assert.equal(cluster.status, enabled ? "unavailable" : "disabled");
  }
});

test("review tools propagate approved scope and cancellation and sanitize errors", async () => {
  let calls = 0;
  const runtime = { async getMemorySearchManager() { return { manager: {
    async reviewClaim(params: { corpora: string[]; signal: AbortSignal }) {
      calls++; assert.deepEqual(params.corpora, ["memory"]); assert.ok(params.signal);
      throw new Error("secret source or key");
    },
    async reviewCluster(params: { corpora: string[] }) { calls++; assert.deepEqual(params.corpora, ["memory"]); return { status: "ok", members: [] }; },
  } }; } } as unknown as QmdMemoryRuntime;
  const call = tools(resolveConfig({ typesafe: { apiKey: "fake-secret" },
    qualityAudit: { enabled: true, corpora: ["memory"] }, evidenceReview: { enabled: true, corpora: ["memory"] } }), runtime);
  const result = await call("memory_review_claim", { claim: "Fact", citations: [{ path: "qmd://memory/note.md", from: 1, lines: 1 }] });
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal((await call("memory_review_cluster", { clusterId: "0123456789" })).status, "ok");
  assert.equal((await call("memory_review_cluster", { clusterId: "0123456789" }, AbortSignal.abort())).status, "unavailable");
  assert.equal(calls, 2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const reviews = [
  { name: "memory_review_claim", params: { claim: "Fact", citations: [{ path: "qmd://memory/note.md", from: 1, lines: 1 }] } },
  { name: "memory_review_cluster", params: { clusterId: "0123456789" } },
] as const;

for (const review of reviews) {
  for (const stage of ["credentials", "initialization"] as const) {
    for (const cancellation of ["caller", "deadline"] as const) {
      test(`${review.name} stops waiting for ${stage} on ${cancellation} without cancelling shared work`, { timeout: 2000 }, async t => {
        const controller = new AbortController();
        if (cancellation === "deadline") {
          t.mock.method(AbortSignal, "timeout", (ms: number) => {
            assert.equal(ms, 30_000);
            return controller.signal;
          });
        }
        const started = deferred<void>();
        const credential = deferred<string>();
        let reads = 0, managerCalls = 0, reviewCalls = 0;
        const manager = {
          async reviewClaim() { reviewCalls++; return { status: "ok" }; },
          async reviewCluster() { reviewCalls++; return { status: "ok" }; },
        };
        const initialization = deferred<{ manager: typeof manager }>();
        if (stage === "credentials") {
          const mock = t.mock.method(fs, "readFile", () => { reads++; started.resolve(); return credential.promise; });
          syncBuiltinESMExports();
          t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
        }
        const runtime = { getMemorySearchManager() {
          managerCalls++;
          if (stage === "initialization") started.resolve();
          return initialization.promise;
        } } as unknown as QmdMemoryRuntime;
        const config = resolveConfig({ typesafe: stage === "credentials" ? { apiKeyFile: "/fake/review.env" } : { apiKey: "fake-secret" },
          qualityAudit: { enabled: true, corpora: ["memory"] }, evidenceReview: { enabled: true, corpora: ["memory"] } });
        const call = tools(config, runtime);
        const cancelled = call(review.name, review.params, cancellation === "caller" ? controller.signal : undefined);
        await started.promise;
        controller.abort(new Error("private cancellation reason"));
        // This must finish BEFORE either pending stage is released.
        const result = await cancelled;
        assert.equal(result.status, "unavailable");
        assert.equal(JSON.stringify(result).includes("private"), false);
        assert.equal(reviewCalls, 0);
        assert.equal(managerCalls, stage === "credentials" ? 0 : 1);
        // A fresh caller can still use the same initialization after the first exits.
        t.mock.restoreAll();
        syncBuiltinESMExports();
        credential.resolve("fake-secret");
        initialization.resolve({ manager });
        const freshCall = tools(resolveConfig({ ...config, typesafe: { apiKey: "fake-secret" } }), runtime);
        assert.equal((await freshCall(review.name, review.params)).status, "ok");
        assert.equal(reviewCalls, 1, "the cancelled call must never dispatch a review later");
        assert.equal(managerCalls, stage === "credentials" ? 1 : 2);
        assert.equal(reads, stage === "credentials" ? 1 : 0);
      });
    }
  }

  test(`${review.name} observes initialization failures arriving after cancellation`, { timeout: 2000 }, async () => {
    const started = deferred<void>(), initialization = deferred<never>();
    const controller = new AbortController();
    const runtime = { getMemorySearchManager() { started.resolve(); return initialization.promise; } } as unknown as QmdMemoryRuntime;
    const call = tools(resolveConfig({ typesafe: { apiKey: "fake-secret" },
      qualityAudit: { enabled: true, corpora: ["memory"] }, evidenceReview: { enabled: true, corpora: ["memory"] } }), runtime);
    const result = call(review.name, review.params, controller.signal);
    await started.promise;
    controller.abort();
    assert.equal((await result).status, "unavailable");
    initialization.reject(new Error("late private initialization failure"));
    // Node's test runner fails this test if the late rejection is unhandled.
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

test("diagnostics reports disabled features, safe credential state and per-agent counts without inference", async t => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("diagnostics must not call TypeSafe"); });
  const diagnostics = new WhispererDiagnostics();
  diagnostics.record("bill", "skill", "emitted");
  diagnostics.record("pearl", "memory", "failed");
  const runtime = { async getMemorySearchManager() { return { manager: { async diagnostics() {
    return { projectorVersion: 6, semanticChunkingVersion: 7, needsEmbedding: 3, embeddingReady: false };
  } } }; } } as unknown as QmdMemoryRuntime;
  const call = tools(resolveConfig({ typesafe: { apiKey: "fake-secret" } }), runtime, diagnostics);
  const result = await call("memory_diagnostics");
  assert.equal(result.credential, "available");
  assert.equal(JSON.stringify(result).includes("fake-secret"), false);
  assert.equal(JSON.stringify(result).includes("failed"), false);
  assert.deepEqual(result.enabled, { skill: false, memory: false, complementaryHints: false, qualityAudit: false, evidenceReview: false });
});
