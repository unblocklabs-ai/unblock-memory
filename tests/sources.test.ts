import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSafeVirtualPath, resolveSource } from "../src/sources.js";

test("resolves exact files, directories, and globs deterministically", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-paths-"));
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "MEMORY.md"), "# Memory\n");
  const file = resolveSource(workspace, "MEMORY.md");
  const dir = resolveSource(workspace, "memory");
  const glob = resolveSource(workspace, "memory/**/*.md");
  assert.equal(file.pattern, "MEMORY.md");
  assert.equal(dir.pattern, "**/*.md");
  assert.equal(glob.pattern, "**/*.md");
  assert.equal(glob.root, join(workspace, "memory"));
  assert.equal(resolveSource(workspace, "MEMORY.md").collection, file.collection);
});

test("treats a not-yet-created non-Markdown path as a directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-future-dir-"));
  const source = resolveSource(workspace, "notes");
  assert.equal(source.root, join(workspace, "notes"));
  assert.equal(source.pattern, "**/*.md");
});

test("virtual reads reject traversal and accept exact in-root markdown", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-safe-"));
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "memory", "today.md"), "hello\n");
  const source = resolveSource(workspace, "memory/**/*.md");
  const sources = new Map([[source.collection, source]]);
  assert.ok(parseSafeVirtualPath(`qmd://${source.collection}/today.md`, sources));
  assert.equal(parseSafeVirtualPath(`qmd://${source.collection}/../secret.md`, sources), undefined);
  assert.equal(parseSafeVirtualPath(`qmd://${source.collection}/today.txt`, sources), undefined);
  assert.equal(parseSafeVirtualPath("qmd://unknown/today.md", sources), undefined);
});

test("rejects workspace-relative glob roots that traverse a directory symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-symlink-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "unblock-qmd-symlink-outside-"));
  await writeFile(join(outside, "secret.md"), "outside\n");
  await symlink(outside, join(workspace, "memory"));
  assert.throws(
    () => resolveSource(workspace, "memory/**/*.md"),
    /must not traverse a workspace symlink/,
  );
});
