import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortable } from "./abortable.js";
import type { UnblockMemoryConfig } from "./config.js";
import { messageText } from "./whisperer-context.js";
import { conversationUserText } from "./response-text.js";
import { parseQueryPair, prepareQueryConversation, type QueryConversation, type QueryPair } from "./query-contract.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Preserve whole visible messages and the complete current request, never tool/thinking text. */
export function queryConversation(prompt: string, messages: readonly unknown[]): QueryConversation {
  const currentRequest = conversationUserText(prompt)?.text ?? "";
  const visible: QueryConversation["history"] = [];
  const assistantTexts = new Map<string, boolean>();
  for (const item of messages) {
    const event = record(item), message = record(event?.type === "message" ? event.message : item);
    if (event?.type === "compaction" || message?.role === "compactionSummary") {
      visible.length = 0; assistantTexts.clear(); continue;
    }
    if (!message || message.role === "toolResult" || message.role === "tool") continue;
    const meta = record(message.__openclaw);
    if (message.provenance !== undefined || (message.role === "user" && record(meta?.senderIdentity)?.senderKind === "bot")) {
      visible.length = 0; assistantTexts.clear(); continue;
    }
    const mirror = message.provider === "openclaw" && message.model === "delivery-mirror";
    if (message.role === "assistant" && (message.channel === "analysis" || message.stopReason === "error" ||
      message.stopReason === "aborted" || (message.provider === "openclaw" && message.model === "gateway-injected") ||
      (mirror && record(message.openclawDeliveryMirror)?.kind === "channel-final-suppressed"))) continue;
    const text = messageText(message);
    const raw = text?.role === "user" && typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : text?.text;
    const content = text?.role === "user" && raw ? conversationUserText(raw, meta?.senderId ?? message.senderId)?.text : raw;
    if (message.role === "user") {
      assistantTexts.clear();
      if (!content || /^(?:\[OpenClaw heartbeat poll\]|\[Queued messages while agent was busy\]|\[Subagent Context\]|<relevant-memories>)/.test(content)) {
        visible.length = 0; continue;
      }
    }
    if (!text || !content || (text.role === "assistant" && (content === "NO_REPLY" || content === "HEARTBEAT_OK"))) continue;
    if (text.role === "assistant") {
      const previous = assistantTexts.get(content);
      assistantTexts.set(content, mirror);
      if (previous !== undefined && (mirror || previous)) continue;
    }
    visible.push({ role: text.role, content });
  }
  if (visible.at(-1)?.role === "user" && visible.at(-1)?.content === currentRequest) visible.pop();
  return prepareQueryConversation(visible, currentRequest).conversation;
}

export class QueryApiError extends Error {
  constructor(readonly code: "credentials" | "http_error" | "invalid_response" | "unavailable", readonly status?: number) {
    super(`Query API ${code}`); this.name = "QueryApiError";
  }
}

/** The host owns model warmth/lifecycle; the plugin only sends bounded, cancellable requests. */
export class ApiQueryGenerator {
  constructor(private readonly config: UnblockMemoryConfig["memoryWhisperer"]["api"]) {}

  async generate(conversation: QueryConversation, signal: AbortSignal): Promise<QueryPair> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    signal.throwIfAborted();
    if (!this.config.apiKeyFile) throw new QueryApiError("credentials");
    let token: string;
    try { token = (await readFile(this.config.apiKeyFile, { encoding: "utf8", signal })).trim(); }
    catch { throw new QueryApiError("credentials"); }
    if (!token || /\s/u.test(token)) throw new QueryApiError("credentials");
    signal.throwIfAborted();
    const id = randomUUID();
    let response: Response;
    try {
      response = await fetch(`${this.config.endpoint}/generate`, {
        method: "POST", redirect: "error", signal,
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id, conversation }),
      });
    } catch { throw new QueryApiError("unavailable"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new QueryApiError("http_error", response.status);
    }
    // Bound even chunked responses; never log or retain provider errors or prompt payloads.
    const reader = response.body?.getReader();
    if (!reader) throw new QueryApiError("invalid_response");
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) throw new QueryApiError("invalid_response");
        chunks.push(value);
      }
      signal.throwIfAborted();
      const envelope = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = record(envelope?.response);
      if (result?.id !== id || typeof result.text !== "string" || result.error !== undefined) {
        throw new QueryApiError("invalid_response");
      }
      return parseQueryPair(JSON.parse(result.text));
    } catch { throw new QueryApiError("invalid_response"); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
