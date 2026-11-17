// Fail-closed, value-free secret/PII scan for a release artifact directory.
import { lstatSync, openSync, readSync, closeSync, readFileSync, readdirSync, realpathSync, existsSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { isMain, parseArgs, print } from "./lib.mjs";

// Byte patterns: files are read as latin1 so each byte is one character.
const SECRET_PATTERNS = [
  ["offeru_canary", /OFFERU_[A-Z0-9_]*SECRET_[A-Za-z0-9_-]{4,}/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer_token", /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi],
  ["openai_like_key", /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9_]{20,}/g],
  ["google_api_key", /\bAIza[A-Za-z0-9_-]{30,}/g],
];
const PII_PATTERNS = [
  ["email_address", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,63})+(?![A-Za-z0-9._%+-])/g],
  ["phone_number", /(?<!\d)(?:\+?86[ -.]?)?1[3-9]\d{9}(?!\d)/g],
];
const SENSITIVE = new Set([".env", ".env.local", "auth.json", "cookies.json", "offeru.db", "djm.db"]);
const TEXT = new Set([".cfg", ".conf", ".csv", ".har", ".htm", ".html", ".ini", ".json", ".jsonl", ".log", ".md", ".toml", ".trace", ".txt", ".xml", ".yaml", ".yml"]);
const ALLOWED = { "chrome-mv3\u0000manifest.json": new Set(["email_address\u0000offeru-extension@offeru.local"]) };
const CHUNK = 1024 * 1024;
const OVERLAP = 256;
const CONTAINERS = new Set([".exe", ".msi", ".dmg"]);
const CONTEXTUAL = new Set(["bearer_token", "openai_like_key", "github_token", "google_api_key"]);

function hasTextContext(window, start, end) {
  const context = window.slice(Math.max(0, start - 24), Math.min(window.length, end + 24));
  if (!context.length) return false;
  let printable = 0;
  for (let i = 0; i < context.length; i += 1) {
    const code = context.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }
  return printable / context.length >= 0.85;
}

function maskChecksums(name, content) {
  if (name.toLowerCase() === "artifacts.json") {
    try {
      const manifest = JSON.parse(content);
      if (!Array.isArray(manifest)) return content;
      let changed = false;
      for (const item of manifest) {
        if (item && typeof item === "object" && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/i.test(item.sha256)) {
          item.sha256 = "";
          changed = true;
        }
      }
      return changed ? JSON.stringify(manifest) : content;
    } catch {
      return content;
    }
  }
  if (name.toLowerCase() === "sha256sums.txt") return content.replace(/^[0-9a-f]{64}(?= {2})/gim, "0".repeat(64));
  return content;
}

function scan(path, { textPii, maskMetadata, allowed }) {
  const findings = new Set();
  if (textPii && maskMetadata && statSync(path).size <= CHUNK) {
    const content = readFileSync(path).toString("latin1");
    for (const [name, pattern] of SECRET_PATTERNS) if (new RegExp(pattern.source, pattern.flags).test(content)) findings.add(name);
    const masked = maskChecksums(basename(path), content);
    for (const [name, pattern] of PII_PATTERNS) {
      for (const match of masked.matchAll(new RegExp(pattern.source, pattern.flags))) {
        if (!allowed.has(`${name}\u0000${match[0]}`)) findings.add(name);
      }
    }
    return findings;
  }
  const patterns = [...SECRET_PATTERNS, ...(textPii ? PII_PATTERNS : [])];
  const container = CONTAINERS.has(extname(path).toLowerCase());
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK);
  let overlap = "";
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (!read) break;
      const window = overlap + buffer.subarray(0, read).toString("latin1");
      for (const [name, pattern] of patterns) {
        for (const match of window.matchAll(new RegExp(pattern.source, pattern.flags))) {
          if (allowed.has(`${name}\u0000${match[0]}`)) continue;
          if (container && CONTEXTUAL.has(name) && !hasTextContext(window, match.index, match.index + match[0].length)) continue;
          findings.add(name);
          break;
        }
      }
      overlap = window.slice(-OVERLAP);
    }
  } finally {
    closeSync(fd);
  }
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    out.push(path);
    if (stat.isDirectory()) walk(path, out);
  }
  return out;
}

export function auditArtifactTree(rootArg) {
  if (existsSync(rootArg) && lstatSync(rootArg).isSymbolicLink()) throw new Error("artifact root must not be a symlink");
  if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) throw new Error(`artifact directory does not exist: ${resolve(rootArg)}`);
  const root = realpathSync(resolve(rootArg));
  const findings = [];
  const files = [];
  for (const path of walk(root)) {
    const rel = relative(root, path).split(sep).join("/");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) findings.push({ path: rel, kind: "symlink" });
    else if (stat.isFile()) files.push(path);
  }
  let total = 0;
  const rootName = basename(root);
  for (const path of files) {
    const rel = relative(root, path).split(sep).join("/");
    total += statSync(path).size;
    if (SENSITIVE.has(basename(path).toLowerCase())) findings.push({ path: rel, kind: "sensitive_filename" });
    const kinds = scan(path, {
      textPii: TEXT.has(extname(path).toLowerCase()),
      maskMetadata: rootName.toLowerCase() === "release-artifacts" && ["artifacts.json", "sha256sums.txt"].includes(rel.toLowerCase()),
      allowed: ALLOWED[`${rootName}\u0000${rel}`] ?? new Set(),
    });
    for (const kind of [...kinds].sort()) findings.push({ path: rel, kind });
  }
  return { schema_version: "offeru.release_artifact_audit.v1", root: rootName, file_count: files.length, total_bytes: total, findings, status: findings.length ? "fail" : "clear" };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { json: "flag" });
  try {
    const result = auditArtifactTree(args._[0]);
    if (args.json) print(result);
    else console.log(`release artifact audit: ${result.status} files=${result.file_count} findings=${result.findings.length}`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`release artifact audit failed: ${error.message}`);
    process.exitCode = 2;
  }
}
