import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import packageInfo from "../package.json" with { type: "json" };
import { resolveConfig } from "../src/config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = [
  "README.md",
  "docs/configuration.md",
  "docs/retrieval.md",
  "docs/peoplesql.md",
  "docs/response-audit.md",
  "skills/people-whisperer/SKILL.md",
  "skills/memory-curator/SKILL.md",
];

test("guide JSON is valid and configuration profiles resolve without hidden prerequisites", async () => {
  for (const document of documents) {
    const markdown = await readFile(resolve(root, document), "utf8");
    for (const match of markdown.matchAll(/^```json\n([\s\S]*?)^```/gm)) {
      const example: unknown = JSON.parse(match[1]);
      assert.ok(example !== null && typeof example === "object", document);
      // Host examples and tool inputs are not plugin configuration fragments.
      if (document === "docs/configuration.md" && !("plugins" in example) && !("agents" in example)) {
        assert.doesNotThrow(() => resolveConfig(example), `${document}: ${match[1]}`);
      }
    }
  }
});

test("published guides and their relative links are included in the package", async () => {
  for (const document of documents) {
    const markdown = await readFile(resolve(root, document), "utf8");
    const targets = [document];
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      targets.push(relative(root, resolve(root, dirname(document), target)));
    }
    for (const target of targets) {
      assert.ok((await stat(resolve(root, target))).isFile(), `${document}: ${target}`);
      assert.ok(
        target === "package.json" || packageInfo.files.some(entry => target === entry || target.startsWith(`${entry}/`)),
        `${document} links to unpackaged ${target}`,
      );
    }
  }
});
