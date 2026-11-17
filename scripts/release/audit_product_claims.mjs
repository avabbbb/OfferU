// Fail closed on high-risk unqualified claims in release-facing surfaces.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { isMain, parseArgs, print, readText } from "./lib.mjs";

const SURFACE_FILES = ["CHANGELOG.md", "README.md", "README_EN.md"];
const CLAIMS = [
  ["automatic_external_write", /(?:自动(?:提交申请|投递|发送邮件|联系第三方)|(?:auto[- ]?|automatically\s+)(?:submit|send|contact)(?: applications?| email| third[- ]party)?)/i],
  ["unbounded_live_market_claim", /(?:全网实时|实时市场(?:数据|岗位)?|real[- ]time market|live market research)/i],
  ["public_release_ready_claim", /(?:OFFERU_PUBLIC_RELEASE_READY|Public Release Ready)/i],
];
const SAFE = /(?:不会|不自动|不是|尚未|未完成|未通过|未验证|不代表|仅用于|仅支持|需要|仍需|阻塞|实验性|候选|not ready|not verified|not available|does not|doesn't|not a|experimental|blocked|fixture|demo)/i;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function auditProductClaims(repoRoot) {
  const root = resolve(repoRoot);
  if (!existsSync(root)) throw new Error(`repository root does not exist: ${root}`);
  const paths = SURFACE_FILES.map((name) => join(root, name)).filter((path) => existsSync(path));
  const src = join(root, "frontend/src");
  if (existsSync(src)) paths.push(...walk(src).filter((path) => /\.(ts|tsx)$/.test(path)));
  paths.sort();
  const findings = [];
  for (const path of paths) {
    const lines = readText(path).split(/\r?\n/);
    lines.forEach((line, index) => {
      const window = lines.slice(Math.max(0, index - 1), index + 2).join("\n");
      for (const [category, pattern] of CLAIMS) {
        if (pattern.test(line) && !SAFE.test(window)) findings.push({ path: relative(root, path).split(sep).join("/"), line: index + 1, category });
      }
    });
  }
  return { schema_version: "offeru.product_claim_audit.v1", surface_file_count: paths.length, findings, status: findings.length ? "fail" : "clear" };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { repo_root: "value", json: "flag" });
  try {
    const result = auditProductClaims(args.repo_root || process.cwd());
    if (args.json) print(result);
    else console.log(`product claim audit: ${result.status} surfaces=${result.surface_file_count} findings=${result.findings.length}`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`product claim audit failed: ${error.message}`);
    process.exitCode = 2;
  }
}
