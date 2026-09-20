import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { EXTRACTION_INPUT_LIMIT, EXTRACTION_INPUT_TARGET, extractionMessageTokens, extractionOverhead } from "./extraction-model.js";
import { readExtractionPage } from "./extraction-source.js";
const PREFIX = "unblock-extraction:v1:";
const bookmarkSchema = Type.Object({ before: Type.Union([Type.Null(), Type.String()]), fence: Type.String(),
    index: Type.Integer({ minimum: 0 }), offset: Type.Integer({ minimum: 0 }), id: Type.String(), hash: Type.String() });
function digest(message) { return createHash("sha256").update(JSON.stringify(message)).digest("hex"); }
function fragment(message, start, end) {
    const sourceMessageId = message.sourceMessageId ?? message.id, offset = (message.textOffset ?? 0) + start;
    return { ...message, sourceMessageId, textOffset: offset,
        id: `extraction-fragment:${JSON.stringify([sourceMessageId, offset, (message.textOffset ?? 0) + end])}`,
        text: message.text.slice(start, end) };
}
// Never split a UTF-16 surrogate pair; quotes remain exact substrings of the source.
function boundary(text, end) {
    return end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end]) ? end - 1 : end;
}
function prefixThatFits(message, offset, budget) {
    let low = offset, high = message.text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (extractionMessageTokens(fragment(message, offset, boundary(message.text, mid))) <= budget)
            low = mid;
        else
            high = mid - 1;
    }
    const end = boundary(message.text, low);
    if (end <= offset)
        throw new Error("No room for extraction message");
    return end;
}
export function extractionHistory(messages, count) {
    if (!count)
        return [];
    const kept = [];
    let remaining = 8_000;
    for (const message of messages.slice(-count).reverse()) {
        const tokens = extractionMessageTokens(message);
        if (tokens <= remaining) {
            kept.unshift(message);
            remaining -= tokens;
            continue;
        }
        if (!kept.length) {
            // Keep the tail of a very large message as overlap, rather than dropping it.
            let low = 0, high = message.text.length;
            while (low < high) {
                const mid = Math.floor((low + high) / 2);
                if (extractionMessageTokens(fragment(message, boundary(message.text, mid), message.text.length)) <= remaining)
                    high = mid;
                else
                    low = mid + 1;
            }
            const start = low < message.text.length && boundary(message.text, low) !== low ? low + 1 : low;
            if (start < message.text.length)
                kept.unshift(fragment(message, start, message.text.length));
        }
        break;
    }
    return kept;
}
/** SDK pages are transport only. A chunk always belongs to exactly one session. */
export async function readExtractionChunk(params) {
    const read = params.readPage ?? readExtractionPage;
    const fetchPage = async (cursor) => {
        params.signal.throwIfAborted();
        return read(params.agentId, params.agentName, params.session, cursor);
    };
    let resume;
    if (params.cursor?.startsWith(PREFIX)) {
        const parsed = JSON.parse(params.cursor.slice(PREFIX.length));
        if (!Value.Check(bookmarkSchema, parsed))
            throw new Error("Invalid extraction bookmark");
        resume = parsed;
        const check = await fetchPage(resume.fence);
        if (check.kind !== "page")
            return check;
    }
    const startingFence = resume?.fence;
    let cursor = resume ? resume.before : params.cursor;
    const messages = [...params.context];
    let tokens = extractionOverhead(params.existing) + messages.reduce((n, m) => n + extractionMessageTokens(m), 0);
    let entryCount = 0;
    const newIds = [];
    for (;;) {
        const before = cursor;
        const page = await fetchPage(before);
        if (page.kind !== "page")
            return page;
        if ((page.entryCount && page.cursor === before) || (!page.entryCount && page.hasMore))
            throw new Error("Transcript reader made no progress");
        if (resume && (!page.messages[resume.index] || page.messages[resume.index].id !== resume.id || digest(page.messages[resume.index]) !== resume.hash)) {
            throw new Error("Partial extraction source changed");
        }
        entryCount += page.entryCount;
        const finish = (index, offset = 0) => {
            const next = page.messages[index];
            return { kind: "page", messages, newIds, entryCount, fence: startingFence ?? page.cursor,
                cursor: next ? PREFIX + JSON.stringify({ before, fence: page.cursor, index, offset, id: next.id, hash: digest(next) }) : page.cursor };
        };
        for (let i = resume?.index ?? 0; i < page.messages.length; i++) {
            const message = page.messages[i];
            const offset = i === resume?.index ? resume.offset : 0;
            if (offset >= message.text.length)
                throw new Error("Invalid extraction text offset");
            const candidate = offset ? fragment(message, offset, message.text.length) : message;
            const cost = extractionMessageTokens(candidate);
            if (tokens + cost > EXTRACTION_INPUT_LIMIT) {
                if (newIds.length)
                    return finish(i, offset);
                const end = prefixThatFits(message, offset, EXTRACTION_INPUT_TARGET - tokens);
                const part = fragment(message, offset, end);
                messages.push(part);
                newIds.push(part.id);
                return finish(i, end);
            }
            messages.push(candidate);
            newIds.push(candidate.id);
            tokens += cost;
            if (tokens >= EXTRACTION_INPUT_TARGET)
                return finish(i + 1);
        }
        resume = undefined;
        cursor = page.cursor;
        if (!page.hasMore)
            return finish(page.messages.length);
    }
}
