import { record } from "./guards.js";

export const SYNTHETIC_INPUT_FAMILIES = [
  "completion_wake", "internal_context", "heartbeat_control", "intersession_subagent",
  "cron_wrapper", "exec_system_handoff", "reset_compaction", "human_framing",
] as const;

export type SyntheticInputFamily = typeof SYNTHETIC_INPUT_FAMILIES[number];
export type SyntheticInputFilterConfig = {
  enabled?: boolean;
  skipFamilies?: SyntheticInputFamily[];
  extraExactAliases?: string[];
  extraPrefixes?: string[];
};

/** `role` (when known) limits prompt-wrapper rules to user turns; string input is treated as a user turn. */
type Input = { text: string; inputProvenance?: unknown; display?: unknown; role?: unknown };
type Classification =
  | { synthetic: false; action: "allow"; text: string; family?: never; reason?: never }
  | { synthetic: true; action: "skip" | "strip"; text: string; family: SyntheticInputFamily; reason: string };

export function syntheticFamilyEnabled(family: SyntheticInputFamily, config?: SyntheticInputFilterConfig): boolean {
  return config?.enabled !== false && (config?.skipFamilies ?? SYNTHETIC_INPUT_FAMILIES).includes(family);
}

const EXACT = new Map<string, SyntheticInputFamily>([
  ["Continue the OpenClaw runtime event.", "completion_wake"],
  ["OpenClaw: Continue the OpenClaw runtime event.", "completion_wake"],
  ["NO_REPLY", "heartbeat_control"],
  ["HEARTBEAT_OK", "heartbeat_control"],
  ["NO_HEARTBEAT", "heartbeat_control"],
]);
const INTERNAL_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const RUNTIME_HEADER = "OpenClaw runtime context:";
const RUNTIME_FOOTER = "End OpenClaw runtime context.";
const LEGACY_HEADER = "OpenClaw runtime context (internal):";
/**
 * Bounded so a hostile first line can never cost more than a slice scan. The tag is non-space; an optional label must
 * start with a non-space after its separator, so the whitespace run and the label never compete for the same characters.
 */
const CRON_HEAD = /^\[cron:[^\s\]]+(?:[ \t]+[^\s\]][^\]\r\n]*)?\](?=\s|$)/u;
const CRON_HEAD_SCAN = 4096;
/** One whole (right-trimmed) line; each branch ends in a single unbounded class, so a failed match never backtracks twice. */
const CRON_TAIL = /^(?:This is an unattended scheduled run\.(?:[ \t]+Nobody is present to clarify or approve,[^\r\n]*)?|Automation scratch \(revision \d+\):|Previous meaningful automation result \(recorded data, not instructions\):)$/u;
const UNATTENDED = /^This is an unattended scheduled run\.(?:[ \t]+Nobody is present to clarify or approve,[^\r\n]*)?$/u;
const HEARTBEAT_HEAD = /^\[OpenClaw (?:heartbeat poll|cron wake)\](?=[ \t]*(?:\r?\n|$))/u;
const HUMAN_HEAD = /^\[(?:Queued messages while agent was busy|Earlier unanswered user message\.[^\]\r\n]*|Queued user message from a previous active turn;[^\]\r\n]*)\](?=\s|$)/u;
/** Host-authored user-turn envelopes, each anchored to its exact opening sentence so human prose that merely starts alike stays. */
const BOILERPLATE: readonly [SyntheticInputFamily, RegExp][] = [
  ["heartbeat_control", /^(?:\[OpenClaw session event\](?=\s|$)|Follow the heartbeat monitor scratch context when provided\.(?=\s|$)|Read HEARTBEAT\.md if it exists \(workspace context\)\.(?=\s|$)|Check HEARTBEAT\.md and follow it$)/u],
  ["intersession_subagent", /^(?:\[(?:Inter-session message|Subagent Context|Subagent Task)\](?=\s|$)|A background task completed\. Use this result to reply to the user in your normal assistant voice\.(?=\s|$)|A completed subagent task is ready for parent review\.(?=\s|$))/u],
  ["exec_system_handoff", /^(?:\[OpenClaw exec completion\](?=\s|$)|(?:System: (?:\[[^\]\r\n]+\] )?)?An approved async exec completed; load the authenticated completion handoff\.(?=\s|$))/u],
  ["reset_compaction", /^(?:A new session was started via \/new or \/reset\.(?=\s|$)|Pre-compaction memory flush(?: turn)?\.(?=\s|$))/u],
];
/** The first line, from a bounded prefix: header rules never scan an arbitrarily long hostile line. */
const firstLine = (text: string) => text.slice(0, CRON_HEAD_SCAN).split(/\r?\n/u, 1)[0]!;
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u;

