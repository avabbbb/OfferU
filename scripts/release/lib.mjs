// Shared helpers for the release scripts (ported from backend/scripts/release/*.py).
import { readFileSync } from "node:fs";

export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replaceAll("-", "_");
      if (spec[key] === "flag") out[key] = true;
      else if (spec[key] === "value") out[key] = argv[++i];
      else throw new Error(`unknown option ${arg}`);
    } else out._.push(arg);
  }
  return out;
}

/** utf-8-sig like Python: a BOM is ignored. */
export const readText = (path) => readFileSync(path, "utf8").replace(/^\uFEFF/, "");
export const readJson = (path) => JSON.parse(readText(path));
export const isMain = (url) => process.argv[1] && new URL(url).pathname.replace(/^\/([A-Za-z]:)/, "$1") === process.argv[1].replaceAll("\\", "/");
export function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
