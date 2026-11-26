import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { abortedByTimeout } from "../src/abortable.js";
import { WhispererAdmissionTracker, admissionKey } from "../src/whisperer-admission.js";

type Data = { recent: Map<string, number> };
const tracker = (maxSessions = 10, maxRunsPerSession = 4) =>
  new WhispererAdmissionTracker<Data, string>({ maxSessions, maxRunsPerSession });
const init = (previous?: Data) => ({ recent: previous?.recent ?? new Map<string, number>() });
const target = (runId: string, scope = "s1", agentId = "bill") => ({ agentId, scope, runId });

test("same-run prompt rebuilds replay the cached result instead of re-admitting", async () => {
  const sessions = tracker();
  assert.deepEqual(sessions.lookup(target("r1")), { kind: "fresh" });
  const entry = sessions.admit({ ...target("r1"), sessionId: "s1", init });
  entry.result = Promise.resolve("hints");
  const replay = sessions.lookup(target("r1"));
  assert.equal(replay.kind, "replay");
  assert.equal(replay.kind === "replay" && replay.result, entry.result);
  assert.equal(await (replay.kind === "replay" ? replay.result : undefined), "hints");
  assert.equal(entry.signal.aborted, false, "replay never cancels the in-flight run");
  assert.equal(sessions.size, 1);
});

test("a new run supersedes the previous one, carries session state, and ignores delayed superseded rebuilds", () => {
  const sessions = tracker();
  const first = sessions.admit({ ...target("r1"), init });
  first.state.recent.set("passage", 1);
  const lookup = sessions.lookup(target("r2"));
  assert.equal(lookup.kind, "fresh");
  assert.equal(lookup.kind === "fresh" && lookup.previous, first);
  const second = sessions.admit({ ...target("r2"), init });
  assert.equal(first.signal.aborted, true, "previous controller is aborted");
  assert.equal(second.signal.aborted, false);
  assert.equal(second.turn, 2);
  assert.equal(second.state.recent, first.state.recent, "cooldown state carries across turns");
  assert.equal(second.seenRuns, first.seenRuns);
  assert.equal(sessions.isCurrent(first), false);
  assert.equal(sessions.isCurrent(second), true);
  assert.deepEqual(sessions.lookup(target("r1")), { kind: "superseded" });
  assert.equal(sessions.isCurrent(second), true, "a superseded lookup never replaces the latest run");
});

test("seen runs stay bounded per session", () => {
  const sessions = tracker(10, 2);
  for (const runId of ["r1", "r2", "r3"]) sessions.admit({ ...target(runId), init });
  const latest = sessions.admit({ ...target("r4"), init });
  assert.deepEqual([...latest.seenRuns], ["r3", "r4"]);
  assert.equal(sessions.lookup(target("r1")).kind, "fresh", "evicted run IDs are no longer recognized");
});

test("least-recently-used sessions are evicted and aborted when the session cap is reached", () => {
  const sessions = tracker(2);
  const a = sessions.admit({ ...target("r1", "a"), init });
  const b = sessions.admit({ ...target("r1", "b"), init });
  sessions.lookup(target("r1", "a")); // touch a, so b becomes the LRU entry
  const c = sessions.admit({ ...target("r1", "c"), init });
  assert.equal(b.signal.aborted, true);
  assert.equal(sessions.isCurrent(b), false);
  assert.equal(a.signal.aborted, false);
  assert.equal(sessions.isCurrent(a) && sessions.isCurrent(c), true);
  assert.equal(sessions.size, 2);
});

test("deadline aborts with a TimeoutError reason and the disposer cancels it", async () => {
  const sessions = tracker();
  const timed = sessions.admit({ ...target("r1", "a"), init });
  sessions.deadline(timed, 5, "Memory deadline");
  const cancelled = sessions.admit({ ...target("r1", "b"), init });
  sessions.deadline(cancelled, 5)();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(abortedByTimeout(timed.signal), true);
  assert.equal((timed.signal.reason as Error).message, "Memory deadline");
  assert.equal(cancelled.signal.aborted, false);
  // Supersession is a plain abort, distinguishable from the deadline.
  const superseded = sessions.admit({ ...target("r1", "c"), init });
  sessions.admit({ ...target("r2", "c"), init });
  assert.equal(superseded.signal.aborted, true);
  assert.equal(abortedByTimeout(superseded.signal), false);
});

test("session_end and gateway_stop abort and forget matching sessions via attach", () => {
  const sessions = tracker();
  const hooks = new Map<string, (...args: unknown[]) => void>();
  sessions.attach({ on: (name: string, handler: (...args: unknown[]) => void) => hooks.set(name, handler) } as unknown as OpenClawPluginApi);
  const byId = sessions.admit({ ...target("r1", "id-1"), sessionId: "id-1", init });
  const byKey = sessions.admit({ ...target("r1", "key-1"), sessionKey: "key-1", init });
  const otherAgent = sessions.admit({ ...target("r1", "id-1", "theo"), sessionId: "id-1", init });
  hooks.get("session_end")!({ sessionId: "id-1" }, { agentId: "bill" });
  assert.equal(byId.signal.aborted, true);
  assert.equal(sessions.isCurrent(byId), false);
  assert.equal(otherAgent.signal.aborted, false, "agent-scoped session_end leaves other agents alone");
  hooks.get("session_end")!({ sessionId: "unrelated" }, { sessionKey: "key-1" });
  assert.equal(byKey.signal.aborted, true);
  assert.equal(sessions.lookup(target("r1", "key-1")).kind, "fresh", "ended sessions no longer replay");
  hooks.get("gateway_stop")!();
  assert.equal(otherAgent.signal.aborted, true);
  assert.equal(sessions.size, 0);
});

test("admission keys separate agents sharing a session scope", () => {
  assert.notEqual(admissionKey("bill", "s"), admissionKey("theo", "s"));
  const sessions = tracker();
  const bill = sessions.admit({ ...target("r1", "s", "bill"), init });
  assert.equal(sessions.lookup(target("r1", "s", "theo")).kind, "fresh");
  sessions.admit({ ...target("r1", "s", "theo"), init });
  assert.equal(bill.signal.aborted, false);
});
