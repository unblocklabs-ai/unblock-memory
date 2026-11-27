import { readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { openMemoryDatabase } from "../../src/memory-database.js";
import { SessionSyncState, type SessionManifest } from "../../src/session-sync-state.js";
import type { SessionIndex } from "../../src/session-sync.js";

type SessionDocument = Parameters<SessionIndex["upsert"]>[0];

/** In-memory stand-in for QMD's projected sessions collection (generation semantics included). */
export function fakeSessionIndex(options: { path?: string } = {}) {
  const documents = new Map<string, SessionDocument>();
  let generation = 0;
  const stats = { upserts: 0, retracts: 0, replaces: 0, embeds: 0 };
  const hooks: { embed?: () => number | Promise<number>; ready?: () => boolean | Promise<boolean> } = {};
  // Any committed QMD write changes the index file, which invalidates the quiet-check signature.
  const touch = () => { if (options.path) writeFileSync(options.path, `generation-${generation}-embed-${stats.embeds}`); };
  const same = (left: SessionDocument | undefined, right: SessionDocument) =>
    left?.content === right.content && left.createdAt === right.createdAt && left.modifiedAt === right.modifiedAt;
  const index: SessionIndex = {
    path: options.path,
    async generation() { return generation; },
    async upsert(document) {
      stats.upserts++;
      if (same(documents.get(document.path), document)) return false;
      documents.set(document.path, document); generation++; touch();
      return true;
    },
    async retract(path) {
      stats.retracts++;
      if (!documents.delete(path)) return false;
      generation++; touch();
      return true;
    },
    async replace(desired) {
      stats.replaces++;
      const wanted = new Map(desired.map(document => [document.path, document]));
      let changed = 0;
      for (const path of [...documents.keys()]) if (!wanted.has(path)) { documents.delete(path); changed++; }
      for (const document of desired) {
        if (same(documents.get(document.path), document)) continue;
        documents.set(document.path, document); changed++;
      }
      if (changed) { generation++; touch(); }
      return changed;
    },
    async embed() {
      stats.embeds++;
      const embedded = hooks.embed ? await hooks.embed() : 1;
      touch();
      return embedded;
    },
    async ready() { return hooks.ready ? await hooks.ready() : true; },
  };
  return {
    index, documents, stats, hooks,
    content: (path: string) => documents.get(path)?.content,
    /** Simulate another writer changing the collection behind the manifest's back. */
    externalChange() { generation++; },
  };
}

/** SQLite-backed manifest store on a private `unblock-memory.sqlite`, as production uses. */
export function sqliteSessionState(path: string, agentId = "main", legacyDir?: string) {
  const db = openMemoryDatabase(path);
  const state = new SessionSyncState(db, agentId, legacyDir);
  return {
    db, state,
    store: { read: () => state.readManifest(), write: (manifest: SessionManifest) => state.writeManifest(manifest) },
    close: () => db.close(),
  };
}

/** Every file under `root`, relative and sorted. */
export function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}
