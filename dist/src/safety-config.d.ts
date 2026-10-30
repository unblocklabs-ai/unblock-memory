export type SafetyChannel = {
    name?: string;
    provider: string;
    accountId: string;
    channelId: string;
};
export type SafetyRequestor = {
    name?: string;
    provider: string;
    accountId: string;
    senderId: string;
};
export type SafetyScenario = {
    id: string;
    enabled: boolean;
    instructions: string;
    flaggedPrompt: string;
    minProbability: number;
    approvedRequestors: SafetyRequestor[];
    excludedChannels: SafetyChannel[];
    agentIds?: string[];
};
export type SafetyWhispererConfig = {
    enabled: boolean;
    historyMessages: number;
    timeoutMs: number;
    excludedChannels: SafetyChannel[];
    scenarios: SafetyScenario[];
};
export declare function resolveSafetyWhisperer(value: unknown): SafetyWhispererConfig;
