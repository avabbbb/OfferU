// Fail-closed audit for the current known-issue severity ledger (docs/KNOWN_ISSUES.md).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { isMain, parseArgs, print, readText } from "./lib.mjs";

const HEADER = "| ID | Kind | Severity | Status | Release impact |";
const KINDS = new Set(["BUG", "PROVIDER_ISSUE", "RELEASE_GATE", "EXTERNAL_DECISION"]);
const SEVERITIES = ["GATE", "P0", "P1", "P2", "P3"];
const STATUSES = new Set(["OPEN", "BLOCKED_EXTERNAL", "NOT_VERIFIED", "RESOLVED"]);

const cells = (line) => {
  const value = line.trim();
  return value.startsWith("|") && value.endsWith("|") ? value.slice(1, -1).split("|").map((cell) => cell.trim()) : [];
};

export function auditReleaseSeverity(repoRoot) {
  const path = join(resolve(repoRoot), "docs/KNOWN_ISSUES.md");
  if (!existsSync(path)) throw new Error("docs/KNOWN_ISSUES.md is missing");
  const lines = readText(path).split(/\r?\n/);
  const rows = [];
  const findings = [];
  const header = lines.findIndex((line) => line.trim() === HEADER);
  if (header < 0) findings.push({ kind: "missing_ledger_header" });
  else {
    for (let index = header + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      if (!line.trimStart().startsWith("|")) {
        if (rows.length && line.trim().startsWith("## ")) break;
        continue;
      }
      const row = cells(line);
      if (!row.length || row.every((cell) => /^[-: ]*$/.test(cell))) continue;
      if (row.length !== 5) {
        findings.push({ line: lineNumber, kind: "invalid_ledger_row" });
        continue;
      }
      const [id, kind, severity, status, impact] = row;
      rows.push({ id, kind, severity, status, impact });
      if (!id) findings.push({ line: lineNumber, kind: "missing_issue_id" });
      if (!KINDS.has(kind)) findings.push({ line: lineNumber, kind: "invalid_issue_kind", value: kind });
      if (!SEVERITIES.includes(severity)) findings.push({ line: lineNumber, kind: "invalid_severity", value: severity });
      if (!STATUSES.has(status)) findings.push({ line: lineNumber, kind: "invalid_issue_status", value: status });
      if (!impact) findings.push({ line: lineNumber, kind: "missing_release_impact" });
    }
  }
  const ids = rows.map((row) => row.id);
  for (const id of [...new Set(ids.filter(Boolean))].sort()) {
    if (ids.filter((value) => value === id).length > 1) findings.push({ kind: "duplicate_issue_id", id });
  }
  if (!rows.length) findings.push({ kind: "empty_ledger" });
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, rows.filter((row) => row.severity === severity).length]));
  const p0p1 = rows.filter((row) => row.severity === "P0" || row.severity === "P1").map((row) => row.id);
  if (p0p1.length) findings.push({ kind: "open_p0_p1", ids: p0p1 });
  return {
    schema_version: "offeru.release_severity_audit.v1",
    ledger: "docs/KNOWN_ISSUES.md",
    issue_count: rows.length,
    severity_counts: counts,
    open_p0_p1: p0p1,
    findings,
    status: findings.length ? "violations" : "clear",
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { repo_root: "value", json: "flag" });
  try {
    const result = auditReleaseSeverity(args.repo_root || process.cwd());
    if (args.json) print(result);
    else console.log(`release severity audit: ${result.status} issues=${result.issue_count} p0_p1=${result.open_p0_p1.length}`);
    process.exitCode = result.status === "clear" ? 0 : 1;
  } catch (error) {
    console.error(`release severity audit failed: ${error.message}`);
    process.exitCode = 2;
  }
}
