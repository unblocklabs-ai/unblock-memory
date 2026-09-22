// Synthetic, sanitized fixtures only. Keep labels out of the query sent to QMD.

export type RetrievalSplit = "dev" | "holdout";
export const defaultContextChars = 4_000;

export type FrozenDocument = {
  id: string;
  path: string;
  body: string;
};

export type EvidenceAlternative = {
  documentId: string;
  quote: string;
};

export type EvidenceGroup = {
  id: string;
  alternatives: readonly EvidenceAlternative[];
};

export type FrozenRetrievalCase = {
  id: string;
  split: RetrievalSplit;
  category: "identifier" | "decision" | "correction" | "temporal" | "multi-hop" | "no-answer";
  query: string;
  required: readonly EvidenceGroup[];
  forbidden?: readonly EvidenceAlternative[];
  maxContextChars?: number;
};

export const syntheticDocuments: readonly FrozenDocument[] = [
  {
    id: "decision-search-backend",
    path: "memory/decisions/search-backend.md",
    body: [
      "# Search backend decision",
      "",
      "On 2026-08-14 we chose SQLite plus QMD for the first memory search backend.",
      "The decision favors rebuildable indexes and Markdown as the canonical evidence.",
      "The vector index is an accelerator, not the source of truth.",
    ].join("\n"),
  },
  {
    id: "correction-embedding",
    path: "memory/decisions/embedding-correction.md",
    body: [
      "# Embedding benchmark correction",
      "",
      "The 128d shortlist experiment was slower and had worse recall than exact 768d.",
      "Keep exact 768d as the production baseline until a larger-corpus win is demonstrated.",
      "Do not infer Matryoshka compatibility from dimensionality alone.",
    ].join("\n"),
  },
  {
    id: "incident-owner",
    path: "memory/incidents/index-owner.md",
    body: [
      "# Index incident",
      "",
      "On 2026-08-21, Priya owned the repair for the stale index alert.",
      "The repair was approved after the read-only integrity check passed.",
      "This note is about the index incident, not the unrelated deployment review.",
    ].join("\n"),
  },
  {
    id: "incident-wrong-owner",
    path: "memory/incidents/deployment-review.md",
    body: [
      "# Deployment review",
      "",
      "On 2026-08-21, Mateo owned the deployment review.",
      "The review concerned the release checklist rather than the stale index alert.",
    ].join("\n"),
  },
  {
    id: "temporal-retention",
    path: "memory/policies/retention.md",
    body: [
      "# Retention policy",
      "",
      "As of 2026-09-02, session transcripts are retained for 30 days.",
      "The policy is measured from the session start time, not the indexing time.",
    ].join("\n"),
  },
  {
    id: "temporal-revision",
    path: "memory/policies/retention-revision.md",
    body: [
      "# Retention revision",
      "",
      "On 2026-09-18, the 30-day transcript retention policy was extended to 45 days.",
      "The older 30-day statement remains historical and should not answer a current-policy question.",
    ].join("\n"),
  },
  {
    id: "multi-hop-cadence",
    path: "memory/operations/sync-cadence.md",
    body: [
      "# Sync cadence",
      "",
      "The nightly memory sync runs at 03:00 America/New_York.",
      "It starts only after the zero-active-work preflight completes.",
    ].join("\n"),
  },
  {
    id: "multi-hop-owner",
    path: "memory/operations/sync-owner.md",
    body: [
      "# Sync owner",
      "",
      "Bek owns the nightly memory sync runbook and reviews its failures.",
      "The runbook links the cadence to the zero-active-work preflight.",
    ].join("\n"),
  },
  {
    id: "identifier-ticket",
    path: "memory/projects/atlas-ticket.md",
    body: [
      "# Atlas project",
      "",
      "The migration is tracked in ATLAS-4821.",
      "The ticket blocks the release until the source citation check is green.",
    ].join("\n"),
  },
];

