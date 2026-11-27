import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExpectationsWhisperer } from "../src/expectations-whisperer.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { listCaptainsLogEntries, runCaptainsLogPass } from "../src/steward-captains-log.js";
import { runExpectationsPass } from "../src/steward-expectations.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-27T17:00:00Z");
const NATIVE = "C0AHZFCAS1K";

// Real producers (Captain's Log + Steward Expectations) → real whisperer, through a host-shaped hook context that carries
// the native Slack conversation id as `chatId` and no `channelLabel`.
test("producer output fires channel_match on a real OpenClaw host hook context", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "expectations-e2e-"));
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  const memoryPath = join(root, "unblock-memory.sqlite");
  const workStore = new WorkStore(memoryPath);
  const agent = createAgentDatabase(join(root, "openclaw-agent.sqlite"));
  t.after(() => { agent.close(); workStore.close(); rmSync(root, { recursive: true, force: true }); });

  insertSession(agent, { sessionId: "acme", chatType: "channel" });
  agent.prepare("UPDATE conversations SET native_channel_id=?, label='#acme-ops' WHERE conversation_id='conversation-acme'").run(NATIVE);
  const event = { type: "message", message: { role: "user", content: [{ type: "text",
    text: "Acme sync is blocked on the Shopify API quota. Priya will ship the retry fix by Friday." }] } };
  agent.prepare("INSERT INTO transcript_events VALUES ('acme', 1, ?, ?)").run(JSON.stringify(event), START - MINUTE);
  agent.prepare("INSERT INTO session_transcript_active_events VALUES ('acme', 0, 1, 0)").run();

  const config = resolveStewardConfig(undefined);
  const runner = createStewardRunner({ config, resolveApiKey: async () => "test-provider-credential", fetch: async (_url, init) => {
    const request: { input: [{ content: string }] } = JSON.parse(String(init?.body));
    const prompt = JSON.parse(request.input[0].content) as Record<string, unknown>;
    const value = "existingDailyLog" in prompt
      ? { shouldAppend: true, entries: [{ topic: "Shopify API quota", summary: "Acme sync blocked on the Shopify rate limit",
        blocked: true, sessionRefs: ["s1"] }] }
      : "expectations" in prompt ? { judgments: [] }
        : { expectations: [{ kind: "commitment", summary: "Priya ships the Acme retry fix", expectedState: "Acme sync retries succeed",
          sessionRefs: ["s1"] }] };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  } });
  const common = { agentId: "main", owner: "e2e", workStore, runner, databasePath: join(root, "openclaw-agent.sqlite"),
    timezone: "America/New_York", now: () => START };
  assert.equal((await runCaptainsLogPass({ ...common, workspaceDir })).status, "appended");
  const [entry] = listCaptainsLogEntries(workStore.db, { agentId: "main", blockedOnly: true });
  assert.deepEqual([entry?.channels, entry?.nativeChannels], [["#acme-ops"], [NATIVE]]);
  assert.equal((await runExpectationsPass(common)).status, "completed");

  const hook = createExpectationsWhisperer({ on() {} }, () => memoryPath, { includeWorkspaceBlockers: false, cooldownTurns: 0 });
  const context = {
    trigger: "user", agentId: "main", sessionId: "live-session", sessionKey: `agent:main:slack:channel:${NATIVE.toLowerCase()}`,
    runId: "run-1", messageProvider: "slack", accountId: "workspace", chatId: NATIVE, senderId: "U_HUMAN",
  };
  type Hint = { summary: string; channel?: string; matchedBy: string[] };
  const hints = async (ctx: Record<string, unknown>): Promise<Hint[]> => {
    const result = await hook({ prompt: "Any update?", messages: [] }, ctx as Parameters<typeof hook>[1]);
    return result?.appendContext ? JSON.parse(result.appendContext.split("\n")[2]!) as Hint[] : [];
  };
  const live = await hints(context);
  const blocker = live.find(hint => hint.summary === "Shopify API quota");
  const commitment = live.find(hint => hint.summary === "Priya ships the Acme retry fix");
  assert.ok(blocker?.matchedBy.includes("channel_match"), JSON.stringify(live));
  assert.equal(blocker?.channel, "#acme-ops", "prompts keep the clean human label");
  assert.ok(commitment?.matchedBy.includes("channel_match"), JSON.stringify(live));
  // Hosts may also hand over a lowercased id via `channelContext.chat.id` / `channelId` only.
  const lowered = await hints({ ...context, runId: "run-2", chatId: undefined, channelId: NATIVE.toLowerCase() });
  assert.equal(lowered.length, 2);
  const viaChat = await hints({ ...context, runId: "run-3", chatId: undefined, channelContext: { chat: { id: NATIVE } } });
  assert.equal(viaChat.length, 2);
  // The Steward commitment belongs to that one channel: a DM or another channel never sees it.
  assert.deepEqual(await hints({ ...context, runId: "run-4", sessionKey: "agent:main:slack:workspace:direct:u_human", chatId: "D1" }), []);
  assert.deepEqual(await hints({ ...context, runId: "run-5", sessionKey: "agent:main:slack:channel:c0other", chatId: "C0OTHER" }), []);
});
