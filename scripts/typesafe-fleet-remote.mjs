// Sent over SSH stdin and evaluated in memory; never installed on the remote host.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function cliJson(output) {
  // Some plugins log a registration line before the CLI's JSON result.
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== "{") continue;
    try { return JSON.parse(output.slice(index)); } catch { /* Try the next object start. */ }
  }
  throw new Error("invalid_cli_json");
}

function command(args, input = "") {
  const child = spawnSync("openclaw", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  // CLI diagnostics can contain config secrets. Never return them to the caller.
  if (child.error || child.status !== 0) throw new Error("command_failed");
  return child.stdout;
}

function safePath(path, directory = false) {
  if (!isAbsolute(path)) throw new Error("unsafe_path");
  const absolute = resolve(path), root = parse(absolute).root;
  for (let part = absolute; part !== root; part = dirname(part)) {
    if (!existsSync(part)) continue;
    const stat = lstatSync(part);
    if (stat.isSymbolicLink()) throw new Error("symlink_path");
    if (part === absolute && !(directory ? stat.isDirectory() : stat.isFile())) throw new Error("wrong_file_type");
  }
}

function privateWrite(path, bytes) {
  safePath(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

export async function deploy({ apiKey, apply, restart }, cli = command) {
  const report = { status: "failed", stage: "inspect", configChanged: false, keyChanged: false, restart: "not_needed" };
  try {
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(apiKey) || /["'`\\]/.test(apiKey)) throw new Error("invalid_key");
    const configPath = cliJson(cli(["config", "file", "--json"])).path;
    safePath(configPath);
    const initialConfig = readFileSync(configPath);
    cli(["config", "validate", "--json"]);
    // config get redacts apiKeyFile as well as the key. Compare authored values
    // locally, never emit them. Unsupported JSON5/include-only entries fail closed.
    const entry = JSON.parse(initialConfig.toString("utf8")).plugins?.entries?.["unblock-memory"];
    if (!entry || entry.enabled === false) throw new Error("plugin_not_enabled");
    const current = entry.config?.typesafe ?? {};
    const secrets = join(dirname(configPath), "secrets");
    const keyFile = join(secrets, "unblock-memory-typesafe.env");
    safePath(secrets, true); safePath(keyFile);
    const bytes = Buffer.from(`TYPESAFE_API_KEY="${apiKey}"\n`);
    const priorKey = existsSync(keyFile) ? readFileSync(keyFile) : undefined;
    const configChanged = current.enabled === false || current.apiKeyFile !== keyFile || Object.hasOwn(current, "apiKey");
    const keyChanged = !priorKey?.equals(bytes);
    const patch = JSON.stringify({ plugins: { entries: { "unblock-memory": { config: {
      typesafe: { enabled: true, apiKey: null, apiKeyFile: keyFile },
    } } } } });
    report.stage = "validate_patch";
    if (configChanged) cli(["config", "patch", "--stdin", "--dry-run", "--json"], patch);
    if (restart && configChanged && !cli(["gateway", "restart", "--help"]).includes("--wait")) throw new Error("restart_unsupported");
    if (!apply) return { ...report, status: "planned", stage: "complete", configChanged, keyChanged,
      restart: configChanged ? "required" : "not_needed" };

    report.stage = "write_key";
    // Never overwrite a target discovered earlier if it changed during the preflight.
    if (!initialConfig.equals(readFileSync(configPath))) throw new Error("config_changed_during_preflight");
    safePath(secrets, true); safePath(keyFile);
    if (priorKey ? !existsSync(keyFile) || !priorKey.equals(readFileSync(keyFile)) : existsSync(keyFile)) throw new Error("key_changed_during_preflight");
    mkdirSync(secrets, { recursive: true, mode: 0o700 }); chmodSync(secrets, 0o700);
    // A private rollback snapshot is retained; never print its contents or old keys.
    if (configChanged || keyChanged) {
      const backup = join(secrets, `typesafe-backup-${randomUUID()}`);
      mkdirSync(backup, { mode: 0o700 });
      privateWrite(join(backup, "openclaw.json"), initialConfig);
      if (priorKey) privateWrite(join(backup, "typesafe.env"), priorKey);
    }
    if (keyChanged) {
      const temporary = join(secrets, `.typesafe-${randomUUID()}.tmp`);
      try { privateWrite(temporary, bytes); renameSync(temporary, keyFile); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      report.keyChanged = true;
    }
    chmodSync(keyFile, 0o600);
    report.stage = "configure";
    if (configChanged) {
      report.restart = "required";
      cli(["config", "patch", "--stdin"], patch);
      report.configChanged = true;
    }
    report.stage = "verify";
    cli(["config", "validate", "--json"]);
    const after = JSON.parse(readFileSync(configPath, "utf8")).plugins?.entries?.["unblock-memory"];
    if (after.config?.typesafe?.apiKeyFile !== keyFile || after.config.typesafe.enabled === false || Object.hasOwn(after.config.typesafe, "apiKey")) throw new Error("config_mismatch");
    // Check plugin settings outside the three intended leaves, including audit approvals.
    const strip = value => {
      const copy = structuredClone(value);
      if (copy.config?.typesafe) {
        for (const key of ["enabled", "apiKey", "apiKeyFile"]) delete copy.config.typesafe[key];
        if (!Object.keys(copy.config.typesafe).length) delete copy.config.typesafe;
      }
      if (copy.config && !Object.keys(copy.config).length) delete copy.config;
      return copy;
    };
    if (!isDeepStrictEqual(strip(entry), strip(after))) throw new Error("unrelated_config_changed");
    if (!readFileSync(keyFile).equals(bytes)) throw new Error("key_mismatch");
    if (configChanged && restart) {
      report.stage = "restart";
      report.restart = "pending";
      // Never force an active turn to stop. The command timeout bounds our wait.
      cli(["gateway", "restart", "--wait", "0", "--json"]);
      report.restart = "restarted";
      report.stage = "health";
      const health = cliJson(cli(["gateway", "status", "--json"]));
      if (health.rpc?.ok !== true) throw new Error("gateway_unhealthy");
    }
    return { ...report, status: configChanged || keyChanged ? "configured" : "unchanged", stage: "complete" };
  } catch {
    // Preserve partial-write flags, but never expose exceptions, subprocess output or credentials.
    return report;
  }
}
