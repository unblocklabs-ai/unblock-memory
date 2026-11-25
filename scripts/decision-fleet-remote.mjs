// Sent over SSH stdin and evaluated in memory; never installed on the remote host.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const KEY_FILENAME = "unblock-memory-decisions.env";
const ENDPOINT = "https://codex.unblocklabs.ai/v1/decisions";
const LEGACY_CONFIG_KEY = "typesafe";
const CONFIG_SECTION = "plugins.entries.unblock-memory.config";

function cliJson(output) {
  // Some plugins log a registration line before the CLI's JSON result.
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== "{") continue;
    try { return JSON.parse(output.slice(index)); } catch { /* Try the next object start. */ }
  }
  throw new Error("invalid_cli_json");
}

function command(args, input = "", env = {}) {
  const child = spawnSync("openclaw", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  // CLI diagnostics can contain config secrets. Never return them to the caller.
  if (child.error || child.status !== 0) {
    const error = new Error("command_failed");
    if (!child.error && child.status === 1 && args[0] === "config" && args[1] === "validate") {
      try {
        const result = cliJson(child.stdout);
        error.retiredKeyRejected = result.valid === false && result.issues?.length === 1 &&
          result.issues[0].path === CONFIG_SECTION &&
          result.issues[0].message === `invalid config: must not have additional properties: "${LEGACY_CONFIG_KEY}"`;
      } catch { /* No structured validation failure. */ }
    }
    throw error;
  }
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

function withPrivateConfig(configPath, bytes, use) {
  // A sibling preserves relative includes during validation and permits atomic rename.
  const temporary = join(dirname(configPath), `.decision-config-${randomUUID()}.json`);
  privateWrite(temporary, bytes);
  try { return use(temporary); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function usesDefaultEndpoint(endpoint) {
  if (endpoint === undefined) return true;
  try { return new URL(endpoint).href.replace(/\/+$/, "") === ENDPOINT; }
  catch { return false; }
}

export async function deploy({ apiKey, apply, restart }, cli = command) {
  const report = { status: "failed", stage: "inspect", configChanged: false, keyChanged: false, restart: "not_needed" };
  try {
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(apiKey) || /["'`\\]/.test(apiKey)) throw new Error("invalid_key");
    const configPath = cliJson(cli(["config", "file", "--json"])).path;
    safePath(configPath);
    const initialConfig = readFileSync(configPath);
    // config get redacts apiKeyFile as well as the key. Compare authored values
    // locally, never emit them. Unsupported JSON5/include-only entries fail closed.
    const authored = JSON.parse(initialConfig.toString("utf8"));
    const entry = authored.plugins?.entries?.["unblock-memory"];
    if (!entry || entry.enabled === false) throw new Error("plugin_not_enabled");
    const current = entry.config?.decisionModel ?? {};
    const oldConfig = Object.hasOwn(entry.config ?? {}, LEGACY_CONFIG_KEY);
    // Transfer only a provider-independent setting, never the old route, model, or credentials.
    const oldTimeout = entry.config?.[LEGACY_CONFIG_KEY]?.timeoutMs;
    const migrateTimeout = current.timeoutMs === undefined && Number.isInteger(oldTimeout) && oldTimeout >= 1 && oldTimeout <= 10_000;
    const secrets = join(dirname(configPath), "secrets");
    const keyFile = join(secrets, KEY_FILENAME);
    safePath(secrets, true); safePath(keyFile);
    const bytes = Buffer.from(`CODEX_LB_API_KEY="${apiKey}"\n`);
    const priorKey = existsSync(keyFile) ? readFileSync(keyFile) : undefined;
    const clearModel = Object.hasOwn(current, "model") && !usesDefaultEndpoint(current.endpoint);
    const configChanged = oldConfig || current.enabled === false || current.apiKeyFile !== keyFile ||
      current.endpoint !== ENDPOINT || Object.hasOwn(current, "apiKey");
    const keyChanged = !priorKey?.equals(bytes);
    const modelPatch = { enabled: true, endpoint: ENDPOINT, apiKey: null, apiKeyFile: keyFile,
      ...(clearModel ? { model: null } : {}), ...(migrateTimeout ? { timeoutMs: oldTimeout } : {}) };
    const patch = JSON.stringify({ plugins: { entries: { "unblock-memory": { config: {
      decisionModel: modelPatch,
      ...(oldConfig ? { [LEGACY_CONFIG_KEY]: null } : {}),
    } } } } });
    let migration;
    try { cli(["config", "validate", "--json"]); }
    catch (error) {
      if (!oldConfig || error.retiredKeyRejected !== true ||
          process.env.OPENCLAW_CONFIG_READONLY === "1" || process.env.OPENCLAW_NIX_MODE === "1") throw error;
      // Native patch requires an already-valid config, so it cannot delete a rejected alias.
      const candidate = structuredClone(authored);
      const next = candidate.plugins.entries["unblock-memory"].config;
      next.decisionModel = { ...current, ...modelPatch };
      delete next[LEGACY_CONFIG_KEY];
      delete next.decisionModel.apiKey;
      if (clearModel) delete next.decisionModel.model;
      migration = JSON.stringify(candidate, null, 2) + "\n";
    }
    report.stage = "validate_patch";
    if (migration) withPrivateConfig(configPath, migration, temporary => {
      const validation = cliJson(cli(["config", "validate", "--json"], "", { OPENCLAW_CONFIG_PATH: temporary }));
      if (validation.valid !== true || validation.path !== temporary) throw new Error("candidate_not_validated");
    });
    else if (configChanged) cli(["config", "patch", "--stdin", "--dry-run", "--json"], patch);
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
      const backup = join(secrets, `decision-backup-${randomUUID()}`);
      mkdirSync(backup, { mode: 0o700 });
      privateWrite(join(backup, "openclaw.json"), initialConfig);
      if (priorKey) privateWrite(join(backup, KEY_FILENAME), priorKey);
    }
    if (keyChanged) {
      const temporary = join(secrets, `.decision-${randomUUID()}.tmp`);
      try { privateWrite(temporary, bytes); renameSync(temporary, keyFile); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      report.keyChanged = true;
    }
    chmodSync(keyFile, 0o600);
    report.stage = "configure";
    if (configChanged) {
      report.restart = "required";
      if (migration) withPrivateConfig(configPath, migration, temporary => {
        safePath(configPath);
        if (!initialConfig.equals(readFileSync(configPath))) throw new Error("config_changed_during_preflight");
        renameSync(temporary, configPath);
      });
      else cli(["config", "patch", "--stdin"], patch);
      report.configChanged = true;
    }
    report.stage = "verify";
    cli(["config", "validate", "--json"]);
    const after = JSON.parse(readFileSync(configPath, "utf8")).plugins?.entries?.["unblock-memory"];
    const afterSection = after?.config?.decisionModel;
    if (afterSection?.apiKeyFile !== keyFile || afterSection.enabled === false ||
        afterSection.endpoint !== ENDPOINT ||
        Object.hasOwn(after.config, LEGACY_CONFIG_KEY) ||
        Object.hasOwn(afterSection, "apiKey") ||
        (migrateTimeout && afterSection.timeoutMs !== oldTimeout) ||
        (clearModel ? Object.hasOwn(afterSection, "model") : afterSection.model !== current.model)) {
      throw new Error("config_mismatch");
    }
    // Check plugin settings outside the intended decision-provider leaves, including audit approvals.
    const strip = value => {
      const copy = structuredClone(value);
      if (copy.config) delete copy.config[LEGACY_CONFIG_KEY];
      if (copy.config?.decisionModel) {
        for (const key of ["enabled", "endpoint", "model", "apiKey", "apiKeyFile"]) delete copy.config.decisionModel[key];
        if (migrateTimeout) delete copy.config.decisionModel.timeoutMs;
        if (!Object.keys(copy.config.decisionModel).length) delete copy.config.decisionModel;
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
