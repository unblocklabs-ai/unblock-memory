import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PeopleStore } from "./people-store.js";
type SlackDirectoryEntry = {
    id: string;
    name?: string;
    handle?: string;
    avatarUrl?: string;
};
export type SlackDirectoryReader = {
    listUsers(params: {
        accountId: string;
        limit: number;
    }): Promise<readonly SlackDirectoryEntry[]>;
};
type SlackAccountInspector = (params: {
    channelId: "slack";
    cfg: OpenClawConfig;
    accountId: string;
}) => Promise<Record<string, unknown> | null>;
type SlackRequest = (input: string | URL, init: {
    headers: {
        authorization: string;
    };
    signal: AbortSignal;
}) => Promise<Pick<Response, "json" | "ok" | "status">>;
export declare function createOpenClawSlackDirectory(params: {
    getConfig: () => OpenClawConfig | undefined;
    inspectAccount?: SlackAccountInspector;
    request?: SlackRequest;
}): SlackDirectoryReader;
export declare function syncSlackDirectory(params: {
    store: PeopleStore;
    reader: SlackDirectoryReader;
    accountId: string;
    limit: number;
    syncedAt?: string;
}): Promise<{
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
    failed: number;
    status: "ok";
    accountId: string;
    received: number;
}>;
export {};
