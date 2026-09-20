import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_DATABASE } from "./memory-database.js";
import type { ResponseEpisode } from "./response-episodes.js";

export type ResponseHuman = { key: string; provider: "slack"; accountScope: string; senderId: string; personId: string | null };

/** Identity is trusted metadata, never inferred from names or transcript text. */
export class ResponsePeople {
  #db: DatabaseSync | undefined;
  constructor(path?: string) {
    // Dry-run audits must not migrate or create stores just to resolve identities.
    if (path && basename(path) === MEMORY_DATABASE && !existsSync(path)) path = join(dirname(path), "people.sqlite");
    if (!path || !existsSync(path)) return;
    try {
      this.#db = new DatabaseSync(path, { readOnly: true });
      this.#db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    } catch { this.#db?.close(); this.#db = undefined; }
  }
  resolve(e: ResponseEpisode): ResponseHuman {
    const accountScope = e.session.accountId, senderId = e.senderId;
    let personId: string | null = null;
    if (accountScope) {
      try {
        const row = this.#db?.prepare(`SELECT p.id FROM people p JOIN person_identities i ON i.person_id=p.id
          WHERE i.provider='slack' AND i.account_scope=? AND i.external_id=? AND p.status='active'`).get(accountScope, senderId);
        if (typeof row?.id === "string") personId = row.id;
      } catch { /* Optional people-store compatibility must not break the audit. */ }
    }
    return { key: JSON.stringify(["slack", accountScope || `unknown-session:${e.session.sessionId}`, senderId]),
      provider: "slack", accountScope, senderId, personId };
  }
  close() { this.#db?.close(); }
}
