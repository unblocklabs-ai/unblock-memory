import { createHash } from "node:crypto";

// Loaded by the Inside Out baseline worker (see inside-out-store.ts): keep this module free of `openclaw`.

/** Hex SHA-256 of a value's JSON: the shared identity for cache, checkpoint and dedup keys. */
export function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
