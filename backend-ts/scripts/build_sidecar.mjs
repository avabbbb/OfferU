// Desktop sidecar: the Tauri app runs the TS companion with a bundled Node binary.
//   frontend/src-tauri/binaries/offeru-node-<triple>[.exe]   (externalBin)
//   .tmp/ts-sidecar/                                         (bundle resource → <resources>/backend-ts/)
//       server.mjs, cli.mjs, assets/, skill/, node_modules/playwright-core,
//       offeru-build-identity.json, resume-browsers/ (Windows: headless Chromium for PDF export)
// Run through `npm run build:sidecar` in frontend/ (tauri.conf.json beforeBuildCommand).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { bundleCompanion } from "./bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const windows = process.platform === "win32";
const nativeTarget = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
}[`${process.platform}-${process.arch}`];
if (!nativeTarget) throw new Error(`Unsupported build platform ${process.platform}-${process.arch}.`);
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== nativeTarget) {
  throw new Error("The Node sidecar must be built on the target architecture; cross-compilation is not supported.");
}
const extension = windows ? ".exe" : "";
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, "frontend/src-tauri/binaries");
const stage = join(root, ".tmp/ts-sidecar");
const node = process.env.OFFERU_NODE_PATH || process.execPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", windowsHide: true, env: { ...process.env, ...options.env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr || "see build output"}`);
  return result.stdout?.trim();
}

// node:sqlite without a flag needs Node >= 22.13; keep the floor the Python sidecar used.
const info = JSON.parse(run(node, ["-p", "JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})"], { capture: true }));
const [major, minor] = info.version.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error("The bundled runtime requires Node >= 22.19.0.");
if (info.arch !== process.arch || info.platform !== process.platform) throw new Error("Node architecture does not match this build.");
if (!existsSync(join(root, "backend-ts/node_modules/hono"))) throw new Error("Install backend-ts dependencies (npm --prefix backend-ts ci) before packaging.");

await bundleCompanion(stage);
run(node, [join(root, "backend-ts/scripts/build_identity.mjs"), "--output", join(root, ".tmp/offeru-build-identity.json")]);
cpSync(join(root, ".tmp/offeru-build-identity.json"), join(stage, "offeru-build-identity.json"));

// Smoke the bundle with the Node that ships: it must load node:sqlite and answer `doctor`.
run(node, [join(stage, "cli.mjs"), "doctor"], { capture: true, env: { OFFERU_DATA_DIR: join(root, ".tmp/ts-sidecar-smoke"), NODE_NO_WARNINGS: "1" } });

// PDF export: Windows and Linux ship Playwright's headless Chromium so no browser download is
// needed. macOS keeps using an installed Chrome / Edge (same gate the Python sidecar had: the
// prebuilt Chromium is not notarized with the app).
if (process.platform !== "darwin" && existsSync(join(stage, "node_modules/playwright-core/cli.js"))) {
  const browsers = join(stage, "resume-browsers");
  mkdirSync(browsers, { recursive: true });
  run(node, [join(stage, "node_modules/playwright-core/cli.js"), "install", "--only-shell", "chromium"], { env: { PLAYWRIGHT_BROWSERS_PATH: browsers } });
}

mkdirSync(dist, { recursive: true });
cpSync(node, join(dist, `offeru-node-${nativeTarget}${extension}`));
console.log(`Staged the OfferU TS companion (${stage}) and Node ${info.version} for ${nativeTarget}.`);
