// Native desktop build: the installed app never needs Python, Node, or npm.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backend = join(root, "backend");
const windows = process.platform === "win32";
const nativeTarget = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
}[`${process.platform}-${process.arch}`];
if (!nativeTarget) throw new Error("Build on Windows x64 or a native Intel/Apple Silicon Mac.");
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== nativeTarget) {
  throw new Error("Python and Node sidecars must be built on the target architecture; cross-compilation is not supported.");
}
const extension = windows ? ".exe" : "";
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, "frontend/src-tauri/binaries");
const temp = join(root, ".tmp");
const stage = join(temp, "p");
const build = join(temp, "offeru-sidecar-build");
const runtime = join(root, "agent-runtime");
const node = process.env.OFFERU_NODE_PATH || process.execPath;
const venv = join(backend, ".venv312", windows ? "Scripts/python.exe" : "bin/python");
const python = process.env.OFFERU_PYTHON_PATH || (existsSync(venv) ? venv : windows ? "python" : "python3");

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr || "see build output"}`);
  return result.stdout?.trim();
}

const nodeInfo = JSON.parse(run(node, ["-p", "JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})"], true));
const [major, minor] = nodeInfo.version.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error("The bundled runtime requires Node >= 22.19.0.");
if (nodeInfo.arch !== process.arch || nodeInfo.platform !== process.platform) throw new Error("Node architecture does not match this build.");
const pythonArch = run(python, ["-c", "import platform; print(platform.machine().lower())"], true);
if (!(process.arch === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"]).includes(pythonArch)) {
  throw new Error("Python architecture does not match this build.");
}
if (!existsSync(join(runtime, "node_modules/@earendil-works/pi-coding-agent"))) {
  throw new Error("Install agent-runtime dependencies with npm ci before packaging.");
}
mkdirSync(temp, { recursive: true });
if (realpathSync(temp) !== join(realpathSync(root), ".tmp")) throw new Error("Build directory resolves outside the workspace.");
mkdirSync(dist, { recursive: true });
mkdirSync(build, { recursive: true });
// Resolve the actual deletion target before replacing only our staging folder.
if (existsSync(stage)) {
  if (!realpathSync(stage).startsWith(realpathSync(temp) + sep)) throw new Error("Runtime staging path escapes the build directory.");
  rmSync(stage, { recursive: true });
}
mkdirSync(join(stage, "src"), { recursive: true });
cpSync(join(runtime, "src/worker.mjs"), join(stage, "src/worker.mjs"));
cpSync(join(runtime, "node_modules"), join(stage, "node_modules"), { recursive: true });
cpSync(join(runtime, "package-lock.json"), join(stage, "package-lock.json"));
const manifest = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
// Keep the existing minimum Pi bundle; the optional hosted Claude SDK is not shipped.
delete manifest.dependencies["@anthropic-ai/claude-agent-sdk"];
writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
if (!process.env.npm_execpath) throw new Error("Run this builder through npm run build:sidecar.");
run(process.execPath, [process.env.npm_execpath, "--prefix", stage, "prune", "--omit=dev", "--ignore-scripts", "--offline"]);
if (!existsSync(join(stage, "node_modules/@earendil-works/pi-coding-agent"))) throw new Error("Packaged AI runtime is missing.");
cpSync(node, join(dist, `offeru-node-${nativeTarget}${extension}`));

const args = [
  "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile", "--name", "offeru-backend",
  "--distpath", dist, "--workpath", join(build, "work"), "--specpath", join(build, "spec"),
  "--paths", backend, "--collect-all", "app", "--collect-submodules", "aiosqlite",
  "--add-data", `${join(backend, "app/agents/skills")}${windows ? ";" : ":"}app/agents/skills`,
  "--add-data", `${join(backend, "tests/fixtures")}${windows ? ";" : ":"}tests/fixtures`,
  "--add-data", `${join(root, ".agents/skills/offeru")}${windows ? ";" : ":"}offeru-assets/skills/offeru`,
];
if (process.platform === "darwin") {
  args.push("--osx-entitlements-file", join(root, "frontend/src-tauri/Entitlements.plist"));
  if (process.env.APPLE_SIGNING_IDENTITY) args.push("--codesign-identity", process.env.APPLE_SIGNING_IDENTITY);
}
run(python, [...args, join(backend, "sidecar_entry.py")]);
renameSync(join(dist, `offeru-backend${extension}`), join(dist, `offeru-backend-${nativeTarget}${extension}`));
console.log(`Staged native ${nativeTarget} backend, Node ${nodeInfo.version}, AI runtime, and OfferU Skill.`);
