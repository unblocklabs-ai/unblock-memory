import { DEFAULTS } from "./defaults.js";
import { abortable } from "./abortable.js";
import type { UnblockMemoryConfig } from "./config.js";
import {
  extractWithDecisionModel,
  validateExtractedMemory,
  EXTRACTION_VERSION,
  type ExtractionMessage,
  type MemoryProposal,
} from "./extraction-model.js";
import {
  buildCompleteRevision,
  ExtractionLeaseLostError,
  extractionPolicyFingerprint,
  ExtractionStore,
  type ExtractedRecord,
  type ExtractionSession,
} from "./extraction-store.js";
import { readExtractionPage } from "./extraction-source.js";
import { extractionHistory, readExtractionChunk } from "./extraction-chunk.js";
import { resolveDecisionCredential } from "./decision-client.js";

type ValidationJudgment = Awaited<ReturnType<typeof validateExtractedMemory>>;
type AcceptedCandidate = {
  proposal: MemoryProposal;
  observedAt: number;
  judgment: ValidationJudgment;
  order: number;
};
type SessionOutcome = {
  processed: number;
  accepted: number;
  rejected: number;
  unchanged: number;
  failed: number;
};

function handleResetOrMissing(
  store: ExtractionStore,
  sessionId: string,
  page: { kind: string; cursor?: string | null },
  owner: string,
  policyFingerprint: string,
): page is { kind: "reset"; cursor: string | null } | { kind: "missing" } {
  if (page.kind !== "reset" && page.kind !== "missing") return false;
  store.reset(sessionId, page.kind === "reset" ? (page.cursor ?? null) : null, owner, policyFingerprint);
  return true;
}

function scoreField(judgment: ValidationJudgment, key: "replacement" | "supported" | "useful"): number {
  return "scores" in judgment && judgment.scores ? judgment.scores[key] : 0;
}

function isBetterReplacement(candidate: AcceptedCandidate, incumbent: AcceptedCandidate): boolean {
  if (candidate.observedAt !== incumbent.observedAt) return candidate.observedAt > incumbent.observedAt;
  for (const key of ["replacement", "supported", "useful"] as const) {
    const diff = scoreField(candidate.judgment, key) - scoreField(incumbent.judgment, key);
    if (diff !== 0) return diff > 0;
  }
  return candidate.order < incumbent.order;
}

async function validateProposals(params: {
  proposals: MemoryProposal[];
  messages: ExtractionMessage[];
  newIds: string[];
  existing: ExtractedRecord[];
  apiKey: string;
  config: UnblockMemoryConfig;
  signal: AbortSignal;
  validate: typeof validateExtractedMemory;
}) {
  const { proposals, messages, newIds, existing, apiKey, config, signal, validate } = params;
  const messageById = new Map(messages.map(m => [m.id, m]));
  const existingById = new Map(existing.map(m => [m.id, m]));
  const standalone: AcceptedCandidate[] = [];
  const winnerByPredecessor = new Map<string, AcceptedCandidate>();
  let rejected = 0;

  for (let start = 0; start < proposals.length; start += DEFAULTS.extraction.validatorBatchSize) {
    signal.throwIfAborted();
    // Isolated judgments overlap, but failed chunks drain before their lease is released.
    const judgments = await Promise.allSettled(
      proposals.slice(start, start + DEFAULTS.extraction.validatorBatchSize).map(async (proposal, offset) => ({
        proposal,
        order: start + offset,
        judgment: await validate({
          proposal,
          messages,
          newIds,
          existing,
          apiKey,
          endpoint: config.decisionModel.endpoint,
          model: config.decisionModel.model,
          signal,
          thresholds: config.extraction,
        }),
      })),
    );
    const failure = judgments.find(result => result.status === "rejected");
    if (failure) throw failure.reason;

    for (const result of judgments) {
      if (result.status !== "fulfilled") continue;
      const { proposal, judgment, order } = result.value;
      if (!judgment.accepted) {
        rejected++;
        continue;
      }
      let observedAt = -Infinity;
      let missingEvidence = false;
      const mappedEvidence: MemoryProposal["evidence"] = [];
      for (const item of proposal.evidence) {
        const message = messageById.get(item.messageId);
        if (!message) {
          missingEvidence = true;
          break;
        }
        if (message.timestamp > observedAt) observedAt = message.timestamp;
        mappedEvidence.push({ ...item, messageId: message.sourceMessageId ?? item.messageId });
      }
      if (missingEvidence || !Number.isFinite(observedAt)) {
        rejected++;
        continue;
      }
      const prior = proposal.replaces ? existingById.get(proposal.replaces) : undefined;
      if (proposal.replaces && (!prior || prior.observedAt > observedAt)) {
        rejected++;
        continue;
      }
      const candidate: AcceptedCandidate = {
        proposal: { ...proposal, evidence: mappedEvidence },
        judgment,
        observedAt,
        order,
      };
      if (proposal.replaces) {
        const incumbent = winnerByPredecessor.get(proposal.replaces);
        if (!incumbent) {
          winnerByPredecessor.set(proposal.replaces, candidate);
        } else {
          if (isBetterReplacement(candidate, incumbent)) {
            winnerByPredecessor.set(proposal.replaces, candidate);
          }
          rejected++;
        }
      } else {
        standalone.push(candidate);
      }
    }
  }

  const accepted = [...standalone, ...winnerByPredecessor.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ proposal, observedAt, judgment }) => ({ proposal, observedAt, judgment }));
  return { accepted, rejected };
}

