#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ",") endCell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endCell(); rows.push(row); row = [];
    } else { if (closed || c === '"') throw new Error("Malformed CSV"); cell += c; }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (cell || row.length || closed) { endCell(); rows.push(row); }
  return rows;
}

export function readRows(text) {
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ""));
  if (header?.join(",") !== "agent,ssh_host,api_key") throw new Error("CSV header must be agent,ssh_host,api_key");
  const agents = new Set(), hosts = new Set();
  return rows.filter(row => row.some(cell => cell.trim())).map((row, index) => {
    const [agent, host, apiKey] = row.map(cell => cell.trim());
    if (row.length !== 3 || !/^[\w .-]{1,80}$/.test(agent) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(host)) throw new Error(`Invalid label/SSH alias in row ${index + 2}`);
    if (agents.has(agent.toLowerCase()) || hosts.has(host.toLowerCase())) throw new Error("Duplicate agent or SSH host");
    agents.add(agent.toLowerCase()); hosts.add(host.toLowerCase());
    if (apiKey && (!/^[\x21-\x7e]{8,4096}$/.test(apiKey) || /["'`\\]/.test(apiKey) || /PASTE|REPLACE|YOUR_KEY/i.test(apiKey))) throw new Error(`Invalid or placeholder key in row ${index + 2}`);
    return { agent, host, apiKey };
  });
}

// No key, filename, host or CSV value is interpolated into this remote shell program.
const bootstrap = `let s='';for await(const c of process.stdin)s+=c;try{const p=JSON.parse(s);const m=await import('data:text/javascript;base64,'+p.source);console.log('TYPESAFE_FLEET_RESULT '+JSON.stringify(await m.deploy(p.options)))}catch{console.log('TYPESAFE_FLEET_RESULT '+JSON.stringify({status:'failed',stage:'bootstrap'}))}`;
export const remoteCommand = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec node --input-type=module -e ' + "'" + bootstrap.replaceAll("'", "'\\''") + "'";

export function safeReport(stdout) {
  const line = stdout.split("\n").findLast(line => line.startsWith("TYPESAFE_FLEET_RESULT "));
  const value = JSON.parse(line?.slice(22) ?? "null");
  if (!value || !["planned", "configured", "unchanged", "failed"].includes(value.status)) throw new Error("Invalid host response");
  return { status: value.status,
    stage: ["inspect", "validate_patch", "write_key", "configure", "verify", "restart", "health", "complete", "bootstrap"].includes(value.stage) ? value.stage : "unknown",
    configChanged: value.configChanged === true, keyChanged: value.keyChanged === true,
    restart: ["not_needed", "required", "pending", "restarted"].includes(value.restart) ? value.restart : "unknown" };
}

export function main(args) {
  const [path, ...flags] = args;
  if (!path || path === "--help") {
    console.log("Usage: node scripts/typesafe-fleet.mjs KEYS.csv [--apply] [--restart]\nDefault: read-only dry-run. Blank keys are skipped. --restart requires --apply.");
    return 0;
  }
  if (flags.some(flag => !["--apply", "--restart"].includes(flag)) || (flags.includes("--restart") && !flags.includes("--apply"))) throw new Error("Invalid flags");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 1_000_000 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("CSV must be your private regular file (chmod 600), at most 1 MB");
  const rows = readRows(readFileSync(path, "utf8"));
  const source = readFileSync(new URL("./typesafe-fleet-remote.mjs", import.meta.url)).toString("base64");
  // Resolve every endpoint before writes, catching aliases mapping to the same SSH user/host/port.
  const endpoints = new Set();
  for (const row of rows.filter(row => row.apiKey)) {
    const resolved = spawnSync("ssh", ["-G", row.host], { encoding: "utf8", timeout: 10_000 });
    if (resolved.status !== 0) throw new Error("Unable to resolve an SSH alias");
    const fields = Object.fromEntries(resolved.stdout.split("\n").map(line => { const at = line.indexOf(" "); return [line.slice(0, at), line.slice(at + 1)]; }));
    const endpoint = JSON.stringify([fields.hostname?.toLowerCase(), fields.user, fields.port]);
    if (endpoints.has(endpoint)) throw new Error("Multiple rows resolve to the same SSH endpoint");
    endpoints.add(endpoint);
  }
  let failed = false;
  const keys = rows.map(row => row.apiKey).filter(Boolean);
  for (const row of rows) {
    let result = { status: "skipped_blank" };
    if (row.apiKey) {
      const child = spawnSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", row.host, remoteCommand], {
        input: JSON.stringify({ source, options: { apiKey: row.apiKey, apply: flags.includes("--apply"), restart: flags.includes("--restart") } }),
        encoding: "utf8", timeout: 600_000, maxBuffer: 2_000_000, stdio: ["pipe", "pipe", "pipe"],
      });
      if (child.status !== 0 || child.error) result = { status: "failed", stage: "ssh_or_timeout" };
      else { try { result = safeReport(child.stdout); } catch { result = { status: "failed", stage: "host_response" }; } }
    }
    failed ||= result.status === "failed";
    let output = JSON.stringify({ agent: row.agent, ssh_host: row.host, ...result });
    for (const key of keys) output = output.replaceAll(key, "[REDACTED]");
    console.log(output);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error("Fleet setup stopped: check CSV format, private permissions, flags and unique SSH targets. No raw diagnostics are printed because they may contain keys."); process.exitCode = 1; }
}
