import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOTS = [
  "backend/app",
  "backend/requirements.txt",
  "backend/sidecar_entry.py",
  "backend/scripts/build_identity.mjs",
  "backend/scripts/build_sidecar.mjs",
  "backend/scripts/build_sidecar.ps1",
  "backend/tests/fixtures",
  "frontend/src",
  "frontend/src-tauri",
  "frontend/public",
  "frontend/index.html",
  "frontend/package.json",
  "frontend/package-lock.json",
  "frontend/vite.config.ts",
  "frontend/postcss.config.mjs",
  "frontend/tailwind.config.ts",
  "agent-runtime/src",
  "agent-runtime/package.json",
  "agent-runtime/package-lock.json",
  ".agents/skills/offeru",
];
const IGNORED_SEGMENTS = new Set([
  ".git", ".tmp", ".venv", ".venv312", "node_modules", "target", "dist",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache",
  "coverage", "uploads", "session", "sessions", "logs", "pytest-temp",
]);

function parseArgs(argv) {
  const options = { root: SCRIPT_ROOT, output: null, verify: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--root" && argv[index + 1]) options.root = resolve(argv[++index]);
    else if (option === "--output" && argv[index + 1]) options.output = resolve(argv[++index]);
    else if (option === "--verify" && argv[index + 1]) options.verify = resolve(argv[++index]);
    else throw new Error("Unsupported build identity argument.");
  }
  return options;
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function shouldFingerprint(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORED_SEGMENTS.has(part.toLowerCase()))) return false;
  const name = parts.at(-1) || "";
  if (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") return false;
  if (/^(?:config|settings)\.json$/i.test(name)) return false;
  if (/\.(?:db|sqlite)(?:[-.]|$)/i.test(name)) return false;
  return SOURCE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function walkFiles(root, directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (!shouldFingerprint(relativePath)) continue;
    if (entry.isDirectory()) walkFiles(root, absolute, output);
    else if (entry.isFile()) output.push(relativePath);
  }
}

function sourceFiles(root) {
  const listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const files = listed === null ? [] : listed.split("\0").filter(shouldFingerprint);
  if (listed === null) {
    for (const sourceRoot of SOURCE_ROOTS) walkFiles(root, join(root, sourceRoot), files);
  }
  return [...new Set(files)].sort();
}

function sourceFingerprint(root) {
  const hash = createHash("sha256");
  let included = 0;
  for (const path of sourceFiles(root)) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`) || !existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    hash.update(path, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(absolute));
    hash.update(Buffer.from([0]));
    included += 1;
  }
  if (included === 0) throw new Error("No OfferU build source files were found.");
  return `sha256:${hash.digest("hex")}`;
}

function currentIdentity(root) {
  const manifestPath = join(root, "frontend/package.json");
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  const commit = git(root, ["rev-parse", "HEAD"])?.trim().toLowerCase();
  const status = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!version || !/^[0-9a-f]{40}$/.test(commit || "") || status === null) {
    throw new Error("A Git checkout and application version are required to build the desktop package.");
  }
  return {
    schema_version: 1,
    version: String(version),
    commit,
    build_timestamp: new Date().toISOString(),
    dirty: status.length > 0,
    source_fingerprint: sourceFingerprint(root),
  };
}

function validMetadata(value) {
  return Boolean(
    value &&
      value.schema_version === 1 &&
      typeof value.version === "string" &&
      value.version.length > 0 &&
      typeof value.commit === "string" &&
      /^[0-9a-f]{40}$/.test(value.commit) &&
      typeof value.build_timestamp === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.build_timestamp) &&
      typeof value.dirty === "boolean" &&
      typeof value.source_fingerprint === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(value.source_fingerprint),
  );
}

function verify(root, artifactPath) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error("The packaged build identity artifact is missing or invalid.");
  }
  const current = currentIdentity(root);
  if (
    !validMetadata(metadata) ||
    metadata.version !== current.version ||
    metadata.commit !== current.commit ||
    metadata.source_fingerprint !== current.source_fingerprint
  ) {
    throw new Error("The packaged build identity is stale; rebuild the sidecar from this source tree.");
  }
}

function writeIdentity(root, outputPath) {
  const output = outputPath || join(root, ".tmp/offeru-build-identity.json");
  if (!isAbsolute(output)) throw new Error("Build identity output path must be absolute.");
  const parent = dirname(output);
  const identity = currentIdentity(root);
  mkdirSync(parent, { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, output);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.verify) verify(options.root, options.verify);
  else writeIdentity(options.root, options.output);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Build identity generation failed."}\n`);
  process.exitCode = 1;
}
