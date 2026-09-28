import type { UnblockMemoryConfig } from "./config.js";
import { type QueryConversation, type QueryPair } from "./query-contract.js";
/** Preserve whole visible messages and the complete current request, never tool/thinking text. */
export declare function queryConversation(prompt: string, messages: readonly unknown[]): QueryConversation;
export declare class MlxQueryGenerator {
    #private;
    private readonly config;
    /** Gateway hook and tool registries can evaluate/register this plugin separately. */
    static shared(config: NonNullable<UnblockMemoryConfig["memoryWhisperer"]["mlx"]>): MlxQueryGenerator;
    constructor(config: NonNullable<UnblockMemoryConfig["memoryWhisperer"]["mlx"]>);
    get closed(): boolean;
    start(): Promise<void>;
    generate(conversation: QueryConversation, signal: AbortSignal): Promise<QueryPair>;
    close(): void;
}
