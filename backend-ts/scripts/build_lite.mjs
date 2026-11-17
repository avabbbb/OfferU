// Lite package (release-lite.yml): `npm install -g offeru-lite-<version>.tgz`, then `offeru start`
// serves the workbench and the API on 127.0.0.1:8766 with the user's own Node (>= 22.19).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { bundleCompanion } from "./bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "dist-lite");
const stage = join(root, ".tmp/lite");
const version = JSON.parse(readFileSync(join(root, "frontend/package.json"), "utf8")).version;

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

run("npm", ["--prefix", "frontend", "run", "build"]);
await bundleCompanion(stage);
cpSync(join(root, "frontend/dist"), join(stage, "web"), { recursive: true });
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: "offeru-lite",
  version,
  description: "OfferU local workbench (TS companion + web UI)",
  type: "module",
  bin: { offeru: "cli.mjs" },
  engines: { node: ">=22.19.0" },
  license: "SEE LICENSE IN LICENSE",
}, null, 2) + "\n");
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
writeFileSync(join(stage, "cli.mjs"), "#!/usr/bin/env node\n" + readFileSync(join(stage, "cli.mjs"), "utf8"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("npm", ["pack", "--pack-destination", out], stage);
console.log(`Lite package in ${out}`);
