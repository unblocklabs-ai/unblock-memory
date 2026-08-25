import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSafeVirtualPath, resolveSource } from "../src/sources.js";

test("resolves exact files, directories, and globs deterministically", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-paths-"));
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
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-future-dir-"));
  const source = resolveSource(workspace, "notes");
  assert.equal(source.root, join(workspace, "notes"));
  assert.equal(source.pattern, "**/*.md");
});

test("virtual reads reject traversal and accept exact in-root markdown", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-safe-"));
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "memory", "today.md"), "hello\n");
  const source = resolveSource(workspace, "memory/**/*.md");
  const sources = new Map([[source.collection, source]]);
  assert.ok(parseSafeVirtualPath(`qmd://${source.collection}/today.md`, sources));
  assert.equal(parseSafeVirtualPath(`qmd://${source.collection}/../secret.md`, sources), undefined);
  assert.equal(parseSafeVirtualPath(`qmd://${source.collection}/today.txt`, sources), undefined);
  assert.equal(parseSafeVirtualPath("qmd://unknown/today.md", sources), undefined);
});

test("virtual reads enforce exact-file and glob source masks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-mask-"));
  const memoryDir = join(workspace, "memory");
  await mkdir(join(memoryDir, "daily"), { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "allowed\n");
  await writeFile(join(workspace, "SECRET.md"), "denied\n");
  await writeFile(join(memoryDir, "daily", "today.md"), "allowed\n");
  await writeFile(join(memoryDir, "private.md"), "denied\n");

  const exact = resolveSource(workspace, "MEMORY.md");
  const exactSources = new Map([[exact.collection, exact]]);
  assert.ok(parseSafeVirtualPath(`qmd://${exact.collection}/MEMORY.md`, exactSources));
  assert.equal(parseSafeVirtualPath(`qmd://${exact.collection}/SECRET.md`, exactSources), undefined);

  const glob = resolveSource(workspace, "memory/*/*.md");
  const globSources = new Map([[glob.collection, glob]]);
  assert.ok(parseSafeVirtualPath(`qmd://${glob.collection}/daily/today.md`, globSources));
  assert.equal(parseSafeVirtualPath(`qmd://${glob.collection}/private.md`, globSources), undefined);
});

test("virtual reads reject an in-root symlink whose target escapes the source", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-read-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "unblock-memory-read-outside-"));
  const memoryDir = join(workspace, "memory");
  await mkdir(memoryDir);
  await writeFile(join(outside, "secret.md"), "outside\n");
  await symlink(join(outside, "secret.md"), join(memoryDir, "linked.md"));

  const source = resolveSource(workspace, "memory/**/*.md");
  const sources = new Map([[source.collection, source]]);
  assert.equal(parseSafeVirtualPath(`qmd://${source.collection}/linked.md`, sources), undefined);
});

test("rejects workspace-relative glob roots that traverse a directory symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-symlink-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "unblock-memory-symlink-outside-"));
  await writeFile(join(outside, "secret.md"), "outside\n");
  await symlink(outside, join(workspace, "memory"));
  assert.throws(
    () => resolveSource(workspace, "memory/**/*.md"),
    /must not traverse a workspace symlink/,
  );
  assert.throws(
    () => resolveSource(workspace, "memory"),
    /must not traverse a workspace symlink/,
  );
});
