import assert from "node:assert/strict";
import test from "node:test";
import { chatTypeFromSessionKey } from "../src/session-chat-type.js";

test("typed segments map as before, :dm: and the untyped main DM keys map to direct, synthetic keys stay untyped", () => {
  for (const [key, expected] of [
    ["agent:main:slack:direct:u1", "direct"],
    ["agent:main:slack:group:g0mpdm", "group"],
    ["agent:main:slack:channel:c0ffee", "channel"],
    ["agent:main:slack:CHANNEL:c0ffee:thread:1.2", "channel"],
    ["agent:main:telegram:dm:42", "direct"],
    ["agent:main:main", "direct"],
    ["agent:bill:MAIN", "direct"],
    ["agent:group:main", "direct"],
    ["agent:channel:slack:direct:u1", "direct"],
    ["agent:main:slack:default:direct:u1", "direct"],
    ["agent:main:direct:u123", "direct"],
    ["agent:main:dm:u123", "direct"],
    ["agent:main:direct:group:5", "direct"],
    ["agent:main:slack:group:direct:u1", "direct"],
    ["agent:main:slack:channel:direct:u1", "direct"],
    ["agent:main:slack:direct:group:5", "direct"],
    ["main", "direct"],
    ["  agent:main:main  ", "direct"],
  ] as const) assert.equal(chatTypeFromSessionKey(key), expected, key);
  for (const key of [
    "agent:main:cron:foo", "agent:main:cron:main", "agent:main:subagent:abc", "agent:main:main:extra", "agent:main:mainline",
    "agent:main:inbox", "agent:group:inbox", "agent:channel:inbox", "agent:main:direct:", "agent:main:slack:group:channel:c1",
    "agent::main", "mainly", "dm", "agent:main:slack:dmx:1", "", "   ", undefined, null,
  ]) assert.equal(chatTypeFromSessionKey(key), undefined, String(key));
});
