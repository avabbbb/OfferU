// Collect consistently named desktop installers and their verification metadata.
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function collectArtifacts(source, output, { version, target, signed }) {
  const patterns = target === "windows-x64"
    ? [[/-setup\.exe$/i, `OfferU-Setup-${version}.exe`], [/\.msi$/i, `OfferU-${version}-x64.msi`]]
    : [[/\.dmg$/i, `OfferU-${version}-${target.replace(/^macos-/, "")}.dmg`]];
  const files = walk(source);
  const sources = patterns.map(([pattern, name]) => {
    const found = files.filter((path) => pattern.test(path));
    if (found.length !== 1) throw new Error(`Expected exactly one ${pattern} in ${source}, found ${found.length}`);
    return [found[0], name];
  });
  mkdirSync(output, { recursive: true });
  const manifest = sources.map(([path, name]) => {
    const destination = join(output, name);
    copyFileSync(path, destination);
    const bytes = readFileSync(destination);
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  writeFileSync(join(output, "artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, "SHA256SUMS.txt"), manifest.map((item) => `${item.sha256}  ${item.name}\n`).join(""));
  writeFileSync(join(output, "version.json"), `${JSON.stringify({ product: "OfferU", version, target, installers: manifest.map((item) => item.name), signed }, null, 2)}\n`);
  for (const name of ["CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) copyFileSync(join(repo, name), join(output, name));
}

const args = parseArgs(process.argv.slice(2), { version: "value", target: "value", signed: "flag" });
if (args._.length === 2) {
  if (!args.version) throw new Error("--version is required");
  if (!["windows-x64", "macos-arm64", "macos-x64"].includes(args.target)) throw new Error("--target must be windows-x64, macos-arm64 or macos-x64");
  collectArtifacts(resolve(args._[0]), resolve(args._[1]), { version: args.version, target: args.target, signed: Boolean(args.signed) });
}
