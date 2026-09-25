import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { abortable } from "./abortable.js";
import type { UnblockMemoryConfig } from "./config.js";
import { messageText } from "./whisperer-context.js";
import { conversationUserText } from "./response-text.js";

type Conversation = { history: { role: "user" | "assistant"; content: string }[]; currentRequest: string };

/** Preserve whole visible messages and the complete current request, never tool/thinking text. */
export function queryConversation(prompt: string, messages: readonly unknown[], historyMessages: number): Conversation {
  const currentRequest = conversationUserText(prompt)?.text ?? "";
  const visible = messages.flatMap(message => {
    const text = messageText(message);
    const content = text?.role === "user" ? conversationUserText(text.text)?.text : text?.text;
    return text && content ? [{ role: text.role, content }] : [];
  });
  if (visible.at(-1)?.role === "user" && visible.at(-1)?.content === currentRequest) visible.pop();
  const history = historyMessages ? visible.slice(-historyMessages) : [];
  while (history.length && Buffer.byteLength(JSON.stringify({ history, currentRequest })) > 24_000) history.shift();
  if (!currentRequest) throw new Error("Missing or unparseable current request");
  if (Buffer.byteLength(JSON.stringify({ history, currentRequest })) > 24_000) {
    throw new Error("Query input exceeds context budget");
  }
  return { history, currentRequest };
}

export class MlxQueryGenerator {
  /** Gateway hook and tool registries can evaluate/register this plugin separately. */
  static shared(config: NonNullable<UnblockMemoryConfig["memoryWhisperer"]["mlx"]>): MlxQueryGenerator {
    const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const symbol = Symbol.for("unblock-memory.mlx-workers.v1");
    const workers = (scope[symbol] ??= new Map<string, MlxQueryGenerator>()) as Map<string, MlxQueryGenerator>;
    const key = JSON.stringify([config.pythonPath, config.modelPath]);
    let worker = workers.get(key);
    if (!worker || worker.closed) { worker = new MlxQueryGenerator(config); workers.set(key, worker); }
    return worker;
  }
  #child?: ChildProcessWithoutNullStreams;
  #ready?: Promise<void>;
  #closed = false;
  #retryAfter = 0;
  #pending = new Map<string, { resolve: (queries: string[]) => void; reject: (error: Error) => void }>();
  constructor(private readonly config: NonNullable<UnblockMemoryConfig["memoryWhisperer"]["mlx"]>) {}
  get closed(): boolean { return this.#closed; }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Query worker stopped"));
    if (this.#ready) return this.#ready;
    if (Date.now() < this.#retryAfter) return Promise.reject(new Error("Query worker restarting"));
    const adjacent = new URL("./mlx-query-worker.py", import.meta.url);
    const script = existsSync(adjacent) ? adjacent : new URL("../../src/mlx-query-worker.py", import.meta.url);
    const child = spawn(this.config.pythonPath, ["-u", fileURLToPath(script), this.config.modelPath], {
      stdio: "pipe", env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    this.#child = child;
    // No source text from Python warnings/exceptions enters Gateway logs.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => child.kill(), 60_000);
      const fail = () => {
        clearTimeout(timer);
        lines.close();
        reject(new Error("Query worker unavailable"));
        if (this.#child !== child) return;
        this.#child = undefined;
        this.#ready = undefined;
        this.#retryAfter = Date.now() + 2000;
        for (const request of this.#pending.values()) request.reject(new Error("Query worker unavailable"));
        this.#pending.clear();
      };
      child.once("error", fail);
      child.once("close", fail);
      child.stdin.on("error", () => child.kill());
      lines.on("line", line => {
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== "object") throw new Error("Invalid worker response");
          if ("ready" in value && value.ready === true) { clearTimeout(timer); resolve(); return; }
          if (!("id" in value) || typeof value.id !== "string") throw new Error("Missing worker request ID");
          const request = this.#pending.get(value.id);
          if (!request) return; // Cancelled request; never surface late results.
          this.#pending.delete(value.id);
          if (!("text" in value) || typeof value.text !== "string") {
            request.reject(new Error("Query generation failed")); return;
          }
          let queries: unknown;
          try { queries = (JSON.parse(value.text) as { queries?: unknown }).queries; } catch { /* reject below */ }
          const usable = Array.isArray(queries) ? [...new Set(queries
            .filter((query: unknown): query is string => typeof query === "string")
            .map(query => query.trim()).filter(Boolean))] : [];
          if (!usable.length) {
            request.reject(new Error("No usable generated queries")); return;
          }
          request.resolve(usable);
        } catch { child.kill(); }
      });
    });
    return this.#ready;
  }

  async generate(conversation: Conversation, signal: AbortSignal): Promise<string[]> {
    await abortable(this.start(), signal);
    signal.throwIfAborted();
    if (this.#pending.size >= 8) throw new Error("Query worker busy");
    const id = randomUUID();
    const child = this.#child!;
    const result = new Promise<string[]>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    const cancel = () => {
      this.#pending.get(id)?.reject(new Error("Query generation cancelled"));
      this.#pending.delete(id);
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ id, cancel: true }) + "\n");
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.stdin.write(JSON.stringify({ id, conversation }) + "\n");
    try { return await result; } finally { signal.removeEventListener("abort", cancel); }
  }

  close(): void {
    this.#closed = true;
    this.#child?.kill();
  }
}
