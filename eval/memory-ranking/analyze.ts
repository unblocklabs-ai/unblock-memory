import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { SearchCase } from "./cases.js";
import type { Hit } from "./ranking.js";

type ScoredHit = Hit & { typesafe_score: number | null; typesafe_status: string };
export type Result = SearchCase & { hits: ScoredHit[] };
export type Label = { caseId: string; hitId: string; grade: number; reason: string; uncertain: boolean };
const mean = (values: (number | null)[]) => { const valid = values.filter((x): x is number => x !== null); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };
const dcg = (grades: number[], k: number) => grades.slice(0, k).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
export function analyze(results: Result[], labels: Label[]) {
  const labelMap = new Map<string, Label>();
  const expected = new Set(results.filter(r => r.conversation).flatMap(r => r.hits.map(h => `${r.id}:${h.id}`)));
  for (const label of labels) {
    const id = `${label.caseId}:${label.hitId}`;
    if (!expected.has(id) || labelMap.has(id) || !Number.isInteger(label.grade) || label.grade < 0 || label.grade > 3 ||
        typeof label.reason !== "string" || typeof label.uncertain !== "boolean") throw new Error("Invalid, duplicate, or foreign manual label");
    labelMap.set(id, label);
  }
  if (labelMap.size !== expected.size) throw new Error(`Incomplete manual review: ${labelMap.size}/${expected.size}`);
  const grade = (r: Result, h: Hit) => labelMap.get(`${r.id}:${h.id}`)!.grade;
  const evaluate = (clean: boolean, eligibleOnly = false) => {
    const cases = results.filter(r => r.conversation).map(r => {
      // Compare all rankers on identical successfully scored candidates; report omissions separately.
      const hits = r.hits.filter(h => h.typesafe_status === "complete" && h.typesafe_score !== null &&
        (!eligibleOnly || h.whisperer_eligible) &&
        (!clean || (!h.same_session && h.temporal !== "at_or_after_request")));
      const ideal = hits.map(h => grade(r, h)).sort((a, b) => b - a);
      const useful = hits.filter(h => grade(r, h) >= 2).length;
      const rankers = {
        // Preserve production's stable candidate order for tied TypeSafe scores,
        // and QMD's actual output order for tied RRF scores, not arbitrary hashes.
        typesafe: hits.toSorted((a, b) => b.typesafe_score! - a.typesafe_score!),
        rrf: hits.toSorted((a, b) => a.rrf_rank - b.rrf_rank),
        vector: hits.filter(h => h.vector_rank !== undefined).sort((a, b) => a.vector_rank! - b.vector_rank!),
        bm25: hits.filter(h => h.bm25_rank !== undefined).sort((a, b) => a.bm25_rank! - b.bm25_rank!),
      };
      const scores = Object.fromEntries(Object.entries(rankers).map(([name, ranked]) => {
        const grades = ranked.map(h => grade(r, h));
        return [name, { top1Useful: grades.length ? Number(grades[0]! >= 2) : null,
          top1Grade: grades[0] ?? null, bestAt2: grades.length ? Math.max(...grades.slice(0, 2)) : null,
          ndcgAt2: dcg(ideal, 2) ? dcg(grades, 2) / dcg(ideal, 2) : null,
          ndcgAt5: dcg(ideal, 5) ? dcg(grades, 5) / dcg(ideal, 5) : null,
          usefulRecallAt2: useful ? grades.slice(0, 2).filter(g => g >= 2).length / useful : null,
          topHitIds: ranked.slice(0, 5).map(h => h.id) }];
      }));
      return { caseId: r.id, turn: `${r.sessionId}:${r.userEventSeq}`, query: r.query, candidates: hits.length, useful, scores };
    });
    const aggregate = (turnBalanced: boolean) => Object.fromEntries(["typesafe", "rrf", "vector", "bm25"].map(name => [name,
      Object.fromEntries(["top1Useful", "top1Grade", "bestAt2", "ndcgAt2", "ndcgAt5", "usefulRecallAt2"].map(metric => {
        const groups = new Map<string, (number | null)[]>();
        for (const item of cases) {
          const key = turnBalanced ? item.turn : item.caseId;
          const values = groups.get(key) ?? [];
          values.push((item.scores[name] as Record<string, unknown>)[metric] as number | null); groups.set(key, values);
        }
        return [metric, mean([...groups.values()].map(mean))];
      }))]));
    return { cases, perQuery: aggregate(false), perTurn: aggregate(true) };
  };
  const predicted = results.flatMap(r => r.conversation ? r.hits.filter(h => h.typesafe_score !== null && h.typesafe_status === "complete")
    .map(h => ({ score: h.typesafe_score!, useful: grade(r, h) >= 2 })) : []);
  const bins = Array.from({ length: 5 }, (_, i) => {
    const values = predicted.filter(p => Math.min(4, Math.floor(p.score * 5)) === i);
    return { range: [i / 5, (i + 1) / 5], count: values.length, meanPrediction: mean(values.map(v => v.score)),
      referenceUsefulRate: mean(values.map(v => Number(v.useful))) };
  });
  return { searches: results.length, turns: new Set(results.map(r => `${r.sessionId}:${r.userEventSeq}`)).size,
    hits: results.reduce((n, r) => n + r.hits.length, 0), manuallyLabeled: labels.length, typesafeScored: predicted.length,
    uncertainLabels: labels.filter(l => l.uncertain).length,
    postRequestSessionHits: results.flatMap(r => r.hits).filter(h => h.temporal === "at_or_after_request").length,
    oversizedForWhisperer: results.flatMap(r => r.hits).filter(h => !h.whisperer_eligible).length,
    allCandidates: evaluate(false), withoutSameSessionOrPostRequestEvidence: evaluate(true),
    eligibleWithoutSameSessionOrPostRequestEvidence: evaluate(true, true),
    calibrationAgainstReference: { brier: mean(predicted.map(p => (p.score - Number(p.useful)) ** 2)), bins },
    limitations: ["Manual model labels are a fallible reference, not human ground truth.",
      "Current-index replay; undated files may contain information unavailable at original request time.",
      "Queries from the same user turn are correlated; per-turn means reduce repeated-query weighting.",
      "Vector/BM25 candidates absent from a method are not invented or assigned a score.",
      "RRF scores and Noul probabilities have different scales; compare rankings, not absolute score distances.",
      "All complete passages are graded; oversized passages are flagged because production Whisperer would skip them.",
      "This evaluates ranking within the retrieved union, not recall of undiscovered evidence."] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { results: { type: "string" }, labels: { type: "string" }, out: { type: "string" } } });
  if (!values.results || !values.labels || !values.out) throw new Error("analyze.ts --results RESULTS.jsonl --labels LABELS.jsonl --out NEW_SUMMARY.json");
  const load = <T>(path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
  writeFileSync(values.out, JSON.stringify(analyze(load<Result>(values.results), load<Label>(values.labels)), null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
