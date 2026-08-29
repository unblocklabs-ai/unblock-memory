import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PeopleStore } from "./people-store.js";

const execFileAsync = promisify(execFile);

type SlackDirectoryEntry = {
  id: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
};

export type SlackDirectoryReader = {
  listUsers(params: { accountId: string; limit: number }): Promise<readonly SlackDirectoryEntry[]>;
};

type DirectoryCommand = (
  executable: string,
  args: readonly string[],
  options: { maxBuffer: number },
) => Promise<{ stdout: string }>;

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

export function createOpenClawSlackDirectory(
  run: DirectoryCommand = async (executable, args, options) => {
    const result = await execFileAsync(executable, args, options);
    return { stdout: result.stdout };
  },
): SlackDirectoryReader {
  return {
    async listUsers({ accountId, limit }) {
      const { stdout } = await run(
        "openclaw",
        [
          "directory",
          "peers",
          "list",
          "--channel",
          "slack",
          "--account",
          accountId,
          "--limit",
          String(limit),
          "--json",
        ],
        { maxBuffer: 1024 * 1024 },
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed))
        throw new Error("OpenClaw Slack directory returned an invalid response");
      return parsed.flatMap((value): SlackDirectoryEntry[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        if (entry.kind !== "user") return [];
        const prefixedId = text(entry.id, 200);
        if (!prefixedId?.startsWith("user:")) return [];
        const id = text(prefixedId.slice("user:".length), 200);
        const handle = text(entry.handle, 200);
        return id
          ? [
              {
                id,
                name: text(entry.name, 500),
                handle: text(handle?.startsWith("@") ? handle.slice(1) : handle, 200),
              },
            ]
          : [];
      });
    },
  };
}

export const openClawSlackDirectory = createOpenClawSlackDirectory();

export async function syncSlackDirectory(params: {
  store: PeopleStore;
  reader: SlackDirectoryReader;
  accountId: string;
  limit: number;
  syncedAt?: string;
}) {
  const entries = await params.reader.listUsers({
    accountId: params.accountId,
    limit: params.limit,
  });
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const syncedAt = params.syncedAt ?? new Date().toISOString();
  for (const entry of entries.slice(0, params.limit)) {
    const externalId = text(entry.id, 200);
    if (!externalId) {
      counts.skipped += 1;
      continue;
    }
    try {
      const existing = params.store.findIdentity("slack", params.accountId, externalId);
      if (existing && params.store.getPerson(existing.personId)?.status !== "active") {
        counts.skipped += 1;
        continue;
      }
      const changed =
        existing !== undefined &&
        ((entry.name !== undefined && entry.name !== existing.displayName) ||
          (entry.handle !== undefined && entry.handle !== existing.handle) ||
          (entry.avatarUrl !== undefined && entry.avatarUrl !== existing.avatarUrl));
      const result = params.store.upsertIdentity({
        provider: "slack",
        accountScope: params.accountId,
        externalId,
        displayName: entry.name,
        handle: entry.handle,
        avatarUrl: entry.avatarUrl,
        syncedAt,
      });
      if (result.created) counts.created += 1;
      else if (changed) counts.updated += 1;
      else counts.unchanged += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return {
    status: "ok" as const,
    accountId: params.accountId,
    received: entries.length,
    ...counts,
  };
}