async function processSession(params: {
  session: ExtractionSession;
  store: ExtractionStore;
  owner: string;
  config: UnblockMemoryConfig;
  agentId: string;
  agentName: string;
  since?: number;
  version: string;
  policyFingerprint: string;
  apiKey: string;
  signal: AbortSignal;
  leaseAbort: AbortController;
  readPage: typeof readExtractionPage;
  extract: typeof extractWithDecisionModel;
  validate: typeof validateExtractedMemory;
}): Promise<SessionOutcome> {
  const {
    session, store, owner, config, agentId, agentName, since,
    version, policyFingerprint, apiKey, signal, leaseAbort, readPage, extract, validate,
  } = params;
  const extractionConfig = config.extraction;
  const checkpoint = store.checkpoint(session, owner, since, policyFingerprint);
  const expectedCompleteRevision = session.sourceRevision === undefined
    ? undefined
    : buildCompleteRevision(session.sourceRevision, policyFingerprint);
  if (expectedCompleteRevision !== undefined && checkpoint.completeRevision === expectedCompleteRevision) {
    return { processed: 0, accepted: 0, rejected: 0, unchanged: 1, failed: 0 };
  }

  let stage = "read";
  try {
    const existing = store.records(session.sessionId);
    if (existing.length > DEFAULTS.extraction.maxExistingFacts || JSON.stringify(existing.map(m => ({ id: m.id, text: m.text }))).length > DEFAULTS.extraction.maxExistingChars) {
      throw new Error("Existing memories exceed review budget");
    }
    const existingFacts = existing.map(m => ({ id: m.id, text: m.text, observedAt: m.observedAt }));
    const page = await readExtractionChunk({
      agentId,
      agentName,
      session,
      cursor: checkpoint.cursor,
      context: extractionHistory(checkpoint.context, extractionConfig.historyMessages),
      existing: existingFacts,
      signal,
      readPage,
    });
    signal.throwIfAborted();
    if (page.kind === "unavailable") {
      store.error(session.sessionId, "source_unavailable", owner);
      return { processed: 1, accepted: 0, rejected: 0, unchanged: 0, failed: 1 };
    }
    if (handleResetOrMissing(store, session.sessionId, page, owner, policyFingerprint)) {
      return { processed: 1, accepted: 0, rejected: 0, unchanged: 0, failed: 0 };
    }
    if (!page.entryCount) {
      store.completeEmpty({
        sessionId: session.sessionId,
        expected: checkpoint.cursor,
        owner,
        completeRevision: page.exhausted ? expectedCompleteRevision : undefined,
        policyFingerprint,
      });
      return { processed: 0, accepted: 0, rejected: 0, unchanged: 1, failed: 0 };
    }

    const freshIds = new Set(page.newIds);
    const messages = page.messages;
    const newIds = messages.filter(m => freshIds.has(m.id) && m.timestamp >= checkpoint.since).map(m => m.id);
    stage = "propose";
    const proposals = newIds.length ? await extract({ messages, newIds, existing: existingFacts, apiKey, signal,
      endpoint: config.decisionModel.endpoint, model: config.decisionModel.model, minReplacement: extractionConfig.minReplacement }) : [];

    stage = "validate";
    const { accepted, rejected } = await validateProposals({
      proposals,
      messages,
      newIds,
      existing,
      apiKey,
      config,
      signal,
      validate,
    });

    // A branch rewrite during inference invalidates its proposals. Appends are safe and processed next time.
    signal.throwIfAborted();
    const checkPending = readPage(agentId, agentName, session, page.fence, undefined, signal);
    void checkPending.catch(() => {});
    const check = await abortable(checkPending, signal);
    signal.throwIfAborted();
    if (handleResetOrMissing(store, session.sessionId, check, owner, policyFingerprint)) {
      return { processed: 1, accepted: 0, rejected, unchanged: 0, failed: 0 };
    }
    if (check.kind === "unavailable") throw new Error("Source changed during extraction");

    const context = extractionHistory(messages, extractionConfig.historyMessages);
    stage = "commit";
    const written = store.commit({
      session,
      expected: checkpoint.cursor,
      cursor: page.cursor,
      context,
      accepted,
      owner,
      version,
      completeRevision: page.exhausted ? expectedCompleteRevision : undefined,
      policyFingerprint,
    });
    return { processed: 1, accepted: written, rejected, unchanged: 0, failed: 0 };
  } catch (error) {
    if (error instanceof ExtractionLeaseLostError) {
      leaseAbort.abort(error);
      throw error;
    }
    signal.throwIfAborted();
    store.error(session.sessionId, `${stage}_failed`, owner);
    return { processed: 1, accepted: 0, rejected: 0, unchanged: 0, failed: 1 };
  }
}