export const syntheticCases: readonly FrozenRetrievalCase[] = [
  {
    id: "backend-choice",
    split: "dev",
    category: "decision",
    query: "What search backend did we choose first, and what remains canonical?",
    required: [{ id: "backend", alternatives: [{ documentId: "decision-search-backend", quote: "we chose SQLite plus QMD for the first memory search backend" }] }],
  },
  {
    id: "embedding-correction",
    split: "dev",
    category: "correction",
    query: "What did the 128d embedding experiment show compared with exact 768d?",
    required: [{ id: "correction", alternatives: [{ documentId: "correction-embedding", quote: "The 128d shortlist experiment was slower and had worse recall than exact 768d" }] }],
  },
  {
    id: "incident-owner",
    split: "dev",
    category: "decision",
    query: "Who owned the stale index alert repair?",
    required: [{ id: "owner", alternatives: [{ documentId: "incident-owner", quote: "Priya owned the repair for the stale index alert" }] }],
    forbidden: [{ documentId: "incident-wrong-owner", quote: "Mateo owned the deployment review" }],
  },
  {
    id: "current-retention",
    split: "dev",
    category: "temporal",
    query: "What is the current transcript retention policy?",
    required: [{ id: "current-policy", alternatives: [{ documentId: "temporal-revision", quote: "the 30-day transcript retention policy was extended to 45 days" }] }],
    forbidden: [{ documentId: "temporal-retention", quote: "session transcripts are retained for 30 days" }],
  },
  {
    id: "sync-plan",
    split: "dev",
    category: "multi-hop",
    query: "Who owns the nightly sync, and when does it run?",
    required: [
      { id: "cadence", alternatives: [{ documentId: "multi-hop-cadence", quote: "runs at 03:00 America/New_York" }] },
      { id: "owner", alternatives: [{ documentId: "multi-hop-owner", quote: "Bek owns the nightly memory sync runbook" }] },
    ],
    maxContextChars: 520,
  },
  {
    id: "atlas-identifier",
    split: "holdout",
    category: "identifier",
    query: "What ticket tracks the Atlas migration?",
    required: [{ id: "ticket", alternatives: [{ documentId: "identifier-ticket", quote: "tracked in ATLAS-4821" }] }],
  },
  {
    id: "unknown-provider",
    split: "holdout",
    category: "no-answer",
    query: "Which provider owns the Neptune migration?",
    required: [],
  },
  {
    id: "unknown-date",
    split: "holdout",
    category: "no-answer",
    query: "When did the Neptune migration ship?",
    required: [],
  },
];

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + Math.max(1, needle.length);
  }
}

export function validateDataset(
  documents: readonly FrozenDocument[] = syntheticDocuments,
  cases: readonly FrozenRetrievalCase[] = syntheticCases,
): void {
  const documentIds = new Set<string>();
  const paths = new Set<string>();
  for (const document of documents) {
    if (!document.id || documentIds.has(document.id)) throw new Error(`duplicate document id: ${document.id}`);
    if (!document.path || paths.has(document.path)) throw new Error(`duplicate document path: ${document.path}`);
    if (!document.body.trim()) throw new Error(`empty document: ${document.id}`);
    documentIds.add(document.id);
    paths.add(document.path);
  }
  const caseIds = new Set<string>();
  for (const item of cases) {
    if (!item.id || caseIds.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    if (!item.query.trim()) throw new Error(`empty query: ${item.id}`);
    if (item.maxContextChars !== undefined && (!Number.isSafeInteger(item.maxContextChars) || item.maxContextChars <= 0)) {
      throw new Error(`invalid budget: ${item.id}`);
    }
    caseIds.add(item.id);
    const groups = new Set<string>();
    for (const group of item.required) {
      if (!group.id || groups.has(group.id)) throw new Error(`duplicate evidence group: ${item.id}/${group.id}`);
      if (!group.alternatives.length) throw new Error(`empty evidence group: ${item.id}/${group.id}`);
      groups.add(group.id);
      for (const alternative of group.alternatives) {
        const document = documents.find(candidate => candidate.id === alternative.documentId);
        if (!document) throw new Error(`unknown evidence document: ${alternative.documentId}`);
        if (!alternative.quote || occurrences(document.body, alternative.quote) !== 1) {
          throw new Error(`evidence quote must occur exactly once: ${item.id}/${group.id}`);
        }
      }
    }
    for (const forbidden of item.forbidden ?? []) {
      const document = documents.find(candidate => candidate.id === forbidden.documentId);
      if (!document) throw new Error(`unknown forbidden document: ${forbidden.documentId}`);
      if (!forbidden.quote || occurrences(document.body, forbidden.quote) !== 1) {
        throw new Error(`forbidden quote must occur exactly once: ${item.id}`);
      }
    }
  }
}

validateDataset();
