import type { VectorSearchResult } from "@unblocklabs/qmd";
import { meetingRevisionAnnotation, meetingSpeakerSpans } from "./loggie-projection.js";
import { sessionContextSpans, type SessionMessageSpan } from "./session-projector.js";

export const MEMORY_PASSAGE_CHARS = 1200;
export const MEMORY_PASSAGE_VERSION = "complete-excerpt-1200-v1";
type Passage = Pick<VectorSearchResult, "body" | "bestChunk" | "chunkPos" | "chunkLen">;
type LocatedPassage = { path: string; text: string; startLine: number; endLine: number };

/** Same passage eligibility in target scoring and runtime hint selection. */
export function duplicateMemoryPassage(passage: LocatedPassage, previous: readonly LocatedPassage[]) {
  const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();
  return previous.some(other => normalized(other.text) === normalized(passage.text) ||
    (other.path === passage.path && other.startLine <= passage.endLine && passage.startLine <= other.endLine));
}

/** Preserve a complete match and, when it fits, its whole turn/message context. */
export async function expandSessionSearchHit(
  result: Passage,
  maxTokens: number,
  countTokens: (text: string) => Promise<number>,
  maxChars = Infinity,
  messages?: SessionMessageSpan[],
): Promise<{ text: string; position: number; sourceText?: string }> {
  const leaf = { text: result.bestChunk, position: result.chunkPos };
  const speaker = meetingSpeakerSpans(result.body, result.chunkPos, result.chunkPos + result.chunkLen);
  const annotation = meetingRevisionAnnotation(result.body, result.chunkPos);
  const spans = speaker ?? sessionContextSpans(result.body, result.chunkPos, messages);
  if (!spans && !annotation) return leaf;
  const leafEnd = result.chunkPos + result.chunkLen;
  for (const span of spans ? [spans.turn, spans.message] : []) {
    if (span.start > result.chunkPos || span.end < leafEnd) continue;
    const sourceText = result.body.slice(span.start, span.end).trimEnd();
    const text = annotation ? `${annotation}\n${sourceText}` : sourceText;
    if (text.length > maxChars) continue;
    if (await countTokens(text) <= maxTokens) return { text, position: span.start, ...(annotation ? { sourceText } : {}) };
  }
  if ((speaker && speaker.start < result.chunkPos) || annotation) {
    const text = [annotation, speaker && speaker.start < result.chunkPos ? speaker.header : undefined, leaf.text].filter(Boolean).join("\n");
    if (text.length <= maxChars && await countTokens(text) <= maxTokens) {
      return { ...leaf, text, sourceText: leaf.text };
    }
  }
  if (annotation) return { ...leaf, text: "", sourceText: "" };
  return leaf;
}

/** One fixed, model-independent renderer for offline and deployed Whisperer. */
export async function renderMemoryPassage(result: Passage, messages?: SessionMessageSpan[]) {
  if (!result.bestChunk.trim() || result.bestChunk.length > MEMORY_PASSAGE_CHARS) return;
  const selected = messages ? await expandSessionSearchHit(result, Infinity, async () => 0, MEMORY_PASSAGE_CHARS, messages)
    : { text: result.bestChunk, position: result.chunkPos };
  return selected.text.trim() && selected.text.length <= MEMORY_PASSAGE_CHARS
    ? { ...selected, sourceText: selected.sourceText ?? selected.text, text: selected.text.trim() } : undefined;
}
