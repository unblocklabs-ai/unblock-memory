import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, symlinkSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { deploy } from "../scripts/decision-fleet-remote.mjs";
import { readRows, safeReport, remoteCommand } from "../scripts/decision-fleet.mjs";

const key = "fixture-SECRET-key#123";
const endpoint = "https://codex.unblocklabs.ai/v1/decisions";
const legacyKey = "typesafe";
function fixture(settings = { [legacyKey]: { apiKey: "old-secret", model: "old-model", timeoutMs: 1234 } }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "decision-fleet-test-")));
  const configPath = join(root, "openclaw.json");
  const entry = { enabled: true, config: { ...settings,
    responseAudit: { enabled: false, senderIds: ["approved-human"] }, skillWhisperer: { enabled: true } } };
  const config = { unrelated: { token: "private" }, plugins: { entries: { "unblock-memory": entry } } };
  writeFileSync(configPath, JSON.stringify(config));
  const commands = [];
  // Mirror native patch semantics: merge objects, and delete keys set to null.
  const mergePatch = (state, patch) => {
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete state[name];
      else if (value && typeof value === "object" && !Array.isArray(value)) mergePatch(state[name] ??= {}, value);
      else state[name] = value;
    }
  };
  const cli = (args, input) => {
    commands.push(args);
    if (args.join(" ") === "config file --json") return JSON.stringify({ path: configPath });
    if (args[1] === "validate") return "{}";
    if (args[1] === "patch") {
      const patch = JSON.parse(input).plugins.entries["unblock-memory"].config;
      assert.equal(input.includes(key), false);
      assert.equal(input.includes("old-secret"), false);
      if (!args.includes("--dry-run")) {
        mergePatch(entry.config, patch);
        writeFileSync(configPath, JSON.stringify(config));
      }
      return "{}";
    }
    if (args.includes("--help")) return "--wait <duration>";
    if (args[1] === "restart") { assert.deepEqual(args, ["gateway", "restart", "--wait", "0", "--json"]); return "{}"; }
    if (args[1] === "status") return JSON.stringify({ rpc: { ok: true } });
    throw new Error("unexpected CLI");
  };
  return { root, configPath, entry, config, commands, cli };
}

test("CSV handles quotes, BOM, CRLF and blank rows; rejects malformed or unsafe input before deployment", () => {
  assert.deepEqual(readRows('\uFEFFagent,ssh_host,api_key\r\n"Bill",billsmacmini,"fixture-1234"\r\n\r\nPearl,pearlperelel,\r\n'),
    [{ agent: "Bill", host: "billsmacmini", apiKey: "fixture-1234" }, { agent: "Pearl", host: "pearlperelel", apiKey: "" }]);
  for (const row of ['Bill,-oProxyCommand=x,fixture123', 'Bill,host,"unclosed', 'Bill,host,PASTE_KEY_HERE',
    'Bill,host,fixture123\nOther,HOST,fixture456', 'Bill,host,fixture123\nbill,other,fixture456',
    'Bill,host,"x\nysecret"', 'Bill,host,key,x', 'Bill,host,"abc"suffix']) {
    assert.throws(() => readRows(`agent,ssh_host,api_key\n${row}`));
  }
});

test("remote dry-run validates native patch but leaves config and secrets untouched", async () => {
  const f = fixture(), before = readFileSync(f.configPath);
  const result = await deploy({ apiKey: key, apply: false, restart: false }, f.cli);
  assert.equal(result.status, "planned"); assert.equal(result.configChanged, true);
  assert.ok(readFileSync(f.configPath).equals(before));
  assert.equal(existsSync(join(f.root, "secrets")), false);
  assert.equal(f.commands.some(args => args[1] === "patch" && !args.includes("--dry-run")), false);
});

test("apply replaces the legacy section without carrying over credentials or model, preserving approvals and timeout", async () => {
  const f = fixture(), before = readFileSync(f.configPath);
  const result = await deploy({ apiKey: key, apply: true, restart: true }, f.cli);
  assert.equal(result.status, "configured"); assert.equal(result.restart, "restarted");
  assert.deepEqual(f.entry.config.decisionModel, {
    enabled: true, endpoint, timeoutMs: 1234, apiKeyFile: join(f.root, "secrets/unblock-memory-decisions.env"),
  });
  assert.equal(Object.hasOwn(f.entry.config, legacyKey), false);
  assert.deepEqual(f.entry.config.responseAudit, { enabled: false, senderIds: ["approved-human"] });
  assert.equal(f.config.unrelated.token, "private");
  const secretDir = join(f.root, "secrets"), path = join(secretDir, "unblock-memory-decisions.env");
  assert.equal(parseEnv(readFileSync(path, "utf8")).CODEX_LB_API_KEY, key);
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(secretDir).mode & 0o777, 0o700);
  const backup = readdirSync(secretDir).find(name => name.startsWith("decision-backup-"));
  assert.ok(readFileSync(join(secretDir, backup, "openclaw.json")).equals(before));
  assert.equal(statSync(join(secretDir, backup, "openclaw.json")).mode & 0o777, 0o600);
  f.commands.length = 0;
  assert.equal((await deploy({ apiKey: key, apply: true, restart: true }, f.cli)).status, "unchanged");
  assert.equal(f.commands.some(args => args[1] === "restart"), false);
  assert.equal((await deploy({ apiKey: "rotated-fixture-key", apply: true, restart: true }, f.cli)).restart, "not_needed");
  assert.equal(f.commands.some(args => args[1] === "restart"), false);
});

