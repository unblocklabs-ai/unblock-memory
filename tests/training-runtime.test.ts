import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTrainingExportJsonl } from "../src/training-runtime.js";

test("writeTrainingExportJsonl enforces 0o600 permissions via fchmod regardless of umask", () => {
  const dir = mkdtempSync(join(tmpdir(), "training-export-mode-"));
  const output = join(dir, "export.jsonl");
  // Mask out owner write bit so openSync(..., 0o600) alone would produce 0o400 without fchmodSync.
  const previousUmask = process.umask(0o277);
  try {
    const rows = writeTrainingExportJsonl(output, [{ row: 1 }]);
    assert.equal(rows, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, "utf8"), '{"row":1}\n');
    assert.deepEqual(readdirSync(dir), ["export.jsonl"]);
  } finally {
    process.umask(previousUmask);
  }
});

test("writeTrainingExportJsonl fails explicitly on unsupported hardlink errors without falling back to rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "training-export-hardlink-"));
  for (const code of ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"] as const) {
    const output = join(dir, `export-${code}.jsonl`);
    const linkError = Object.assign(new Error(`${code}: operation not supported`), { code });
    assert.throws(
      () => writeTrainingExportJsonl(output, [{ row: 1 }], () => { throw linkError; }),
      error =>
        error instanceof Error &&
        "code" in error &&
        error.code === code &&
        /hardlink support/i.test(error.message) &&
        error.cause === linkError,
    );
    assert.equal(existsSync(output), false, `${code} must not publish destination via fallback rename`);
  }
  assert.deepEqual(readdirSync(dir), [], "temp files must be cleaned up after unsupported hardlink failures");
});

test("writeTrainingExportJsonl maps concurrent link EEXIST to destination-exists error without overwriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "training-export-race-"));
  const output = join(dir, "raced.jsonl");
  assert.throws(
    () => writeTrainingExportJsonl(output, [{ row: "new" }], (_temp, dest) => {
      // Simulate another writer winning the race just before linkSync runs.
      writeFileSync(dest, '{"row":"winner"}\n', { mode: 0o600 });
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    }),
    error => error instanceof Error && "code" in error && error.code === "EEXIST",
  );
  assert.equal(readFileSync(output, "utf8"), '{"row":"winner"}\n');
  assert.deepEqual(readdirSync(dir), ["raced.jsonl"]);
});
