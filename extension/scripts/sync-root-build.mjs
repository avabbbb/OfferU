import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXT_ROOT = resolve(import.meta.dirname, "..");
const WXT_OUTPUT = join(EXT_ROOT, ".output", "chrome-mv3");
const STATIC_DIR = join(EXT_ROOT, "static");

const SYNC_TARGETS = [
  "manifest.json",
  "background.js",
  "popup.html",
  "content-scripts",
  "assets",
  "chunks",
];

const STATIC_SYNC_TARGETS = ["offscreen", "popup.css"];
const REQUIRED_OUTPUTS = ["manifest.json", "background.js", "popup.html", "content-scripts", "chunks"];

if (!existsSync(WXT_OUTPUT)) {
  console.error("[sync-root-build] WXT output not found:", WXT_OUTPUT);
  console.error("[sync-root-build] Run 'wxt build' first.");
  process.exit(1);
}

const missingRequiredOutputs = REQUIRED_OUTPUTS.filter(
  (target) => !existsSync(join(WXT_OUTPUT, target)),
);
if (missingRequiredOutputs.length > 0) {
  console.error(
    "[sync-root-build] Required WXT output is missing:",
    missingRequiredOutputs.join(", "),
  );
  console.error(
    "[sync-root-build] Refusing to leave a stale extension root. Fix the WXT build first.",
  );
  process.exit(1);
}

const popupContent = readFileSync(join(WXT_OUTPUT, "popup.html"), "utf8");
const backgroundContent = readFileSync(join(WXT_OUTPUT, "background.js"), "utf8");
const requiredPopupMarkers = [
  "7410",
  "OfferU 网页服务未启动",
  "AbortController",
  "redirect",
  "normalizeReleaseDownloadUrl",
  "更新地址不安全",
  "https:",
];
const missingPopupMarkers = requiredPopupMarkers.filter((marker) => !popupContent.includes(marker));
if (missingPopupMarkers.length > 0) {
  console.error(
    "[sync-root-build] Popup output is missing the fixed 7410 readiness guard:",
    missingPopupMarkers.join(", "),
  );
  console.error(
    "[sync-root-build] Refusing to sync a stale popup that could open an unreachable browser tab.",
  );
  process.exit(1);
}

const requiredBackgroundMarkers = [
  "127.0.0.1:8765",
  "/api/health",
  "OfferU",
  "python",
  "redirect",
];
const missingBackgroundMarkers = requiredBackgroundMarkers.filter(
  (marker) => !backgroundContent.includes(marker),
);
if (missingBackgroundMarkers.length > 0) {
  console.error(
    "[sync-root-build] Background output is missing the fixed backend health guard:",
    missingBackgroundMarkers.join(", "),
  );
  console.error(
    "[sync-root-build] Refusing to sync a stale background that could accept the wrong local service.",
  );
  process.exit(1);
}

for (const target of SYNC_TARGETS) {
  const src = join(WXT_OUTPUT, target);
  const dest = join(EXT_ROOT, target);

  if (!existsSync(src)) {
    console.warn("[sync-root-build] Skip missing:", target);
    continue;
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, force: true });
  console.log("[sync-root-build] Synced:", target);
}

for (const target of STATIC_SYNC_TARGETS) {
  const src = join(STATIC_DIR, target);
  const dest = join(EXT_ROOT, target);

  if (!existsSync(src)) {
    console.warn("[sync-root-build] Skip missing static:", target);
    continue;
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, force: true });
  console.log("[sync-root-build] Synced static:", target);
}

const stalePatterns = ["dist"];
for (const pattern of stalePatterns) {
  const staleDir = join(EXT_ROOT, pattern);
  if (existsSync(staleDir)) {
    rmSync(staleDir, { recursive: true, force: true });
    console.log("[sync-root-build] Cleaned stale:", pattern);
  }
}

console.log("[sync-root-build] Done. Extension root is ready for browser loading.");
