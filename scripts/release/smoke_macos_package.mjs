// Check a copied macOS app's bundled runtime (Node + TS companion) without opening any UI.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

import { parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), { version: "value" });
const app = resolve(args._[0] || "");
if (!args._[0] || !args.version) throw new Error("usage: smoke_macos_package.mjs <OfferU.app> --version <x.y.z>");

const portBusy = () => new Promise((done) => {
  const socket = createConnection({ host: "127.0.0.1", port: 8766 });
  socket.setTimeout(1000);
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
  socket.once("timeout", () => { socket.destroy(); done(false); });
});
if (await portBusy()) throw new Error("Port 8766 already has a service; refusing to reuse it as package evidence.");

const root = mkdtempSync(join(process.env.RUNNER_TEMP || "/tmp", "offeru-package-"));
try {
  const installed = join(root, "OfferU.app");
  cpSync(app, installed, { recursive: true, verbatimSymlinks: true });
  const node = join(installed, "Contents/MacOS/offeru-node");
  const companion = join(installed, "Contents/Resources/backend-ts");
  const data = join(root, "data");
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME || root, NODE_NO_WARNINGS: "1" };
  // These calls must work without a system Node on PATH.
  const check = (argv, label) => {
    const result = spawnSync(node, argv, { env, encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.status}`);
    return result.stdout;
  };
  check(["--version"], "bundled Node");
  const doctor = JSON.parse(check([join(companion, "cli.mjs"), "--data-dir", data, "doctor"], "packaged CLI"));
  if (!doctor.ok) throw new Error("Packaged CLI did not report ok.");

  const log = createWriteStream(join(root, "backend.log"));
  const server = spawn(node, [join(companion, "server.mjs")], {
    env: {
      ...env, OFFERU_DATA_DIR: data, OFFERU_PORT: "8766", OFFERU_VERSION: args.version, OFFERU_BUILD_MODE: "release",
      OFFERU_RUNTIME_MODE: "desktop-sidecar", OFFERU_BUILD_IDENTITY_PATH: join(companion, "offeru-build-identity.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  let exited = false;
  server.once("exit", () => { exited = true; });
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (exited) throw new Error("Packaged backend exited before it became healthy.");
      if (Date.now() > deadline) throw new Error("Packaged backend did not become healthy within 90 seconds.");
      let health = null;
      try {
        const response = await fetch("http://127.0.0.1:8766/api/health", { redirect: "error", signal: AbortSignal.timeout(2000) });
        health = await response.json();
      } catch {
        await new Promise((done) => setTimeout(done, 1000));
        continue;
      }
      const expected = { status: "ok", service: "OfferU", runtime: "node", build_mode: "release", version: args.version };
      if (Object.entries(expected).every(([key, value]) => health[key] === value) && health.build_identity?.build_source === "package") {
        console.log("Packaged macOS Node runtime, TS companion and CLI smoke passed; UI and Agent acceptance remain separate.");
        break;
      }
      throw new Error("Runtime identity does not match the package.");
    }
  } catch (error) {
    const failure = join(process.env.RUNNER_TEMP || root, "offeru-macos-backend.log");
    log.end();
    copyFileSync(join(root, "backend.log"), failure);
    console.log(`Backend failure log: ${failure}`);
    throw error;
  } finally {
    server.kill("SIGTERM");
  }
} finally {
  if (process.env.RUNNER_TEMP) rmSync(root, { recursive: true, force: true });
}
