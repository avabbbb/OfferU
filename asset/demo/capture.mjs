/**
 * Re-capture the README screenshots and demo GIF frames from the web app.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node asset/demo/capture.mjs            # all shots
 *   node asset/demo/capture.mjs 04-job-detail,08-resume-optimize
 *
 * The web app keeps data in the browser (IndexedDB "offeru-local"), so the script seeds
 * a fictional workspace from demo-seed.json before capturing. No account, no API key and no
 * model call is used; nothing is written anywhere but the throwaway browser profile.
 * The page clock is pinned to 2026-11-18 10:30 (Asia/Shanghai) so dates in the seed line up.
 *
 * Env: OFFERU_URL (default https://offeru.avabbbb.com/), OUT (default asset/screenshots).
 * Output is 1440x900 @2x PNG; run `pngquant --quality=70-92` afterwards to keep each < 500 KB.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.OFFERU_URL || "https://offeru.avabbbb.com/";
const OUT = process.env.OUT || "asset/screenshots";
const SEED = JSON.parse(readFileSync(new URL("./demo-seed.json", import.meta.url), "utf8"));
const NOW = Date.UTC(2026, 10, 18, 2, 30); // 10:30 Asia/Shanghai
const only = process.argv[2]?.split(",");
mkdirSync(OUT, { recursive: true });

async function session({ pinClock }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  // Dialog animations stall under a frozen clock, so settings shots run unpinned.
  if (pinClock) await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.evaluate(async (state) => {
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open("offeru-local"); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put(state, "offeru-demo-state:v1"); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, SEED);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  return { browser, page };
}

const go = async (page, hash, wait = 3500) => { await page.goto(BASE + hash, { waitUntil: "load" }); await page.waitForTimeout(wait); };
const click = async (page, text) => { await page.getByText(text, { exact: true }).first().click(); await page.waitForTimeout(2000); };

const SHOTS = {
  "01-today-workbench": { pin: true, run: (p) => go(p, "#/") },
  "02-pipeline-board": { pin: true, run: async (p) => { await go(p, "#/jobs"); await click(p, "看板"); } },
  "03-jobs-list": { pin: true, run: async (p) => { await go(p, "#/jobs"); await click(p, "表格"); } },
  "04-job-detail": { pin: true, run: (p) => go(p, "#/jobs/2") },
  "05-profile": { pin: true, run: async (p) => { await go(p, "#/resume", 3000); await click(p, "档案"); } },
  "06-calendar": { pin: true, run: async (p) => { await go(p, "#/jobs"); await click(p, "日历"); } },
  "08-resume-optimize": { pin: true, run: async (p) => {
    await go(p, "#/resume", 4500);
    await p.getByText(/蓝鲸云 · 后端开发工程师/).first().click();
    await p.waitForTimeout(800);
    await p.getByRole("option", { name: /青禾智能/ }).first().click();
    await click(p, "实习经历");
  } },
  "07-settings": { pin: false, run: async (p) => { await go(p, "#/settings"); await click(p, "模型服务"); } },
  "09-agent-connect": { pin: false, run: async (p) => { await go(p, "#/settings"); await click(p, "我的 Agent"); } },
};

for (const pin of [true, false]) {
  const todo = Object.entries(SHOTS).filter(([name, s]) => s.pin === pin && (!only || only.includes(name)));
  if (!todo.length) continue;
  for (const [name, shot] of todo) {
    const { browser, page } = await session({ pinClock: pin });
    await shot.run(page);
    await page.mouse.move(5, 895);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("captured", name);
    await browser.close();
  }
}