test("an upgraded host validates a private replacement before repairing the rejected legacy section", async () => {
  const f = fixture(), before = readFileSync(f.configPath);
  const candidatePaths = [];
  let acceptCandidate = false;
  const cli = (args, input, env) => {
    if (args[1] !== "validate") return f.cli(args, input);
    const candidate = env?.OPENCLAW_CONFIG_PATH;
    if (candidate) {
      assert.notEqual(candidate, f.configPath);
      assert.equal(dirname(candidate), f.root);
      assert.equal(statSync(candidate).mode & 0o777, 0o600);
      candidatePaths.push(candidate);
    }
    const config = JSON.parse(readFileSync(candidate ?? f.configPath, "utf8"));
    if (Object.hasOwn(config.plugins.entries["unblock-memory"].config, legacyKey)) {
      throw Object.assign(new Error("rejected before OpenClaw can patch"), { retiredKeyRejected: true });
    }
    return JSON.stringify({ valid: !candidate || acceptCandidate, path: candidate ?? f.configPath });
  };
  assert.equal((await deploy({ apiKey: key, apply: true }, cli)).stage, "validate_patch");
  assert.ok(readFileSync(f.configPath).equals(before));
  assert.equal(existsSync(join(f.root, "secrets")), false);
  acceptCandidate = true;
  assert.equal((await deploy({ apiKey: key, apply: false }, cli)).status, "planned");
  assert.ok(readFileSync(f.configPath).equals(before));
  assert.equal(existsSync(join(f.root, "secrets")), false);
  assert.equal((await deploy({ apiKey: key, apply: true }, cli)).status, "configured");
  assert.ok(candidatePaths.every(path => !existsSync(path)));
  const after = JSON.parse(readFileSync(f.configPath, "utf8"));
  const settings = after.plugins.entries["unblock-memory"].config;
  assert.deepEqual(settings, {
    responseAudit: f.entry.config.responseAudit,
    skillWhisperer: f.entry.config.skillWhisperer,
    decisionModel: { enabled: true, endpoint, timeoutMs: 1234, apiKeyFile: join(f.root, "secrets/unblock-memory-decisions.env") },
  });
  assert.deepEqual(after.unrelated, f.config.unrelated);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
});