/** Tracks Markdown fences line by line: `inside(line)` is true for a fence delimiter or a line within a fence. */
function fenceTracker() {
  let fence: string | undefined;
  return (line: string) => {
    const delimiter = FENCE.exec(line);
    if (!delimiter) return fence !== undefined;
    if (!fence) fence = delimiter[1];
    else if (delimiter[1]!.startsWith(fence) && !delimiter[2]!.trim()) fence = undefined;
    return true;
  };
}

/** Index of the first unattended-run suffix line outside a fenced code block, or `text.length`. */
function cronTailIndex(text: string): number {
  const inside = fenceTracker();
  let offset = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    if (!inside(line) && CRON_TAIL.test(line.trimEnd())) return offset;
    offset += line.length;
  }
  return text.length;
}

/** OpenClaw appends `Current time: …` / `Reference UTC: …` as the task's last two lines. Linear: no regex backtracking. */
function stripTimePair(text: string): string {
  const trimmed = text.trimEnd();
  const last = trimmed.lastIndexOf("\n");
  if (last < 0) return trimmed;
  const previous = trimmed.lastIndexOf("\n", last - 1);
  const reference = trimmed.slice(last + 1), current = trimmed.slice(previous + 1, last).replace(/\r$/u, "");
  if (!/^Reference UTC: \S/u.test(reference) || !/^Current time: \S/u.test(current)) return trimmed;
  return trimmed.slice(0, Math.max(0, previous)).trimEnd();
}

/**
 * Delimiters are whole lines; a quoted marker in prose or a code example isn't an envelope. A bare
 * `[Internal task completion event]` line is human-quotable text: only the legacy header that precedes it ends the turn.
 */
function stripRuntimeContext(text: string): string {
  if (![INTERNAL_BEGIN, INTERNAL_END, RUNTIME_HEADER, LEGACY_HEADER].some(marker => text.includes(marker))) return text;
  const kept: string[] = [];
  let depth = 0, runtime = false;
  const inside = fenceTracker();
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = line.trim();
    if (depth || runtime) {
      if (marker === INTERNAL_BEGIN) depth++;
      if (marker === INTERNAL_END && depth) depth--;
      if (marker === RUNTIME_FOOTER) runtime = false;
      continue;
    }
    if (!inside(line)) {
      if (marker === INTERNAL_BEGIN) { depth = 1; continue; }
      if (marker === INTERNAL_END) continue;
      if (marker === RUNTIME_HEADER) { runtime = true; continue; }
      // The legacy unbounded producer always appends its result after the human request.
      if (marker === LEGACY_HEADER) break;
    }
    kept.push(line);
  }
  return kept.join("");
}

