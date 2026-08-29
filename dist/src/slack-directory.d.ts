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
type DirectoryCommand = (executable: string, args: readonly string[], options: {
    maxBuffer: number;
}) => Promise<{
    stdout: string;
}>;
export declare function createOpenClawSlackDirectory(run?: DirectoryCommand): SlackDirectoryReader;
export declare const openClawSlackDirectory: SlackDirectoryReader;
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
