import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

/**
 * Bounded `o200k_base` encoder shared by every budgeting path.
 *
 * js-tiktoken's byte-pair merge rescans and re-joins every remaining pair on each merge, so one long
 * pre-tokenizer piece (base64, minified code, a run of one character) costs super-linear time and can
 * stall the event loop for seconds. Text whose pieces are all short is encoded in a single call and
 * returns exactly the reference token IDs. A piece longer than `MAX_PIECE_BYTES` is encoded in
 * `CHUNK_BYTES` slices cut at code-point boundaries, which bounds the work linearly; those slices
 * cannot merge across their cuts, so the count is a conservative (over-)estimate for that piece only.
 */
const MAX_PIECE_BYTES = 128;
const CHUNK_BYTES = 32;

let tokenizer: Tiktoken | undefined;
const pieces = new RegExp(o200kBase.pat_str, "gu");

function utf8Bytes(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Slice a long piece into at most `CHUNK_BYTES`-byte runs without splitting a surrogate pair. */
function* chunks(piece: string): Generator<string> {
  let start = 0, bytes = 0;
  for (let index = 0; index < piece.length; ) {
    const codePoint = piece.codePointAt(index)!;
    const width = utf8Bytes(codePoint);
    if (bytes + width > CHUNK_BYTES && index > start) {
      yield piece.slice(start, index);
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (start < piece.length) yield piece.slice(start);
}

/** `o200k_base` IDs with special-token spellings encoded as ordinary text. */
export function o200kTokenIds(text: string): number[] {
  const encoder = (tokenizer ??= new Tiktoken(o200kBase));
  const encode = (segment: string) => encoder.encode(segment, [], []);
  let ids: number[] | undefined;
  const append = (segment: string) => { for (const id of encode(segment)) ids!.push(id); };
  let start = 0;
  for (const match of text.matchAll(pieces)) {
    const piece = match[0];
    // A UTF-16 unit is at most three UTF-8 bytes, so short pieces skip the exact byte count.
    if (piece.length * 3 <= MAX_PIECE_BYTES || Buffer.byteLength(piece) <= MAX_PIECE_BYTES) continue;
    ids ??= [];
    if (match.index > start) append(text.slice(start, match.index));
    for (const chunk of chunks(piece)) append(chunk);
    start = match.index + piece.length;
  }
  if (!ids) return encode(text);
  if (start < text.length) append(text.slice(start));
  return ids;
}

export function o200kTokenCount(text: string): number {
  return o200kTokenIds(text).length;
}
