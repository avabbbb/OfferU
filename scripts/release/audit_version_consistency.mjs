// Fail-closed audit for the version declarations shipped by OfferU.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, parseArgs, print, readJson, readText } from "./lib.mjs";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function jsonVersion(path) {
  const version = readJson(path)?.version;
  if (typeof version !== "string" || !version) throw new Error(`version is missing: ${path}`);
  return version;
}

function cargoVersion(path) {
  const section = readText(path).split(/^\[/m).find((block) => block.startsWith("package]"));
  const match = section && /^version\s*=\s*"([^"]+)"/m.exec(section);
  if (!match) throw new Error(`package.version is missing: ${path}`);
  return match[1];
}

function companionVersion(path) {
  const match = /^export const APP_VERSION = "([^"]+)";$/m.exec(readText(path));
  if (!match) throw new Error(`APP_VERSION is missing: ${path}`);
  return match[1];
}

export function auditVersionConsistency(repoRoot) {
  const root = resolve(repoRoot);
  const sources = {
    frontend_package: [join(root, "frontend/package.json"), jsonVersion],
    tauri_config: [join(root, "frontend/src-tauri/tauri.conf.json"), jsonVersion],
    rust_package: [join(root, "frontend/src-tauri/Cargo.toml"), cargoVersion],
    companion_health: [join(root, "backend-ts/src/runtime-identity.ts"), companionVersion],
  };
  const versions = {};
  const findings = [];
  for (const [name, [path, read]] of Object.entries(sources)) {
    try {
      versions[name] = read(path);
    } catch (error) {
      findings.push(error.message);
      continue;
    }
    if (!SEMVER.test(versions[name])) findings.push(`${name} has invalid release version format`);
  }
  const distinct = new Set(Object.values(versions));
  if (distinct.size > 1) findings.push("release version declarations do not match");
  return {
    schema_version: "offeru.release_version_audit.v1",
    status: !findings.length && Object.keys(versions).length === Object.keys(sources).length ? "clear" : "fail",
    version: distinct.size === 1 ? [...distinct][0] : null,
    sources: versions,
    findings,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { repo_root: "value", json: "flag" });
  const result = auditVersionConsistency(args.repo_root || ".");
  if (args.json) print(result);
  else {
    console.log(`release version audit: ${result.status}`);
    if (result.version) console.log(`version: ${result.version}`);
    for (const finding of result.findings) console.log(`finding: ${finding}`);
  }
  process.exitCode = result.status === "clear" ? 0 : 1;
}
export const SCRIPT = fileURLToPath(import.meta.url);
