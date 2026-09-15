// =============================================
// BOSS 登录态冒烟检查（无头、隔离、永不访问 zhipin.com）
// 验证：扩展真的拿到了 cookies 权限、chrome.cookies 可用、
// popup 设置了「连接 BOSS 登录态」入口。只读，不改任何数据。
// =============================================

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { chromium } from "playwright";

const EXTENSION_ROOT = resolve(import.meta.dirname, "..");
const BUILT_EXTENSION_DIR = resolve(EXTENSION_ROOT, ".output", "chrome-mv3");
// WXT 产物只有在整体完整时才可用；否则回落到扩展根目录。
const EXTENSION_DIR =
  existsSync(join(BUILT_EXTENSION_DIR, "manifest.json")) && existsSync(join(BUILT_EXTENSION_DIR, "popup.html"))
    ? BUILT_EXTENSION_DIR
    : EXTENSION_ROOT;

function testTempRoot() {
  const configured = String(process.env.OFFERU_TEST_TEMP_ROOT || "").trim();
  const candidate = configured
    ? resolve(configured)
    : process.platform === "win32" && existsSync("H:\\")
      ? resolve("H:\\tmp\\offeru")
      : resolve(process.env.RUNNER_TEMP || process.env.TMPDIR || ".", "offeru-tests");
  const root = parse(candidate).root.toUpperCase();
  if (process.platform === "win32" && root === "C:\\" && process.env.OFFERU_ALLOW_C_TEST_TEMP !== "1") {
    throw new Error("OfferU smoke check refuses C: temporary storage; set OFFERU_TEST_TEMP_ROOT to a non-system drive");
  }
  mkdirSync(candidate, { recursive: true });
  const browserCache = resolve(candidate, "playwright-browsers");
  mkdirSync(browserCache, { recursive: true });
  // 只在 H 盘缓存确实装了浏览器时才改用它；否则沿用系统已安装的
  // Playwright 浏览器，避免为了冒烟检查临时下载一份。
  if (readdirSync(browserCache).length > 0) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  }
  return candidate;
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

/**
 * Chromium 里同时存在组件扩展的 service worker，`serviceWorkers()[0]`
 * 不一定是 OfferU。按扩展名逐个确认，拿错 worker 会让后面的权限检查
 * 全部得出错误结论。
 */
async function resolveExtensionId(browser) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    for (const worker of browser.serviceWorkers()) {
      try {
        const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
        if (typeof name === "string" && name.includes("OfferU")) {
          return { id: new URL(worker.url()).host, worker };
        }
      } catch {
        // 其它扩展的 worker 不可访问，跳过。
      }
    }
    const next = await Promise.race([
      browser.waitForEvent("serviceworker", { timeout: 1500 }).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (next && browser.serviceWorkers().includes(next)) continue;
  }
  return null;
}

async function main() {
  const tempRoot = testTempRoot();
  const userDataDir = resolve(tempRoot, "boss-smoke-profile");
  mkdirSync(userDataDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      // channel: "chromium" 使用完整 Chromium 的新版无头模式；
      // chrome-headless-shell 不支持 --load-extension，扩展根本不会加载。
      channel: "chromium",
      // Isolated, headless, never attaches to a system browser.
      headless: true,
      ignoreDefaultArgs: true,
      args: [
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--no-service-autorun",
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });

    let worker = browser.serviceWorkers()[0];
    if (!worker) worker = await browser.waitForEvent("serviceworker", { timeout: 20000 });
    const resolved = await resolveExtensionId(browser);
    if (!resolved) {
      check("找到 OfferU 扩展的 service worker", false, "扩展可能未加载");
      throw new Error("未找到已加载的 OfferU 扩展，后续检查无法进行");
    }
    check("找到 OfferU 扩展的 service worker", true, resolved.id);
    worker = resolved.worker;
    const extensionId = resolved.id;

    // 1) 浏览器真实授予的权限，而不是只看 manifest 文本
    const capabilities = await worker.evaluate(async () => ({
      hasCookiesApi: typeof chrome.cookies?.getAll === "function",
      cookiesGranted: await chrome.permissions.contains({ permissions: ["cookies"] }),
      zhipinGranted: await chrome.permissions.contains({ origins: ["https://*.zhipin.com/*"] }),
    }));
    check("chrome.cookies API 可用", capabilities.hasCookiesApi);
    check("cookies 权限已被浏览器授予", capabilities.cookiesGranted);
    check(
      "zhipin 站点权限未静态授予（符合按需申请）",
      capabilities.zhipinGranted === false,
      `granted=${capabilities.zhipinGranted}`,
    );

    // 2) 扩展只应持有自己需要的站点权限，不应顺手拿到 zhipin 之外的招聘站
    const wideOrigins = await worker.evaluate(async () =>
      chrome.permissions.contains({ origins: ["https://*.zhaopin.com/*"] }),
    );
    check("未静态授予其它招聘站权限", wideOrigins === false);

    // 3) popup 结构
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    check("popup 存在「连接 BOSS 登录态」按钮", (await page.locator("#connectBossSessionBtn").count()) === 1);
    check("popup 存在 BOSS 状态显示位", (await page.locator("#bossSessionStatus").count()) === 1);
    const statusText = ((await page.locator("#bossSessionStatus").textContent()) || "").trim();
    check("状态位有初始文案", statusText.length > 0, statusText);

    console.log(`\nextension: ${EXTENSION_DIR}`);
    console.log(`extensionId: ${extensionId}`);
  } finally {
    if (browser) await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 项未通过：${failures.join("、")}`);
    process.exit(1);
  }
  console.log("\n冒烟检查全部通过");
}

await main();
