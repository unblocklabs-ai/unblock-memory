import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionMetadata, SessionSnippetMessage } from "./session-projector.js";
import type { ChatType } from "./config.js";
import type { RetrievalTimings } from "./retrieval-timing.js";

export type MemoryPluginRuntimeContract = NonNullable<MemoryPluginCapability["runtime"]>;

type ManagerLookup = Awaited<
  ReturnType<MemoryPluginRuntimeContract["getMemorySearchManager"]>
>;

export type MemorySearchManagerContract = NonNullable<ManagerLookup["manager"]>;
export type MemoryProviderStatus = ReturnType<MemorySearchManagerContract["status"]>;
export type MemorySearchResult = Awaited<
  ReturnType<MemorySearchManagerContract["search"]>
>[number];
export type CorpusMemorySearchResult = MemorySearchResult & {
  corpus: string;
  session?: SessionMetadata;
  /** Timestamp text, including timezone, of the message containing the matched session chunk. */
  messageTimestamp?: string;
  /** Structured tool output; snippet stays a string for the host and internal consumers. */
  sessionMessages?: SessionSnippetMessage[];
  extracted?: { id: string; revision: number; observedAt: string };
};
export type SessionSearchFilter = {
  startedFrom?: string;
  startedTo?: string;
  provider?: string;
  chatType?: ChatType;
  accountId?: string;
  conversationId?: string;
};
export type MemoryRequestContext = Pick<
  OpenClawPluginToolContext,
  | "sessionKey"
  | "sessionId"
  | "messageChannel"
  | "agentAccountId"
  | "nativeChannelId"
  | "deliveryContext"
>;
export type CorpusSearchOptions = Omit<NonNullable<
  Parameters<MemorySearchManagerContract["search"]>[1]
>, "lexicalOnly"> & {
  corpora?: readonly string[];
  /** Internal passage budget; oversized matched chunks are omitted, never sliced. */
  maxSnippetChars?: number;
  sessionFilter?: SessionSearchFilter;
  requestContext?: MemoryRequestContext;
  /** Internal, per-call numeric timing sink; never part of tool input/output. */
  timings?: RetrievalTimings;
};
export type MemoryEmbeddingProbeResult = Awaited<
  ReturnType<MemorySearchManagerContract["probeEmbeddingAvailability"]>
>;
export type MemorySyncParams = Parameters<
  NonNullable<MemorySearchManagerContract["sync"]>
>[0];

export type MemoryReadCursor = {
  line: number;
  /** UTF-16 code units from the start of the line, at a scalar boundary. */
  offset: number;
  revision: string;
};

export type MemoryReadResult =
  | {
      status: "ok";
      text: string;
      path: string;
      truncated?: boolean;
      from?: number;
      lines?: number;
      nextFrom?: number;
      nextCursor?: MemoryReadCursor;
      /** UTF-16 length of the content prefix, excluding the continuation notice. */
      contentChars?: number;
    }
  | { status: "not_found"; text: ""; path: string }
  | { status: "stale_cursor"; text: ""; path: string; error: string };
