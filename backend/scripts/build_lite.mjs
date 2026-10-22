// Build the OfferU lite wheel: workbench + Skill assets bundled inside the `app` package.
// Usage: node backend/scripts/build_lite.mjs   → dist-lite/offeru-<version>-py3-none-any.whl
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stage = join(root, ".tmp/lite");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

run(npm, ["run", "build"], join(root, "frontend"));
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "offeru-assets/skills"), { recursive: true });
cpSync(join(root, "frontend/dist"), join(stage, "resume-frontend"), { recursive: true });
cpSync(join(root, ".agents/skills/offeru"), join(stage, "offeru-assets/skills/offeru"), { recursive: true });
run(process.execPath, [join(root, "backend/scripts/build_identity.mjs"), "--output", join(stage, "offeru-assets/offeru-build-identity.json")], root);
run("uv", ["build", "--wheel", "--out-dir", join(root, "dist-lite"), join(root, "backend")], root);
