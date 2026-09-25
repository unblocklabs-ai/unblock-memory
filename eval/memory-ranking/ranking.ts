import { createHash, randomInt } from "node:crypto";
import type { QMDStore } from "@unblocklabs/qmd";
import { trainingCandidates } from "../../src/training-candidates.js";
import type { SessionManifest } from "../../src/session-sync.js";
import { hash, type SearchCase } from "./cases.js";

type Ranked = { file: string; displayPath: string; title: string; body: string; score: number };
type Rrf = (lists: Ranked[][], weights?: number[], k?: number) => Ranked[];
export type Hit = {
  id: string; source: string; corpus: string; position: number; lines: string; body: string;
  vector_score?: number; vector_rank?: number; bm25_score?: number; bm25_rank?: number;
  rrf_score: number; rrf_rank: number; messageTimestamp?: string;
  temporal: "before_request" | "at_or_after_request" | "undated_or_unverified";
  same_session: boolean; whisperer_eligible: boolean;
};
export type Retrieval = { caseId: string; elapsedMs: number; hits: Hit[]; error?: string };
export type Judgment = { caseId: string; hitId: string; inputHash: string; status: "attempted" | "complete" | "failed";
  typesafe_score?: number; elapsedMs?: number; error?: string; httpStatus?: number };
type Projection = Pick<SessionManifest["sessions"][string], "projectionHash" | "messages">;

export function fusePassages(candidates: Awaited<ReturnType<typeof trainingCandidates>>, rrf: Rrf) {
  const lists: Ranked[][] = [[], []];
  for (const candidate of candidates) {
    const id = hash([candidate.file, candidate.bestChunk.trim()]);
    for (const [index, method] of ["vector", "bm25"].entries()) {
      const match = candidate[method as "vector" | "bm25"];
      if (match) lists[index]![match.rank - 1] = { file: id, displayPath: candidate.file, title: "", body: candidate.bestChunk, score: match.score };
    }
  }
  // QMD keys by file. Pass passage IDs as its file key so distinct chunks stay distinct.
  // Sparse slots preserve original method ranks if a returned passage was invalid/duplicate.
  return new Map(rrf(lists, [1, 1], 60).map((hit, index) => [hit.file, { score: hit.score, rank: index + 1 }]));
}

export async function retrieve(qmd: QMDStore, item: SearchCase, collections: Map<string, string>,
  projections: ReadonlyMap<string, Projection> = new Map()): Promise<Retrieval> {
  const started = performance.now();
  const requested = item.requestedCorpora;
  const scope = [...collections].filter(([, corpus]) => !requested || requested.includes(corpus));
  if (!scope.length) return { caseId: item.id, elapsedMs: 0, hits: [], error: "no_approved_collections" };
  const candidates = await trainingCandidates(qmd, item.query, scope.map(([collection]) => collection), item.query);
  const { reciprocalRankFusion } = await import(new URL("./store.js", import.meta.resolve("@unblocklabs/qmd")).href) as { reciprocalRankFusion: Rrf };
  const fused = fusePassages(candidates, reciprocalRankFusion);
  const hits: Hit[] = candidates.map(candidate => {
    const id = hash([candidate.file, candidate.bestChunk.trim()]);
    const corpus = collections.get(candidate.file.split("/")[2]!)!;
    const position = candidate.bestChunkPos, body = candidate.bestChunk;
    const projection = projections.get(candidate.file.split("/").slice(3).join("/"));
    // Rendered Markdown can contain unclosed fences and quoted message headings.
    // Only exact, hash-matched projector boundaries can establish chronology.
    const spans = corpus === "sessions" && projection?.messages &&
      projection.projectionHash === createHash("sha256").update(candidate.body).digest("hex")
      ? projection.messages.filter(s => s.start < position + body.length && s.end > position) : [];
    const times = spans.map(s => Date.parse(s.timestamp));
    const cutoff = Math.floor(Date.parse(item.userTimestamp ?? item.searchedAt) / 1000) * 1000;
    const temporal = times.some(time => time >= cutoff) ? "at_or_after_request" :
      times.length && times.every(Number.isFinite) ? "before_request" : "undated_or_unverified";
    const from = candidate.body.slice(0, position).split("\n").length;
    return { id, source: candidate.file, corpus, position, body, lines: `${from}-${from + body.split("\n").length - 1}`,
      ...(candidate.vector ? { vector_score: candidate.vector.score, vector_rank: candidate.vector.rank } : {}),
      ...(candidate.bm25 ? { bm25_score: candidate.bm25.score, bm25_rank: candidate.bm25.rank } : {}),
      rrf_score: fused.get(id)!.score, rrf_rank: fused.get(id)!.rank,
      ...(spans[0] ? { messageTimestamp: spans[0].timestamp } : {}), temporal,
      same_session: candidate.file.includes(item.sessionId), whisperer_eligible: body.trim().length <= 1200 };
  });
  return { caseId: item.id, elapsedMs: performance.now() - started, hits };
}

/** Do not expose query wording, method membership, rank, score, or score-sorted IDs. */
export function blindCase(item: SearchCase, hits: Hit[]) {
  const passages = hits.map(hit => ({ id: hit.id, source: hit.source, lines: hit.lines, body: hit.body,
    ...(hit.messageTimestamp ? { messageTimestamp: hit.messageTimestamp } : {}) }));
  for (let index = passages.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [passages[index], passages[other]] = [passages[other]!, passages[index]!];
  }
  return { caseId: item.id, asOf: item.userTimestamp, conversation: item.conversation, passages };
}
