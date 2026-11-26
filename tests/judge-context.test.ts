import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../src/defaults.js";
import { selectJudgeConversation } from "../src/judge-context.js";
import { queryTokenIds, type QueryConversation } from "../src/query-contract.js";

test("judge context admits the intact request and the newest whole-message suffix under both caps", () => {
  const { judgeConversationMaxBytes: bytes, judgeConversationMaxTokens: tokens } = DEFAULTS.memoryWhisperer;
  const currentRequest = `Opening constraint. ${"Important exact phrasing. ".repeat(65)} Final question 🚀?`;
  const recent: QueryConversation["history"] = [
    { role: "assistant", content: "Here is the first detail." },
    { role: "user", content: "One correction 🚀." },
    { role: "assistant", content: "Here is the revised detail." },
  ];
  // Each older message exceeds a different cap even though the other cap would admit it.
  const tokenHeavy = "🚀".repeat(1500);
  const byteHeavy = (" ".repeat(128) + "word").repeat(180);
  for (const [limit, content] of [["tokens", tokenHeavy], ["bytes", byteHeavy]] as const) {
    const tooLarge = { history: [{ role: "user" as const, content }, ...recent], currentRequest };
    const serialized = JSON.stringify(tooLarge);
    assert.equal(Buffer.byteLength(serialized) > bytes, limit === "bytes");
    assert.equal(queryTokenIds(serialized).length > tokens, limit === "tokens");
    assert.deepEqual(selectJudgeConversation({
      ...tooLarge, history: [{ role: "assistant", content: "small but older than the blocked message" }, ...tooLarge.history],
    }), { status: "ok", conversation: { history: recent, currentRequest } });
  }
});

test("judge context reports overflow rather than clipping a current request", () => {
  for (const currentRequest of ["🚀".repeat(1500), `before${" ".repeat(24_000)}after`]) {
    assert.deepEqual(selectJudgeConversation({ history: [], currentRequest }), { status: "input_too_large" });
  }
});