test("failed preflight, symlink and disabled plugin never write; patch failure reports a partial key write without leaking errors", async () => {
  const f = fixture();
  let result = await deploy({ apiKey: key, apply: true, restart: false }, (args, input) => {
    if (args[1] === "patch") throw new Error(key);
    return f.cli(args, input);
  });
  assert.equal(result.stage, "validate_patch"); assert.equal(result.status, "failed");
  assert.equal(existsSync(join(f.root, "secrets")), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  f.entry.enabled = false;
  writeFileSync(f.configPath, JSON.stringify(f.config));
  assert.equal((await deploy({ apiKey: key, apply: true }, f.cli)).status, "failed");
  f.entry.enabled = true;
  writeFileSync(f.configPath, JSON.stringify(f.config));
  result = await deploy({ apiKey: key, apply: true, restart: false }, (args, input) => {
    if (args[1] === "patch" && !args.includes("--dry-run")) throw new Error(key);
    return f.cli(args, input);
  });
  assert.equal(result.stage, "configure"); assert.equal(result.keyChanged, true);
  assert.equal(result.status, "failed"); assert.equal(result.restart, "required");
  const g = fixture(); symlinkSync(f.root, join(g.root, "secrets"));
  assert.equal((await deploy({ apiKey: key, apply: true }, g.cli)).status, "failed");
});

test("verification uses private authored paths, tolerates CLI log prefixes, and still rejects a wrong saved path", async () => {
  const f = fixture();
  const result = await deploy({ apiKey: key, apply: true, restart: true }, (args, input) => {
    assert.notEqual(args[1], "get", "redacted CLI config must not drive credential comparisons");
    const output = f.cli(args, input);
    return ["file", "status"].includes(args[1]) ? `[plugins] registered\n${output}\n` : output;
  });
  assert.equal(result.status, "configured");
  assert.equal((await deploy({ apiKey: key, apply: true, restart: true }, f.cli)).status, "unchanged");
  const g = fixture();
  const wrong = await deploy({ apiKey: key, apply: true }, (args, input) => {
    const output = g.cli(args, input);
    if (args[1] === "patch" && !args.includes("--dry-run")) {
      g.entry.config.decisionModel.apiKeyFile = "/wrong/path.env";
      writeFileSync(g.configPath, JSON.stringify(g.config));
    }
    return output;
  });
  assert.equal(wrong.status, "failed"); assert.equal(wrong.stage, "verify");
});

test("concurrent config changes abort writes and restart failures stay visible", async () => {
  const f = fixture();
  const result = await deploy({ apiKey: key, apply: true }, (args, input) => {
    const output = f.cli(args, input);
    if (args.includes("--dry-run")) writeFileSync(f.configPath, "changed externally");
    return output;
  });
  assert.equal(result.stage, "write_key"); assert.equal(result.status, "failed");
  assert.equal(existsSync(join(f.root, "secrets")), false);
  const g = fixture();
  const failed = await deploy({ apiKey: key, apply: true, restart: true }, (args, input) => {
    if (args[1] === "restart" && !args.includes("--help")) throw new Error("busy");
    return g.cli(args, input);
  });
  assert.equal(failed.status, "failed"); assert.equal(failed.restart, "pending"); assert.equal(failed.configChanged, true);
});

test("reports whitelist fields and remote bootstrap accepts stdin without embedding keys in shell", () => {
  const output = safeReport(`noise\nDECISION_FLEET_RESULT ${JSON.stringify({ status: "failed", stage: key, extra: key, configChanged: true })}\n`);
  assert.equal(JSON.stringify(output).includes(key), false);
  assert.equal(remoteCommand.includes(key), false);
  const source = Buffer.from('export async function deploy(p){return {status:p.apiKey ? "planned":"failed",stage:"complete"}}').toString("base64");
  const child = spawnSync("/bin/sh", ["-c", remoteCommand], { input: JSON.stringify({ source, options: { apiKey: key } }), encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(safeReport(child.stdout).status, "planned");
  assert.equal(child.stdout.includes(key), false); assert.equal(child.stderr.includes(key), false);
});

test("local CLI rejects public CSV and duplicate endpoints, skips blanks, and sends key only through SSH stdin", () => {
  const f = fixture(), bin = join(f.root, "bin"); mkdirSync(bin);
  const log = join(f.root, "calls.jsonl");
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);fs.appendFileSync(process.env.FLEET_TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='-G'){console.log('hostname '+(process.env.FLEET_TEST_DUP ? 'same' : a[1])+'\\nuser fixture\\nport 22');}
else{let s='';for await(const c of process.stdin)s+=c;const p=JSON.parse(s);if(!p.options.apiKey)process.exit(2);console.log('DECISION_FLEET_RESULT '+JSON.stringify({status:'planned',stage:'complete',extra:p.options.apiKey}));}
`, { mode: 0o700 });
  // Extensionless node scripts default to CommonJS outside a package; force module detection with syntax on Node 22+.
  const csv = join(f.root, "keys.csv");
  writeFileSync(csv, `agent,ssh_host,api_key\nBill,billsmacmini,${key}\nPearl,pearlperelel,\n`, { mode: 0o600 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_TEST_LOG: log };
  const run = (extra, args = []) => spawnSync(process.execPath, [resolve("scripts/decision-fleet.mjs"), csv, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const child = run({});
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /skipped_blank/);
  assert.equal(child.stdout.includes(key), false); assert.equal(readFileSync(log, "utf8").includes(key), false);
  assert.equal(run({}, ["--provider", "codex"]).status, 1);
  writeFileSync(csv, `agent,ssh_host,api_key\nBill,billsmacmini,${key}\nPearl,pearlperelel,${key}\n`);
  const duplicate = run({ FLEET_TEST_DUP: "1" });
  assert.equal(duplicate.status, 1); assert.equal(duplicate.stderr.includes(key), false);
  const publicFile = join(f.root, "public.csv"); writeFileSync(publicFile, "", { mode: 0o644 });
  assert.equal(spawnSync(process.execPath, [resolve("scripts/decision-fleet.mjs"), publicFile], { env, encoding: "utf8" }).status, 1);
});

test("deployment preserves an existing Codex model pin and clears a cross-endpoint pin", async () => {
  const other = "https://other.example/decisions";
  for (const currentEndpoint of [undefined, endpoint, `${endpoint}/`, other]) {
    const f = fixture({ decisionModel: { apiKey: "old-secret", timeoutMs: 1240, model: "pinned-model", endpoint: currentEndpoint } });
    assert.equal((await deploy({ apiKey: key, apply: true }, f.cli)).status, "configured");
    assert.equal(f.entry.config.decisionModel.model, currentEndpoint === other ? undefined : "pinned-model");
    assert.equal(f.entry.config.decisionModel.endpoint, endpoint);
    assert.equal(f.entry.config.decisionModel.timeoutMs, 1240);
    assert.equal(Object.hasOwn(f.entry.config, legacyKey), false);
  }
});
