import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import type { SessionMetadata } from "./session-projector.js";
export type MemoryPluginRuntimeContract = NonNullable<MemoryPluginCapability["runtime"]>;
type ManagerLookup = Awaited<ReturnType<MemoryPluginRuntimeContract["getMemorySearchManager"]>>;
export type MemorySearchManagerContract = NonNullable<ManagerLookup["manager"]>;
export type MemoryProviderStatus = ReturnType<MemorySearchManagerContract["status"]>;
export type MemorySearchResult = Awaited<ReturnType<MemorySearchManagerContract["search"]>>[number];
export type CorpusMemorySearchResult = MemorySearchResult & {
    corpus: string;
    session?: SessionMetadata;
};
export type CorpusSearchOptions = NonNullable<Parameters<MemorySearchManagerContract["search"]>[1]> & {
    corpora?: readonly string[];
};
export type MemoryEmbeddingProbeResult = Awaited<ReturnType<MemorySearchManagerContract["probeEmbeddingAvailability"]>>;
export type MemorySyncParams = Parameters<NonNullable<MemorySearchManagerContract["sync"]>>[0];
export type MemoryReadResult = {
    status: "ok";
    text: string;
    path: string;
    truncated?: boolean;
    from?: number;
    lines?: number;
    nextFrom?: number;
} | {
    status: "not_found";
    text: "";
    path: string;
};
export {};
