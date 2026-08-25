import { readFile } from "node:fs/promises";

const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(releaseTag ?? "");

if (match === null) {
  throw new Error("Release tag must match vX.Y.Z or vX.Y.Z-prerelease");
}

const [packageJson, manifest] = await Promise.all([
  readJson("package.json"),
  readJson("openclaw.plugin.json"),
]);
const releaseVersion = match[1];

if (packageJson.name !== "@unblocklabs/unblock-memory") {
  throw new Error(`Unexpected package name: ${String(packageJson.name)}`);
}
if (packageJson.version !== releaseVersion) {
  throw new Error(`package.json is ${String(packageJson.version)}, release is ${releaseVersion}`);
}
if (manifest.version !== releaseVersion) {
  throw new Error(`openclaw.plugin.json is ${String(manifest.version)}, release is ${releaseVersion}`);
}

console.log(`Release versions match: ${releaseVersion}`);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}
