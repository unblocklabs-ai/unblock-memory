import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("runtime verifier accepts empty edit reports for clean and structural-only corpora", async () => {
  for (const [body, skipped, edits] of [
    ["Decision: retain this useful memory.\n", 0, ""],
    ["## REM Sleep\n<!-- openclaw:dreaming:rem:start -->\n", 1, "\n \n"],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "unblock-memory-zero-edits-"));
    const state = join(root, "state");
    const reportDir = join(root, "shadow");
    const bundle = join(root, "bundle");
    const plugin = join(root, "packages/plugin");
    const put = async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    };
    await put(join(root, "package.json"), '{"type":"module"}');
    const manifest = '{"sessions":{}}';
    await put(join(state, "agents/main/unblock-memory/sessions-manifest.json"), manifest);
    await put(join(reportDir, "summary.json"), JSON.stringify({
      inputsStable: true, manifestSha256: hash(manifest),
      documentFingerprints: [{ collection: "memory", path: "memory.md", sha256: hash(body) }],
    }));
    await put(join(reportDir, "edits.jsonl"), edits);
    const baseline = new URL("../eval/noise-parser/parser.ts", import.meta.url).href;
    await put(join(bundle, "baseline-parser.mjs"), `export * from ${JSON.stringify(baseline)};`);
    // Focus this CLI fixture on JSONL handling and the structural-only path.
    // Actual projector and QMD behavior have their own integration tests.
    const noEvents = 'export function projectSession() { throw new Error("No source events expected"); }';
    await put(join(plugin, "dist/src/session-projector.js"), noEvents);
    await put(join(bundle, "session-projector.js"), noEvents);
    await put(join(root, "packages/qmd/dist/semantic-chunking.js"),
      'export async function chunkMarkdownSemantically(text) { return [{text,pos:0,tokens:1}]; }');
    await put(join(bundle, "semantic-chunking.js"),
      'import {structuralChunkReason} from "./baseline-parser.mjs"; export async function chunkMarkdownSemantically(text) { return structuralChunkReason(text,0,text.length) ? [] : [{text,pos:0,tokens:1}]; }');
    const index = new DatabaseSync(join(state, "agents/main/unblock-memory/index.sqlite"));
    index.exec("CREATE TABLE content(hash TEXT,doc TEXT); CREATE TABLE documents(id INTEGER,collection TEXT,path TEXT,hash TEXT,active INTEGER)");
    index.prepare("INSERT INTO content VALUES (?,?)").run(hash(body), body);
    index.prepare("INSERT INTO documents VALUES (1,'memory','memory.md',?,1)").run(hash(body));
    index.close();
    await mkdir(join(state, "agents/main/agent"), { recursive: true });
    const raw = new DatabaseSync(join(state, "agents/main/agent/openclaw-agent.sqlite"));
    raw.exec("CREATE TABLE session_transcript_active_events(session_id TEXT,event_seq INTEGER,active_position INTEGER); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,created_at INTEGER)");
    raw.close();
    const output = join(root, "result");
    await run(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../eval/noise-parser/verify-runtime.mjs", import.meta.url)),
      state, plugin, reportDir, bundle, output], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(await readFile(join(output, "summary.json"), "utf8")), {
      model: "deterministic hash vectors and character-count tokenizer; no model calls",
      documents: 1, projectionEventsChecked: 0, changedProjectionEvents: 0, changedRuntimeSessions: 0,
      chunkPasses: [300, 128].map(maxTokens => ({ maxTokens, beforeChunks: 1, afterChunks: 1-skipped,
        structuralChunksSkipped: skipped, retainedCharactersChecked: body.length })),
      inputsStable: true,
    });
  }
});