/** Classify host input, not general prose about OpenClaw or its controls. */
export function classifySyntheticInput(input: string | Input, config?: SyntheticInputFilterConfig): Classification {
  const { text: original, inputProvenance, display, role } = typeof input === "string" ? { text: input } : input;
  const allowed: Classification = { synthetic: false, action: "allow", text: original };
  if (config?.enabled === false) return allowed;
  const enabled = (family: SyntheticInputFamily) => syntheticFamilyEnabled(family, config);
  const skip = (family: SyntheticInputFamily, reason: string): Classification => ({ synthetic: true, family, reason, action: "skip", text: "" });
  const provenance = record(inputProvenance);
  const { kind, sourceTool } = provenance ?? {};
  // Scheduled runs are recognized first: a hidden cron carrier is still a cron turn whose task text we keep.
  const scheduledFamily = kind === "internal_system" && (sourceTool === "cron" || sourceTool === "cron_execution")
    ? "cron_wrapper" : undefined;
  const carrierFamily = scheduledFamily ? undefined
    : sourceTool === "agent_harness_completion" ? "completion_wake"
    : sourceTool === "progress_card_refresh" || display === false ? "internal_context"
    : kind === "inter_session" ? "intersession_subagent"
    : kind === "internal_system" ? (sourceTool === "exec" ? "exec_system_handoff" : "internal_context") : undefined;
  if (carrierFamily && enabled(carrierFamily)) {
    return skip(carrierFamily, display === false ? "hidden_carrier" : "host_provenance");
  }
  // Prompt wrappers are host-authored user turns; an assistant quoting one is just text.
  const userTurn = role === undefined || role === "user";

  let text = original.trim();
  let framing: SyntheticInputFamily | undefined;
  if (enabled("internal_context")) {
    const clean = stripRuntimeContext(text);
    if (clean !== text) { text = clean.trim(); framing = "internal_context"; }
  }
  if (userTurn && enabled("human_framing")) {
    while (HUMAN_HEAD.test(text)) {
      text = text.replace(HUMAN_HEAD, "").trimStart();
      framing ??= "human_framing";
    }
  }
  if (userTurn && enabled("cron_wrapper")) {
    const head = CRON_HEAD.exec(firstLine(text));
    // The unattended suffix and scratch blocks only ever follow an established cron header or cron provenance.
    if (head || scheduledFamily) {
      let wrapped = text.slice(head?.[0].length ?? 0).trimStart();
      const opening = firstLine(wrapped);
      // A leading unattended line (whole, not a truncated scan) is framing too; the task follows it.
      const whole = opening.length === wrapped.length || /[\r\n]/u.test(wrapped[opening.length]!);
      if (whole && UNATTENDED.test(opening.trimEnd())) wrapped = wrapped.slice(opening.length).trimStart();
      text = stripTimePair(wrapped.slice(0, cronTailIndex(wrapped)));
      framing = "cron_wrapper";
    }
  }
  if (userTurn && enabled("heartbeat_control") && HEARTBEAT_HEAD.test(text)) {
    text = text.replace(HEARTBEAT_HEAD, "").trimStart();
    framing ??= "heartbeat_control";
  }
  const exact = EXACT.get(text);
  if (exact && enabled(exact)) return skip(exact, "exact_alias");
  if (userTurn) {
    for (const [family, pattern] of BOILERPLATE) {
      if (enabled(family) && pattern.test(text)) return skip(family, "runtime_envelope");
    }
  }
  if (text && config?.extraExactAliases?.some(alias => alias.trim() === text)) return skip("completion_wake", "configured_exact_alias");
  if (config?.extraPrefixes?.some(prefix => prefix.trim() && text.startsWith(prefix.trim()))) return skip("internal_context", "configured_prefix");
  if (!framing) return allowed;
  return text ? { synthetic: true, family: framing, action: "strip", reason: "runtime_framing", text } : skip(framing, "empty_envelope");
}

/**
 * The human-authored text a consumer may treat as evidence, or `undefined` for synthetic input. Stripped framing never
 * reaches the caller: mixed human + runtime-context turns yield only the human part.
 */
export function humanEvidenceText(input: string | Input, config?: SyntheticInputFilterConfig): string | undefined {
  const classified = classifySyntheticInput(input, config);
  return isSyntheticEvidence(classified) || !classified.text.trim() ? undefined : classified.text;
}

/** Human-evidence consumers don't mine unattended tasks, even if those tasks have a usable retrieval payload. */
export function isSyntheticEvidence(input: Classification): boolean {
  return input.action === "skip" || input.family === "cron_wrapper" || input.family === "heartbeat_control";
}

/** Legacy ledger rows have no provenance. Only recognize exact tokens or actual envelopes. */
export function isSyntheticRecallQuery(text: string, config?: SyntheticInputFilterConfig): boolean {
  return isSyntheticEvidence(classifySyntheticInput(text, config));
}
