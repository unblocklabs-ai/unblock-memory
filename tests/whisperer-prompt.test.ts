import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerWhispererPrompt } from "../src/whisperer-prompt.js";

type Contributions = Parameters<typeof registerWhispererPrompt>[1];
type PromptHook = NonNullable<Contributions["memory"]>;

function harness(contributions: Contributions) {
  let before: PromptHook | undefined;
  const warnings: string[] = [];
  const api = {
    on(name: string, handler: PromptHook) {
      assert.equal(name, "before_prompt_build");
      assert.equal(before, undefined);
      before = handler;
    },
    logger: { warn(message: string) { warnings.push(message); } },
  } as unknown as OpenClawPluginApi;
  registerWhispererPrompt(api, contributions);
  return { before, warnings };
}

test("one appended wrapper orders memory before skill and people regardless of completion order", async () => {
  let finishMemory!: (value: { appendContext: string }) => void;
  const memory = new Promise<{ appendContext: string }>(resolve => { finishMemory = resolve; });
  let skillStarted = false;
  const h = harness({
    memory: () => memory,
    skill: () => { skillStarted = true; return { appendContext: '<skill>This skill may be relevant: "/skills/deploy/SKILL.md"</skill>' }; },
    people: () => ({ appendContext: "<people>Project owner.</people>" }),
  });
  const event = { prompt: "Deploy this", messages: [] };
  const pending = h.before!(event, { trigger: "user" });
  assert.equal(skillStarted, true, "skill selection must not wait for memory retrieval");
  finishMemory({ appendContext: '<memory>\n[{"source":"qmd://memory/note.md","lines":"1-2","body":"Approved."}]\n</memory>' });
  const result = await pending;
  assert.deepEqual(result, { appendContext: '<unblock_memory>\n<memory>\n[{"source":"qmd://memory/note.md","lines":"1-2","body":"Approved."}]\n</memory>\n<skill>This skill may be relevant: "/skills/deploy/SKILL.md"</skill>\n<people>Project owner.</people>\n</unblock_memory>' });
  assert.deepEqual(await h.before!(event, { trigger: "user" }), result);
  assert.equal(event.prompt, "Deploy this");
});

test("empty sections are omitted, including the outer wrapper when nothing qualifies", async () => {
  for (let mask = 0; mask < 8; mask++) {
    const names = ["memory", "skill", "people"] as const;
    const contributions = Object.fromEntries(names.map((name, i) => [name,
      () => mask & (1 << i) ? { appendContext: `<${name}>content</${name}>` } : undefined,
    ]));
    const h = harness(contributions);
    const sections = names.flatMap((name, i) => mask & (1 << i) ? [`<${name}>content</${name}>`] : []);
    assert.deepEqual(await h.before!({ prompt: "task", messages: [] }, {}),
      mask ? { appendContext: `<unblock_memory>\n${sections.join("\n")}\n</unblock_memory>` } : undefined);
  }
  assert.equal(harness({}).before, undefined);
});

test("a failed contribution does not discard another whisperer or leak errors", async () => {
  const h = harness({
    memory: () => { throw new Error("private source text"); },
    skill: () => ({ appendContext: '<skill>This skill may be relevant: "/skills/deploy/SKILL.md"</skill>' }),
  });
  assert.deepEqual(await h.before!({ prompt: "task", messages: [] }, {}), {
    appendContext: '<unblock_memory>\n<skill>This skill may be relevant: "/skills/deploy/SKILL.md"</skill>\n</unblock_memory>',
  });
  assert.deepEqual(h.warnings, ["unblock-memory whisperer contribution failed"]);
});
