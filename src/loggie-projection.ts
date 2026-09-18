/** Loggie's v1 Markdown is persisted source data, never instructions. */
type Meeting = { text: string; key?: string; hash?: string; sequence?: number; complete: boolean };
const HEADER = /^<!-- loggie:meeting:v1 (\{[^\n]*\}) -->\n/u;
const SPEAKER = /^\*\*Speaker: ("(?:[^"\\\r\n]|\\.)*")\*\*\n/gmu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function projectLoggieMessage(text: string, accountId?: string): Meeting | undefined {
  const header = HEADER.exec(text);
  if (header) {
    let value: unknown;
    try { value = JSON.parse(header[1]!); } catch { return undefined; }
    const meta = record(value);
    if (!meta || typeof meta.accountId !== "string" || typeof meta.workspaceId !== "string" ||
      typeof meta.meetingId !== "string" || typeof meta.contentHash !== "string" ||
      !["complete", "truncated", "unavailable"].includes(String(meta.completeness)) ||
      (accountId !== undefined && meta.accountId !== accountId)) return undefined;
    return {
      text: text.slice(header[0].length),
      key: JSON.stringify([meta.accountId, meta.workspaceId, meta.meetingId, meta.externalId ?? null]),
      hash: meta.contentHash,
      sequence: typeof meta.sequence === "number" && Number.isSafeInteger(meta.sequence) && meta.sequence >= 0 ? meta.sequence : undefined,
      complete: meta.completeness === "complete",
    };
  }
  // Only accept the old producer's exact envelope and a complete JSON payload.
  if (!text.startsWith("Loggie meeting transcript ready: ")) return undefined;
  const delimiter = "\nTranscript Detail:\n";
  const at = text.indexOf(delimiter);
  if (at < 0) return undefined;
  let value: unknown;
  try { value = JSON.parse(text.slice(at + delimiter.length)); } catch { return undefined; }
  const transcript = record(record(value)?.transcript);
  if (!transcript || typeof transcript.text !== "string") return undefined;
  const names = Array.isArray(transcript.participants) ? transcript.participants.flatMap(item => {
    const name = record(item)?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  }) : [];
  const raw = transcript.text.trim();
  const speech = raw === "[No transcript provided]" ? "" : raw;
  const blocks: string[] = [];
  let speaker = "Unattributed";
  let lines: string[] = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) blocks.push(`**Speaker: ${JSON.stringify(speaker)}**\n` + content.split("\n").map(line => `> ${line}`).join("\n"));
    lines = [];
  };
  for (const line of speech.replace(/\r\n?/gu, "\n").split("\n")) {
    const match = /^([^:\n]{1,160}):[ \t]+(.*)$/u.exec(line);
    const label = match?.[1]?.trim();
    const recognized = label && (names.some(name => label === name || label.startsWith(`${name} [`)) ||
      /^(?:Speaker|Person)\s+[\p{L}\d]+(?:\s|$)/u.test(label) ||
      /^[\p{Lu}\p{Lt}][\p{L}'’.-]+(?:\s+[\p{Lu}\p{Lt}][\p{L}'’.-]+)+(?:\s*\[.*\])?$/u.test(label));
    if (match && recognized) { flush(); speaker = label; lines.push(match[2]!); }
    else lines.push(line);
  }
  flush();
  const sections = [speech ? `## Transcript\n\n${blocks.join("\n\n")}` : "Transcript status: unavailable. No verbatim speech was supplied."];
  for (const [key, title] of [["summary", "Summary (generated)"], ["outline", "Outline (generated)"]] as const) {
    const content = transcript[key];
    if (typeof content === "string" && content.trim()) sections.push(`## ${title}\n\n${content.trim().split(/\r?\n/u).map(line => `> ${line}`).join("\n")}`);
  }
  const title = text.split("\n")[0]!.slice("Loggie meeting transcript ready: ".length);
  const date = /^Meeting Date: (.*)$/mu.exec(text.slice(0, at))?.[1];
  return { text: `# Meeting: ${title}\n\n${date ? `Meeting date: ${date}\n\n` : ""}${sections.join("\n\n")}`, complete: false };
}

/** Spans stay in source coordinates; headings and assistant replies stop expansion. */
export function meetingSpeakerSpans(content: string, position: number, end = position) {
  const markers = [...content.matchAll(SPEAKER)].flatMap(match => {
    try {
      const speaker: unknown = JSON.parse(match[1]!);
      return typeof speaker === "string" ? [{ start: match.index, header: match[0].trimEnd() }] : [];
    } catch { return []; }
  });
  const ranges = markers.map(marker => {
    const rest = content.slice(marker.start + marker.header.length + 1);
    const quoted = /^(?:>[^\n]*(?:\n|$))+/u.exec(rest)?.[0];
    return { ...marker, end: marker.start + marker.header.length + 1 + (quoted?.length ?? 0) };
  });
  const first = ranges.findIndex(range => range.start <= position && range.end > position);
  if (first < 0) return undefined;
  let last = first;
  while (ranges[last]!.end < end && ranges[last + 1] && !content.slice(ranges[last]!.end, ranges[last + 1]!.start).trim()) last++;
  if (ranges[last]!.end < end && content.slice(ranges[last]!.end, end).trim()) return undefined;
  const prev = ranges[first - 1];
  const next = ranges[last + 1];
  return {
    header: ranges[first]!.header,
    start: ranges[first]!.start,
    message: { start: ranges[first]!.start, end: Math.max(end, ranges[last]!.end) },
    turn: {
      start: prev && !content.slice(prev.end, ranges[first]!.start).trim() ? prev.start : ranges[first]!.start,
      end: next && !content.slice(ranges[last]!.end, next.start).trim() ? next.end : Math.max(end, ranges[last]!.end),
    },
  };
}
