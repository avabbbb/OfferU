#!/usr/bin/env node
/** Report historical visual debt and reject NEW style violations in frontend/src. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, isGovernedPath, parseAddedLines, violations } from "./design-audit-rules.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(repo, "frontend", "src");
const args = process.argv.slice(2);
const json = args.includes("--json");

function git(...argv) {
  return execFileSync("git", argv, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}
function gitSafe(...argv) {
  try { return git(...argv); } catch { return null; }
}
function findFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "__snapshots__") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? findFiles(path) : [path];
  });
}
function repoPath(absolute) {
  return relative(repo, absolute).replace(/\\/g, "/");
}
const summary = Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
let scanned = 0;
for (const path of findFiles(src)) {
  const file = repoPath(path);
  if (!isGovernedPath(file)) continue;
  scanned++;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    for (const id of violations(line, file)) summary[id]++;
  }
}

const chosen = args.indexOf("--base");
let base = chosen !== -1 ? args[chosen + 1] : process.env.DESIGN_AUDIT_BASE;
if (!base) {
  base = gitSafe("rev-parse", "--verify", "refs/remotes/origin/main")
    ?? gitSafe("rev-parse", "--verify", "HEAD^");
}
if (!base || !gitSafe("rev-parse", "--verify", base + "^{commit}")) {
  console.error("[design:audit] Cannot resolve baseline; pass --base <git SHA/ref> or DESIGN_AUDIT_BASE.");
  process.exit(2);
}

const committed = gitSafe("diff", "--no-ext-diff", "--unified=0", "--diff-filter=ACMR", base, "HEAD", "--", "frontend/src");
const workspace = gitSafe("diff", "--no-ext-diff", "--unified=0", "--diff-filter=ACMR", "HEAD", "--", "frontend/src");
if (committed === null || workspace === null) {
  console.error("[design:audit] Git diff failed; do not silently bypass the policy.");
  process.exit(2);
}
const added = [...parseAddedLines(committed), ...parseAddedLines(workspace)];
const untracked = (gitSafe("ls-files", "--others", "--exclude-standard", "--", "frontend/src") ?? "")
  .split(/\r?\n/).filter(Boolean);
for (const file of untracked) {
  if (!isGovernedPath(file)) continue;
  readFileSync(join(repo, file), "utf8").split(/\r?\n/).forEach((line, i) => added.push({ file, number: i + 1, line }));
}
const seen = new Set();
const failures = [];
for (const entry of added) {
  for (const id of violations(entry.line, entry.file)) {
    const fingerprint = entry.file + ":" + entry.number + ":" + id;
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      failures.push({ file: entry.file, line: entry.number, rule: id, excerpt: entry.line.trim().slice(0, 160) });
    }
  }
}
const result = { baseline: base, scanned, existingMatchingLinesByRule: summary, addedMatchingViolations: failures.length, failures };
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("[design:audit] " + scanned + " files scanned; existing debt (matching lines, historical/non-blocking):");
  for (const rule of RULES) console.log("  " + rule.id.padEnd(20) + " " + String(summary[rule.id]).padStart(5));
  console.log("[design:audit] Diff against " + base + ": " + failures.length + " new violation(s)");
  for (const issue of failures) {
    console.error("  " + issue.file + ":" + issue.line + " [" + issue.rule + "] " + issue.excerpt);
  }
}
if (failures.length) process.exitCode = 1;
