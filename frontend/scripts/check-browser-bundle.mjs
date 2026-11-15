#!/usr/bin/env node
// Guard for the web build: no Node built-ins may reach the browser bundle.
// The in-page backend imports backend-ts sources; a stray node:* import there would
// only fail at runtime in the user's browser, so fail the build instead.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] || "dist");
const NODE_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](node:[a-z_/]+|fs|path|os|child_process|crypto|http|https|net|tls|zlib|stream|worker_threads|async_hooks)["']/g;
const bad = [];
let files = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(m?js)$/.test(entry.name)) {
      files += 1;
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(NODE_IMPORT)) bad.push(`${path.relative(dist, full)}: ${match[1]}`);
    }
  }
}
if (!fs.existsSync(dist)) {
  console.error(`check-browser-bundle: ${dist} does not exist; build first`);
  process.exit(1);
}
walk(dist);
if (bad.length) {
  console.error(`check-browser-bundle: Node built-ins in the browser bundle:\n  ${[...new Set(bad)].join("\n  ")}`);
  process.exit(1);
}
console.log(`check-browser-bundle: ${files} JS files, no Node built-ins`);
