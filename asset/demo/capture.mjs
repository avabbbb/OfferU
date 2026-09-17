/**
 * OfferU demo capture script.
 *
 * Prerequisites:
 *   - Showcase frontend running on http://127.0.0.1:7412 (VITE_SHOWCASE=true)
 *   - Managed Chromium available via Playwright or the browser tool
 *
 * Usage:
 *   node asset/demo/capture.mjs
 *
 * Output:
 *   H:/tmp/offeru/demo-video/frame-*.png  (raw frames)
 *   asset/demo/offeru-demo.gif            (assembled GIF, if ffmpeg available)
 */

import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:7412";
const OUT_DIR = "H:/tmp/offeru/demo-video";
const GIF_OUT = "asset/demo/offeru-demo.gif";

const SHOTS = [
  { url: `${BASE}/#/`, name: "frame-01-home.png", wait: 3000 },
  { url: `${BASE}/#/applications?view=board`, name: "frame-02-pipeline.png", wait: 2500 },
  { url: `${BASE}/#/jobs`, name: "frame-03-jobs.png", wait: 2500 },
  { url: `${BASE}/#/jobs/1`, name: "frame-04-job-detail.png", wait: 2500 },
  { url: `${BASE}/#/profile`, name: "frame-05-profile.png", wait: 2500 },
  { url: `${BASE}/#/settings`, name: "frame-06-settings.png", wait: 2500 },
];

mkdirSync(OUT_DIR, { recursive: true });

async function capture() {
  // Use Playwright if available, otherwise fall back to manual instructions
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch {
    console.log("Playwright not available. Install with: npm i -D playwright");
    console.log("Then run: npx playwright install chromium");
    process.exit(1);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  for (const shot of SHOTS) {
    await page.goto(shot.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(shot.wait);
    await page.screenshot({ path: `${OUT_DIR}/${shot.name}` });
    console.log(`captured ${shot.name}`);
  }

  await browser.close();

  // Convert to GIF if ffmpeg is on PATH
  try {
    // Rename to sequential pattern for ffmpeg
    for (let i = 0; i < SHOTS.length; i++) {
      const src = `${OUT_DIR}/${SHOTS[i].name}`;
      const dst = `${OUT_DIR}/real-${String(i + 1).padStart(2, "0")}.png`;
      copyFileSync(src, dst);
    }
    execSync(
      `ffmpeg -framerate 1 -i ${OUT_DIR}/real-%02d.png ` +
        `-vf "scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse" ` +
        `-loop 0 -y ${GIF_OUT}`,
      { stdio: "inherit" }
    );
    console.log(`GIF saved to ${GIF_OUT}`);
  } catch (e) {
    console.log("ffmpeg not found; frames saved to", OUT_DIR);
    console.log("Convert manually: ffmpeg -framerate 1 -i real-%02d.png ...");
  }
}

capture().catch(console.error);