export async function runExtraction(params: { config: UnblockMemoryConfig; storePath: string; agentId: string;
  agentName: string; sessions: () => ExtractionSession[]; signal: AbortSignal;
  since?: number; sessionId?: string; scheduled?: boolean; version?: string; readPage?: typeof readExtractionPage;
  extract?: typeof extractWithDecisionModel; validate?: typeof validateExtractedMemory }) {
  const config = params.config.extraction;
  if (!config.enabled) return { status: "disabled" as const };
  params.signal.throwIfAborted();
  const apiKey = await abortable(resolveDecisionCredential(params.config.decisionModel), params.signal);
  params.signal.throwIfAborted();
  if (!apiKey) return { status: "unavailable" as const, reason: "Decision model API key not configured" };
  const store = new ExtractionStore(params.storePath);
  const owner = store.claim(params.scheduled ?? false, config.intervalMinutes * 60_000);
  if (!owner) { store.close(); return { status: "not_due_or_busy" as const }; }
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([params.signal, leaseAbort.signal, AbortSignal.timeout(DEFAULTS.extraction.runTimeoutMs)]);
  const heartbeat = setInterval(() => { try { store.renew(owner); } catch (error) { leaseAbort.abort(error); } }, DEFAULTS.extraction.heartbeatMs);
  heartbeat.unref();
  let processed = 0, acceptedCount = 0, rejectedCount = 0, unchanged = 0, failed = 0;
  const readPage = params.readPage ?? readExtractionPage;
  const extract = params.extract ?? extractWithDecisionModel;
  const validate = params.validate ?? validateExtractedMemory;
  const version = params.version ?? EXTRACTION_VERSION;
  const policyFingerprint = extractionPolicyFingerprint({
    version,
    historyMessages: config.historyMessages,
    minSupport: config.minSupport,
    minRetention: config.minRetention,
    minReplacement: config.minReplacement,
    extractorModel: params.config.decisionModel.model,
    validatorModel: params.config.decisionModel.model,
  });
  try {
    const sessions = params.sessions();
    const visible = new Set(sessions.map(s => s.sessionId));
    if (params.sessionId && !visible.has(params.sessionId)) throw new Error("Unknown or unapproved extraction session");
    for (const { session_id } of store.db.prepare("SELECT DISTINCT session_id FROM extracted_memories WHERE status='active'").all()) {
      if (!visible.has(String(session_id))) store.reset(String(session_id), null, owner);
    }
    // Oldest last-checked first: bounded runs must not starve later sessions.
    const checked = new Map(store.db.prepare("SELECT session_id,updated_at FROM extraction_sessions").all()
      .map(r => [String(r.session_id), Number(r.updated_at)]));
    sessions.sort((a, b) => (checked.get(a.sessionId) ?? 0) - (checked.get(b.sessionId) ?? 0));
    for (const session of sessions) {
      signal.throwIfAborted();
      if (params.sessionId && params.sessionId !== session.sessionId) continue;
      if (!checked.has(session.sessionId) && (session.changedAt ?? Infinity) < (params.since ?? store.liveSince())) continue;
      if (processed >= config.maxBatches) break;
      const outcome = await processSession({
        session,
        store,
        owner,
        config: params.config,
        agentId: params.agentId,
        agentName: params.agentName,
        since: params.since,
        version,
        policyFingerprint,
        apiKey,
        signal,
        leaseAbort,
        readPage,
        extract,
        validate,
      });
      processed += outcome.processed;
      acceptedCount += outcome.accepted;
      rejectedCount += outcome.rejected;
      unchanged += outcome.unchanged;
      failed += outcome.failed;
    }
    return { status: "completed" as const, processed, accepted: acceptedCount, rejected: rejectedCount, unchanged, failed };
  } finally { clearInterval(heartbeat); store.release(owner); store.close(); }
}
