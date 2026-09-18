import type { QMDStore } from "@unblocklabs/qmd";
import { readAnalysisSummary, readCluster } from "./analysis.js";
import { parseSafeVirtualPath, type ResolvedSource } from "./sources.js";
import { reviewClusterDefects } from "./typesafe-review.js";
import { chunkFingerprint } from "./curation.js";

/** Inspect center and edge samples; never extrapolate their labels to the rest of a cluster. */
export async function reviewClusterIngestion(params: {
  db: QMDStore["internal"]["db"]; sources: readonly ResolvedSource[]; clusterId: string;
  apiKey: string; timeoutMs: number; signal: AbortSignal;
  read?: <T>(run: () => T) => Promise<T>;
}) {
  params.signal.throwIfAborted();
  const sources = new Map(params.sources.filter(source => source.kind !== "skills").map(source => [source.collection, source]));
  const read = params.read ?? (async <T>(run: () => T) => run());
  const snapshot = await read(() => {
    const center = readCluster(params.db, params.clusterId, 3, 0, "representative");
    if (center.status !== "ok" || center.stale) return { status: "unavailable" as const, reason: "Cluster missing or stale; refresh analysis first" };
    const edge = readCluster(params.db, params.clusterId, 3, 0, "score_asc");
    const candidates = [...new Map([...(center.members ?? []), ...(edge.members ?? [])].map(member => [`${member.hash}:${member.seq}`, member])).values()];
    const sample = candidates.flatMap(member => {
      const path = member.sourcePaths.find(path => parseSafeVirtualPath(path, sources));
      if (!path) return [];
      const safe = parseSafeVirtualPath(path, sources)!;
      // Reload the full chunk; analysis previews may be truncated. Never judge a silently cut prefix.
      const row = params.db.prepare(`SELECT c.doc, v.pos, v.chunk_len FROM documents d JOIN content c ON c.hash = d.hash
        JOIN content_vectors v ON v.hash = d.hash WHERE d.active = 1 AND d.collection = ? AND d.path = ? AND d.hash = ? AND v.seq = ?`)
        .get<{ doc: string; pos: number; chunk_len: number }>(safe.source.collection, safe.relativePath, member.hash, member.seq);
      if (!row || row.pos < 0 || row.chunk_len < 1 || row.pos + row.chunk_len > row.doc.length || row.chunk_len > 2000) return [];
      const text = row.doc.slice(row.pos, row.pos + row.chunk_len);
      return [{ path, hash: member.hash, seq: member.seq, from: row.doc.slice(0, row.pos).split("\n").length,
        fingerprint: chunkFingerprint(text), text }];
    });
    return { status: "ready" as const, sample, considered: candidates.length, runId: center.runId, clusterSize: center.cluster?.availableSize };
  });
  if (snapshot.status !== "ready") return snapshot;
  const { sample } = snapshot;
  if (!sample.length) return { status: "unavailable" as const, reason: "No complete bounded members in approved corpora" };
  const judgments = await reviewClusterDefects({ ...params, excerpts: sample.map(member => member.text) });
  params.signal.throwIfAborted();
  return read(() => {
    const current = readAnalysisSummary(params.db);
    if (!current || current.stale || current.runId !== snapshot.runId) return { status: "unavailable" as const, reason: "Analysis changed during review; retry" };
    for (const member of sample) {
      const safe = parseSafeVirtualPath(member.path, sources);
      if (!safe) return { status: "unavailable" as const, reason: "Source scope changed; retry" };
      const row = params.db.prepare(`SELECT c.doc, v.pos, v.chunk_len FROM documents d JOIN content c ON c.hash = d.hash
        JOIN content_vectors v ON v.hash = d.hash WHERE d.active = 1 AND d.collection = ? AND d.path = ? AND d.hash = ? AND v.seq = ?`)
        .get<{ doc: string; pos: number; chunk_len: number }>(safe.source.collection, safe.relativePath, member.hash, member.seq);
      if (!row || chunkFingerprint(row.doc.slice(row.pos, row.pos + row.chunk_len)) !== member.fingerprint) return { status: "unavailable" as const, reason: "Sample changed during review; retry" };
    }
    const members = sample.map(({ text: _text, ...member }, index) => ({ ...member, ...judgments[index],
      flagged: judgments[index].defect !== "none_or_uncertain" && judgments[index].confidence >= 0.9 }));
    const recurring = ["wrapper", "encoding", "boilerplate"].flatMap(defect => {
      const examples = members.filter(member => member.flagged && member.defect === defect);
      return examples.length >= 2 ? [{ defect, examples: examples.map(member => ({ path: member.path, from: member.from, fingerprint: member.fingerprint })) }] : [];
    });
    return { status: "ok" as const, runId: snapshot.runId, clusterId: params.clusterId, members, recurring,
      sampled: sample.length, considered: snapshot.considered, clusterSize: snapshot.clusterSize,
      policy: "jev-1.13.0:cluster-defects-v1", scope: "Center/edge sample of approved complete chunks only. Recurring labels are hypotheses, not proof of a shared cause or permission to change any member. Unreviewed members remain unknown." };
  });
}
