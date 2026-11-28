import { DEFAULTS } from "./defaults.js";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { EXTRACTION_INPUT_LIMIT, EXTRACTION_INPUT_TARGET, extractionMessageBytes, extractionMessageTokens, extractionOverhead,
  extractionValidationTranscriptBudget, type ExtractionMessage } from "./extraction-model.js";
import { bindExtractionPageReader } from "./extraction-source.js";
import { jsonHash } from "./json-hash.js";

const PREFIX = "unblock-extraction:v1:";
const bookmarkSchema = Type.Object({ before: Type.Union([Type.Null(), Type.String()]), fence: Type.String(),
  index: Type.Integer({ minimum: 0 }), offset: Type.Integer({ minimum: 0 }), id: Type.String(), hash: Type.String() });
function fragment(message: ExtractionMessage, start: number, end: number): ExtractionMessage {
  const sourceMessageId = message.sourceMessageId ?? message.id, offset = (message.textOffset ?? 0) + start;
  return { ...message, sourceMessageId, textOffset: offset,
    id: `extraction-fragment:${JSON.stringify([sourceMessageId, offset, (message.textOffset ?? 0) + end])}`,
    text: message.text.slice(start, end) };
}
// Never split a UTF-16 surrogate pair; quotes remain exact substrings of the source.
function boundary(text: string, end: number) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!) ? end - 1 : end;
}
function prefixThatFits(message: ExtractionMessage, offset: number, tokens: number, bytes: number) {
  let low = offset, high = message.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const part = fragment(message, offset, boundary(message.text, mid));
    if (extractionMessageBytes(part) <= bytes && extractionMessageTokens(part) <= tokens) low = mid;
    else high = mid - 1;
  }
  const end = boundary(message.text, low);
  if (end <= offset) throw new Error("No room for extraction message");
  return end;
}

export function extractionHistory(messages: ExtractionMessage[], count: number): ExtractionMessage[] {
  if (!count) return [];
  const kept: ExtractionMessage[] = [];
  let remaining = DEFAULTS.extraction.historyTokenBudget;
  // Give history the same share of the validation byte budget as of the input token budget.
  let remainingBytes = Math.floor(extractionValidationTranscriptBudget() * remaining / EXTRACTION_INPUT_LIMIT);
  for (const message of messages.slice(-count).reverse()) {
    const tokens = extractionMessageTokens(message);
    const bytes = extractionMessageBytes(message);
    if (tokens <= remaining && bytes <= remainingBytes) {
      kept.unshift(message); remaining -= tokens; remainingBytes -= bytes; continue;
    }
    if (!kept.length) {
      // Keep the tail of a very large message as overlap, rather than dropping it.
      let low = 0, high = message.text.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const part = fragment(message, boundary(message.text, mid), message.text.length);
        if (extractionMessageBytes(part) <= remainingBytes && extractionMessageTokens(part) <= remaining) high = mid;
        else low = mid + 1;
      }
      const start = low < message.text.length && boundary(message.text, low) !== low ? low + 1 : low;
      if (start < message.text.length) kept.unshift(fragment(message, start, message.text.length));
    }
    break;
  }
  return kept;
}

/**
 * The host cursor that fences a stored checkpoint cursor: the bookmark's page fence, or the cursor itself.
 * Undefined for a malformed bookmark, which callers must treat as a source reset.
 */
export function checkpointFence(cursor: string): string | undefined {
  return cursor.startsWith(PREFIX) ? decodeBookmark(cursor)?.fence : cursor;
}

/** A persisted `PREFIX` bookmark, or undefined when its payload is malformed (a source reset). */
function decodeBookmark(cursor: string): Static<typeof bookmarkSchema> | undefined {
  try {
    const parsed: unknown = JSON.parse(cursor.slice(PREFIX.length));
    return Value.Check(bookmarkSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** SDK pages are transport only. A chunk always belongs to exactly one session. */
export async function readExtractionChunk(params: { cursor: string | null; context: ExtractionMessage[] } &
  (Parameters<typeof bindExtractionPageReader>[0] | { fetchPage: ReturnType<typeof bindExtractionPageReader> })) {
  const fetchPage = "fetchPage" in params ? params.fetchPage : bindExtractionPageReader(params);
  let resume: Static<typeof bookmarkSchema> | undefined;
  if (params.cursor?.startsWith(PREFIX)) {
    resume = decodeBookmark(params.cursor);
    if (!resume) return { kind: "reset" as const, cursor: null };
    const check = await fetchPage(resume.fence);
    if (check.kind !== "page") return check;
  }
  const startingFence = resume?.fence;
  let cursor = resume ? resume.before : params.cursor;
  const messages = [...params.context];
  let tokens = extractionOverhead() + messages.reduce((n, m) => n + extractionMessageTokens(m), 0);
  let bytes = messages.reduce((n, m) => n + extractionMessageBytes(m), 0);
  const byteLimit = extractionValidationTranscriptBudget();
  let entryCount = 0;
  const newIds: string[] = [];
  for (;;) {
    const before = cursor;
    const page = await fetchPage(before);
    if (page.kind !== "page") return page;
    if ((page.entryCount && page.cursor === before) || (!page.entryCount && page.hasMore)) throw new Error("Transcript reader made no progress");
    if (resume) {
      const target = page.messages[resume.index];
      if (
        !target ||
        target.id !== resume.id ||
        jsonHash(target) !== resume.hash ||
        resume.offset >= target.text.length ||
        (resume.offset > 0 && boundary(target.text, resume.offset) !== resume.offset)
      ) {
        return { kind: "reset" as const, cursor: null };
      }
    }
    entryCount += page.entryCount;
    const finish = (index: number, offset = 0) => {
      const next = page.messages[index];
      return { kind: "page" as const, messages, newIds, entryCount, fence: startingFence ?? page.cursor,
        exhausted: !next && !page.hasMore,
        cursor: next ? PREFIX + JSON.stringify({ before, fence: page.cursor, index, offset, id: next.id, hash: jsonHash(next) }) : page.cursor };
    };
    for (let i = resume?.index ?? 0; i < page.messages.length; i++) {
      const message = page.messages[i]!;
      const offset = i === resume?.index ? resume.offset : 0;
      if (offset >= message.text.length) throw new Error("Invalid extraction text offset");
      const candidate = offset ? fragment(message, offset, message.text.length) : message;
      const cost = extractionMessageTokens(candidate);
      const byteCost = extractionMessageBytes(candidate);
      if (tokens + cost > EXTRACTION_INPUT_LIMIT || bytes + byteCost > byteLimit) {
        if (newIds.length) return finish(i, offset);
        const end = prefixThatFits(message, offset, EXTRACTION_INPUT_TARGET - tokens, byteLimit - bytes);
        const part = fragment(message, offset, end);
        messages.push(part); newIds.push(part.id);
        return finish(i, end);
      }
      messages.push(candidate); newIds.push(candidate.id); tokens += cost; bytes += byteCost;
      if (tokens >= EXTRACTION_INPUT_TARGET) return finish(i + 1);
    }
    resume = undefined;
    cursor = page.cursor;
    if (!page.hasMore) return finish(page.messages.length);
  }
}
