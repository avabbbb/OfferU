// Record a real click-through demo video of the OfferU showcase workspace.
// Run: PLAYWRIGHT_BROWSERS_PATH=H:/tmp/offeru/pw-browsers node scripts/record-demo.mjs
// Requires: showcase vite on :7412 (VITE_SHOWCASE=true), playwright installed.

import { chromium } from "playwright";
import { mkdirSync } from "fs";

const OUT_DIR = "H:/tmp/offeru/demo-video";

const CHROME_EXE = "H:/tmp/offeru/pw-browsers/chromium-1243/chrome-win64/chrome.exe";
const BASE = "http://127.0.0.1:7412";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME_EXE,
  });
  const context = await browser.newContext({
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // 1. Today page — wait for data to load
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 2. Jobs page — click through
  await page.goto(`${BASE}/#/jobs`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // 3. Job detail — click first job card
  const jobCard = page.locator("[data-testid='job-card']").first();
  if (await jobCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await jobCard.click();
    await page.waitForTimeout(2000);
  } else {
    // fallback: navigate directly
    await page.goto(`${BASE}/#/jobs/1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
  }

  // 4. Role Intelligence panel — scroll to it
  const riPanel = page.locator("#role-intelligence-panel");
  if (await riPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await riPanel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
  }

  // 5. Resume proposal section
  const proposalCard = page.locator("[data-testid='resume-proposal']");
  if (await proposalCard.isVisible({ timeout: 2000 }).catch(() => false)) {
    await proposalCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
  }

  // 6. Pipeline page
  await page.goto(`${BASE}/#/pipeline`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 7. Back to Today
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  await context.close();
  await browser.close();

  if (errors.length) {
    console.error("CONSOLE ERRORS:", errors.length);
    errors.slice(0, 5).forEach((e) => console.error(" -", e));
    process.exit(1);
  }
  console.log("Video recorded to", OUT_DIR);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
