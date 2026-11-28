#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8787" },
    db: { type: "string", default: "fleet-organism-hub.sqlite" },
    // All-roles fallback, used only for roles without their own token below.
    "token-file": { type: "string" },
    "read-token-file": { type: "string" },
    "ingest-token-file": { type: "string" },
    // JSON object of node alias -> token; each token may only ingest snapshots for its own nodeId.
    "ingest-tokens-file": { type: "string" },
    "operator-token-file": { type: "string" },
    "private-metrics": { type: "boolean", default: false },
    "max-body-bytes": { type: "string" },
    "max-clock-skew-ms": { type: "string" },
    "snapshot-ttl-ms": { type: "string" },
    "max-alias-length": { type: "string" },
    "forbidden-terms-file": { type: "string" },
  },
});
const port = Number(values.port);
if (!/^\d+$/u.test(values.port) || port > 65535) throw new Error("Invalid --port");
const fallback = values["token-file"];
const covered = {
  read: Boolean(values["read-token-file"] ?? fallback),
  ingest: Boolean(values["ingest-token-file"] ?? values["ingest-tokens-file"] ?? fallback),
  operator: Boolean(values["operator-token-file"] ?? fallback),
};
if (!Object.values(covered).every(Boolean) && !["localhost", "127.0.0.1", "::1"].includes(values.host)) {
  throw new Error("Every role needs a token on non-loopback hosts: --token-file, or --read-token-file, "
    + "--ingest-token-file/--ingest-tokens-file and --operator-token-file");
}
if (values["private-metrics"] && !covered.read) throw new Error("--private-metrics requires --read-token-file or --token-file");
/** Non-negative integer flag; 0 = unlimited / disabled. */
const limit = flag => {
  const raw = values[flag];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value)) throw new Error(`Invalid --${flag} (0 = unlimited)`);
  return value;
};
const limits = Object.fromEntries(Object.entries({
  maxBodyBytes: limit("max-body-bytes"), maxClockSkewMs: limit("max-clock-skew-ms"),
  snapshotTtlMs: limit("snapshot-ttl-ms"), maxAliasLength: limit("max-alias-length"),
}).filter(([, value]) => value !== undefined));
const ingestTokens = values["ingest-tokens-file"] === undefined ? undefined : JSON.parse(readFileSync(values["ingest-tokens-file"], "utf8"));
if (ingestTokens !== undefined && (ingestTokens === null || typeof ingestTokens !== "object" || Array.isArray(ingestTokens)
  || !Object.values(ingestTokens).every(token => typeof token === "string"))) {
  throw new Error("--ingest-tokens-file must be a JSON object of node alias -> token");
}
// One forbidden Commons term per line (client names, codenames); blank lines and # comments are ignored.
const forbiddenTerms = values["forbidden-terms-file"] === undefined ? undefined : readFileSync(values["forbidden-terms-file"], "utf8")
  .split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
// Built output only: run `npm run build` first when working from a source checkout.
const { createFleetOrganismHub } = await import("../dist/src/fleet-organism-hub.js");
const hub = createFleetOrganismHub({
  dbPath: values.db, tokenFile: fallback, readTokenFile: values["read-token-file"],
  ingestTokenFile: values["ingest-token-file"], operatorTokenFile: values["operator-token-file"],
  publicMetrics: !values["private-metrics"], ...limits,
  ...(ingestTokens ? { ingestTokens } : {}), ...(forbiddenTerms ? { forbiddenTerms } : {}),
});
hub.once("error", error => {
  console.error(error.message);
  process.exitCode = 1;
  hub.close();
});
hub.listen(port, values.host, () => {
  const address = hub.address();
  console.log(`Fleet Organism hub listening on ${values.host}:${address.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => hub.close());
