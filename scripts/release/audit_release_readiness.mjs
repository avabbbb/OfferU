// Fail-closed audit for the Public Release checklist (docs/RELEASE_CHECKLIST.md).
// PARTIAL is rejected on purpose: a local slice must not pass for a release gate.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { isMain, parseArgs, print, readText } from "./lib.mjs";

const ALLOWED = ["BLOCKED_EXTERNAL", "FAIL", "NOT_VERIFIED", "PASS", "PRE_EXISTING_FAILURE"];
const EXPECTED_IDS = Array.from({ length: 114 }, (_, index) => index);
const ROW = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/;

export function auditReleaseReadiness(checklist) {
  if (!existsSync(checklist)) {
    return { status: "INVALID", verdict: "OFFERU_PUBLIC_RELEASE_NOT_READY", checklist, row_count: 0, expected_row_count: EXPECTED_IDS.length, blocking_ids: [], external_blocker_ids: [], findings: [`checklist not found: ${checklist}`] };
  }
  const rows = [];
  const findings = [];
  readText(checklist).split(/\r?\n/).forEach((line, index) => {
    const match = ROW.exec(line);
    if (!match) return;
    const id = Number(match[1]);
    const status = match[3].trim();
    rows.push({ id, requirement: match[2].trim(), status, line: index + 1 });
    if (!ALLOWED.includes(status)) findings.push(`line ${index + 1}: unsupported status '${status}' for R${id}`);
  });
  const ids = rows.map((row) => row.id);
  const duplicates = [...new Set(ids.filter((id) => ids.filter((value) => value === id).length > 1))].sort((a, b) => a - b);
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const unexpected = [...new Set(ids.filter((id) => !EXPECTED_IDS.includes(id)))].sort((a, b) => a - b);
  if (duplicates.length) findings.push(`duplicate requirement ids: [${duplicates.join(", ")}]`);
  if (missing.length) findings.push(`missing requirement ids: [${missing.join(", ")}]`);
  if (unexpected.length) findings.push(`unexpected requirement ids: [${unexpected.join(", ")}]`);
  const blocking = rows.filter((row) => row.status !== "PASS" && row.status !== "BLOCKED_EXTERNAL");
  const external = rows.filter((row) => row.status === "BLOCKED_EXTERNAL");
  const [status, verdict] = findings.length ? ["INVALID", "OFFERU_PUBLIC_RELEASE_NOT_READY"]
    : blocking.length ? ["NOT_READY", "OFFERU_PUBLIC_RELEASE_NOT_READY"]
      : external.length ? ["BLOCKED_EXTERNAL", "BLOCKED_BY_TRUE_EXTERNAL_RELEASE_REQUIREMENT"]
        : ["READY", "OFFERU_PUBLIC_RELEASE_READY"];
  return {
    status,
    verdict,
    checklist,
    row_count: rows.length,
    expected_row_count: EXPECTED_IDS.length,
    blocking_ids: blocking.map((row) => row.id),
    external_blocker_ids: external.map((row) => row.id),
    status_counts: Object.fromEntries(ALLOWED.map((name) => [name, rows.filter((row) => row.status === name).length])),
    findings,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { repo_root: "value", json: "flag", require_ready: "flag" });
  const result = auditReleaseReadiness(join(resolve(args.repo_root || "."), "docs/RELEASE_CHECKLIST.md"));
  if (args.json) print(result);
  else {
    console.log(`${result.verdict} (${result.status})`);
    console.log(`checklist rows: ${result.row_count}/${result.expected_row_count}`);
    if (result.blocking_ids.length) console.log(`blocking ids: ${result.blocking_ids.map((id) => `R${id}`).join(", ")}`);
    if (result.external_blocker_ids.length) console.log(`external blocker ids: ${result.external_blocker_ids.map((id) => `R${id}`).join(", ")}`);
    for (const finding of result.findings) console.log(`finding: ${finding}`);
  }
  process.exitCode = result.findings.length ? 1 : args.require_ready && result.status !== "READY" ? 2 : 0;
}
