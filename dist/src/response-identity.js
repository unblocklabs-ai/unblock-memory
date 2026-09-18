import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
/** Identity is trusted metadata, never inferred from names or transcript text. */
export class ResponsePeople {
    #db;
    constructor(path) {
        if (!path || !existsSync(path))
            return;
        try {
            this.#db = new DatabaseSync(path, { readOnly: true });
            this.#db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
        }
        catch {
            this.#db?.close();
            this.#db = undefined;
        }
    }
    resolve(e) {
        const accountScope = e.session.accountId, senderId = e.senderId;
        let personId = null;
        if (accountScope) {
            try {
                const row = this.#db?.prepare(`SELECT p.id FROM people p JOIN person_identities i ON i.person_id=p.id
          WHERE i.provider='slack' AND i.account_scope=? AND i.external_id=? AND p.status='active'`).get(accountScope, senderId);
                if (typeof row?.id === "string")
                    personId = row.id;
            }
            catch { /* Optional people-store compatibility must not break the audit. */ }
        }
        return { key: JSON.stringify(["slack", accountScope || `unknown-session:${e.session.sessionId}`, senderId]),
            provider: "slack", accountScope, senderId, personId };
    }
    close() { this.#db?.close(); }
}
