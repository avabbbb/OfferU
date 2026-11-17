// Fail-closed verification for the files published as an OfferU release.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { isMain, parseArgs, readText } from "./lib.mjs";

const SHA256 = /^[0-9a-fA-F]{64}$/;
const CHECKSUM_LINE = /^([0-9a-fA-F]{64}) {2}(.+)$/;

function inside(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function metadataFile(root, name) {
  const raw = join(root, name);
  if (existsSync(raw) && lstatSync(raw).isSymbolicLink()) throw new Error(`release metadata file is a symlink: ${name}`);
  if (!existsSync(raw)) throw new Error(`release metadata file is missing: ${name}`);
  const candidate = realpathSync(raw);
  if (!inside(root, candidate)) throw new Error("release metadata path escapes the artifact root");
  if (!statSync(candidate).isFile()) throw new Error(`release metadata file is missing: ${name}`);
  return candidate;
}

function releaseFile(root, name) {
  if (typeof name !== "string" || !name || name === "." || name === "..") throw new Error("release artifact name is invalid");
  if (name.includes("\\") || name.includes("/") || isAbsolute(name) || basename(name) !== name) throw new Error("release artifact paths must be files in the artifact root");
  const raw = join(root, name);
  if (existsSync(raw) && lstatSync(raw).isSymbolicLink()) throw new Error(`release artifact file is a symlink: ${name}`);
  if (!existsSync(raw)) throw new Error(`release artifact file is missing: ${name}`);
  const candidate = realpathSync(raw);
  if (!inside(root, candidate)) throw new Error("release artifact path escapes the artifact root");
  if (!statSync(candidate).isFile()) throw new Error(`release artifact file is missing: ${name}`);
  return candidate;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function readManifest(root, target, version) {
  const payload = JSON.parse(readText(metadataFile(root, "artifacts.json")));
  if (!Array.isArray(payload) || !payload.length) throw new Error("artifacts.json must contain a non-empty list");
  const manifest = new Map();
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("artifacts.json contains an invalid entry");
    const { name, bytes, sha256: checksum } = item;
    if (typeof name !== "string" || manifest.has(name)) throw new Error("artifacts.json contains a duplicate or invalid name");
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) throw new Error(`artifact byte count is invalid: ${name}`);
    if (typeof checksum !== "string" || !SHA256.test(checksum)) throw new Error(`artifact SHA-256 is invalid: ${name}`);
    manifest.set(name, [releaseFile(root, name), bytes, checksum.toLowerCase()]);
  }
  const names = [...manifest.keys()];
  if (target === "windows-x64") {
    const folded = new Set(names.map((name) => name.toLowerCase()));
    if (!folded.has(`offeru-setup-${version}.exe`.toLowerCase())) throw new Error("release artifact set is missing its canonical NSIS setup executable");
    if (!folded.has(`offeru-${version}-x64.msi`.toLowerCase())) throw new Error("release artifact set is missing its canonical MSI installer");
  } else if (names.length !== 1 || !names[0].toLowerCase().endsWith(".dmg")) {
    throw new Error("macOS release artifact set must contain exactly one DMG installer");
  }
  return manifest;
}

function readChecksums(root) {
  const checksums = new Map();
  for (const line of readText(metadataFile(root, "SHA256SUMS.txt")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = CHECKSUM_LINE.exec(line);
    if (!match) throw new Error("SHA256SUMS.txt contains an invalid line");
    releaseFile(root, match[2]);
    if (checksums.has(match[2])) throw new Error("SHA256SUMS.txt contains a duplicate name");
    checksums.set(match[2], match[1].toLowerCase());
  }
  if (!checksums.size) throw new Error("SHA256SUMS.txt is empty");
  return checksums;
}

export function verifyReleaseArtifacts(rootArg, { expectedVersion = null, requireSigned = false } = {}) {
  if (existsSync(rootArg) && lstatSync(rootArg).isSymbolicLink()) throw new Error("release artifact directory must not be a symlink");
  if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) throw new Error(`release artifact directory does not exist: ${rootArg}`);
  const root = realpathSync(resolve(rootArg));
  const info = JSON.parse(readText(metadataFile(root, "version.json")));
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("version.json must contain an object");
  if (info.product !== "OfferU") throw new Error("version.json has an unexpected product");
  if (!["windows-x64", "macos-arm64", "macos-x64"].includes(info.target)) throw new Error("version.json has an unexpected target");
  if (typeof info.version !== "string" || !info.version) throw new Error("version.json has no release version");
  if (expectedVersion !== null && info.version !== expectedVersion) throw new Error("version.json does not match the expected release version");
  const manifest = readManifest(root, info.target, info.version);
  const checksums = readChecksums(root);
  const same = (a, b) => a.size === b.size && [...a.keys()].every((key) => b.has(key));
  if (!same(checksums, manifest)) throw new Error("SHA256SUMS.txt does not match artifacts.json");
  let total = 0;
  for (const [name, [path, bytes, checksum]] of manifest) {
    const size = statSync(path).size;
    if (size !== bytes) throw new Error(`artifact byte count mismatch: ${name}`);
    const actual = sha256(path);
    if (actual !== checksum || actual !== checksums.get(name)) throw new Error(`artifact SHA-256 mismatch: ${name}`);
    total += size;
  }
  if (typeof info.signed !== "boolean") throw new Error("version.json signed flag is invalid");
  if (requireSigned && !info.signed) throw new Error("release artifact set is not marked as signed");
  const installers = info.installers;
  if (!Array.isArray(installers) || !installers.length || installers.some((name) => typeof name !== "string")
    || new Set(installers).size !== installers.length || installers.length !== manifest.size || installers.some((name) => !manifest.has(name))) {
    throw new Error("version.json installers do not match artifacts.json");
  }
  return { status: "verified", product: "OfferU", version: info.version, target: info.target, signed: info.signed, installer_count: manifest.size, total_bytes: total };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { expected_version: "value", require_signed: "flag" });
  try {
    const result = verifyReleaseArtifacts(args._[0], { expectedVersion: args.expected_version ?? null, requireSigned: Boolean(args.require_signed) });
    console.log(`release artifact verification: PASS version=${result.version} target=${result.target} installers=${result.installer_count} signed=${result.signed ? "True" : "False"}`);
  } catch (error) {
    console.error(`release artifact verification failed: ${error.message}`);
    process.exitCode = 2;
  }
}
