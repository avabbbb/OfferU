import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { chromium } from "playwright";

const EXTENSION_ROOT = resolve(import.meta.dirname, "..");
const BUILT_EXTENSION_DIR = resolve(EXTENSION_ROOT, ".output", "chrome-mv3");
const EXTENSION_DIR = existsSync(join(BUILT_EXTENSION_DIR, "manifest.json"))
  ? BUILT_EXTENSION_DIR
  : EXTENSION_ROOT;
const FIXTURE_CHROME = String(process.env.OFFERU_FIXTURE_CHROME || "").trim() || undefined;

function testTempRoot() {
  const configured = String(process.env.OFFERU_TEST_TEMP_ROOT || "").trim();
  const candidate = configured
    ? resolve(configured)
    : process.platform === "win32" && existsSync("H:\\")
      ? resolve("H:\\tmp\\offeru")
      : resolve(process.env.RUNNER_TEMP || tmpdir(), "offeru-tests");
  const root = parse(candidate).root.toUpperCase();
  if (process.platform === "win32" && root === "C:\\" && process.env.OFFERU_ALLOW_C_TEST_TEMP !== "1") {
    throw new Error("OfferU browser fixture refuses C: temporary storage; set OFFERU_TEST_TEMP_ROOT to a non-system drive");
  }
  mkdirSync(candidate, { recursive: true });
  const tempDirectory = resolve(candidate, "temp");
  mkdirSync(tempDirectory, { recursive: true });
  for (const name of ["TEMP", "TMP", "TMPDIR"]) {
    process.env[name] = tempDirectory;
  }
  return candidate;
}
const PROFILE = {
  basic: {
    fullName: "张三",
    email: "zhangsan@example.com",
  },
  resumeArchive: {
    education: [
      {
        schoolName: "复旦大学",
        educationLevel: "本科",
        degree: "管理学学士",
        major: "信息管理与信息系统",
        startDate: "2022-09",
        endDate: "2026-06",
      },
      {
        schoolName: "北京大学",
        educationLevel: "硕士",
        degree: "管理学硕士",
        major: "信息管理与信息系统",
        startDate: "2026-09",
        endDate: "2029-06",
      },
    ],
    projects: [
      {
        projectName: "智能推荐系统",
        paperLink: "https://example.com/paper",
      },
    ],
  },
  applicationArchive: {
    identityContact: {
      idNumber: "440305200305180026",
    },
    jobPreference: {
      expectedCities: "广东省深圳市南山区",
    },
  },
  sections: [],
};

function sendJson(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,cache-control,pragma",
  });
  res.end(JSON.stringify(payload));
}

function fixtureHtml(port) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>OfferU SmartFill Fixture</title>
  <style>
    body { font-family: Arial, "Microsoft YaHei", sans-serif; margin: 24px; }
    form { max-width: 880px; display: grid; gap: 18px; }
    section { border: 1px solid #d1d5db; padding: 16px; }
    .record-item { border-top: 1px solid #e5e7eb; padding-top: 12px; margin-top: 12px; display: grid; gap: 10px; }
    .ant-form-item { display: grid; grid-template-columns: 140px 1fr; align-items: center; gap: 12px; min-height: 36px; }
    .ant-select, .ant-picker, .ant-cascader-picker { border: 1px solid #9ca3af; min-height: 32px; padding: 4px 8px; display: flex; align-items: center; background: #fff; }
    .ant-select input, .ant-picker input, .ant-cascader-picker input, input { width: 100%; min-height: 26px; border: 0; outline: none; font: inherit; }
    input.native { border: 1px solid #9ca3af; padding: 4px 8px; }
    .panel { position: absolute; z-index: 9999; background: #fff; border: 1px solid #6b7280; box-shadow: 0 4px 18px rgba(0,0,0,.15); padding: 6px; }
    .ant-select-item-option, .ant-cascader-menu-item, .ant-cascader-menu-item-content { padding: 6px 10px; cursor: pointer; min-width: 120px; }
    .ant-picker-panel button { margin: 3px; }
    .ant-cascader-dropdown { display: flex; gap: 8px; }
    .ant-cascader-menu { min-width: 120px; border-right: 1px solid #e5e7eb; padding: 4px; }
  </style>
</head>
<body>
  <h1>网申测试页</h1>
  <form>
    <section class="section education-section">
      <h2 class="section-title">教育经历</h2>
      <div class="record-item" data-index="1">
        <div class="ant-form-item">
          <div class="ant-form-item-label"><label>学校名称</label></div>
          <div class="ant-select" role="combobox" data-field="school-1"><input class="ant-select-selection-search-input" readonly placeholder="请选择学校" /></div>
        </div>
        <div class="ant-form-item">
          <div class="ant-form-item-label"><label>开始时间</label></div>
          <div class="ant-picker" data-field="start-1"><input readonly placeholder="请选择开始时间" /></div>
        </div>
      </div>
      <div class="record-item" data-index="2">
        <div class="ant-form-item">
          <div class="ant-form-item-label"><label>学校名称</label></div>
          <div class="ant-select" role="combobox" data-field="school-2"><input class="ant-select-selection-search-input" readonly placeholder="请选择学校" /></div>
        </div>
        <div class="ant-form-item">
          <div class="ant-form-item-label"><label>开始时间</label></div>
          <div class="ant-picker" data-field="start-2"><input readonly placeholder="请选择开始时间" /></div>
        </div>
      </div>
    </section>
    <section class="section preference-section">
      <h2 class="section-title">求职意向</h2>
      <div class="ant-form-item">
        <div class="ant-form-item-label"><label>期望城市</label></div>
        <div class="ant-cascader-picker" data-field="city"><input readonly placeholder="请选择期望城市" /></div>
      </div>
    </section>
    <section class="section basic-section">
      <h2 class="section-title">基本信息</h2>
      <div class="ant-form-item">
        <label for="full-name">姓名</label>
        <input class="native" id="full-name" name="fullName" />
      </div>
      <div class="ant-form-item">
        <label for="id-number">身份证号</label>
        <input class="native" id="id-number" name="idNumber" />
      </div>
    </section>
  </form>
  <script>
    window.__SMARTFILL_FIXTURE_PORT__ = ${port};
    const schools = ["复旦大学", "北京大学", "上海交通大学"];
    function showSelect(host) {
      document.querySelectorAll(".ant-select-dropdown").forEach((node) => node.remove());
      const panel = document.createElement("div");
      panel.className = "panel ant-select-dropdown";
      const input = document.createElement("input");
      input.className = "ant-select-selection-search-input";
      input.setAttribute("role", "searchbox");
      panel.appendChild(input);
      for (const school of schools) {
        const option = document.createElement("div");
        option.className = "ant-select-item-option";
        option.setAttribute("role", "option");
        option.textContent = school;
        option.addEventListener("click", () => {
          host.dataset.value = school;
          const display = host.querySelector("input");
          display.value = school;
          display.setAttribute("value", school);
          display.dispatchEvent(new Event("input", { bubbles: true }));
          display.dispatchEvent(new Event("change", { bubbles: true }));
          panel.remove();
        });
        panel.appendChild(option);
      }
      document.body.appendChild(panel);
    }
    function showDate(host) {
      document.querySelectorAll(".ant-picker-dropdown").forEach((node) => node.remove());
      const panel = document.createElement("div");
      panel.className = "panel ant-picker-dropdown";
      const inner = document.createElement("div");
      inner.className = "ant-picker-panel";
      for (const value of ["2022-09", "2026-09", "2029-06"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = value;
        button.addEventListener("click", () => {
          host.dataset.value = value;
          const input = host.querySelector("input");
          input.value = value;
          input.setAttribute("value", value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          panel.remove();
        });
        inner.appendChild(button);
      }
      panel.appendChild(inner);
      document.body.appendChild(panel);
    }
    function showCascader(host) {
      document.querySelectorAll(".ant-cascader-dropdown").forEach((node) => node.remove());
      const panel = document.createElement("div");
      panel.className = "panel ant-cascader-dropdown";
      const levels = [
        ["广东省"],
        ["深圳市"],
        ["南山区"],
      ];
      const selected = [];
      levels.forEach((items, level) => {
        const menu = document.createElement("div");
        menu.className = "ant-cascader-menu";
        items.forEach((item) => {
          const option = document.createElement("div");
          option.className = "ant-cascader-menu-item";
          option.textContent = item;
          option.addEventListener("mouseenter", () => {});
          option.addEventListener("click", () => {
            selected[level] = item;
            if (level === levels.length - 1) {
              host.dataset.value = selected.join("/");
              const input = host.querySelector("input");
              input.value = selected.join("/");
              input.setAttribute("value", input.value);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            }
          });
          menu.appendChild(option);
        });
        panel.appendChild(menu);
      });
      const ok = document.createElement("button");
      ok.className = "ant-btn ant-btn-primary";
      ok.type = "button";
      ok.textContent = "确定";
      ok.addEventListener("click", () => panel.remove());
      panel.appendChild(ok);
      document.body.appendChild(panel);
    }
    document.addEventListener("click", (event) => {
      const select = event.target.closest(".ant-select");
      if (select) showSelect(select);
      const picker = event.target.closest(".ant-picker");
      if (picker) showDate(picker);
      const cascader = event.target.closest(".ant-cascader-picker");
      if (cascader) showCascader(cascader);
    });
  </script>
</body>
</html>`;
}

// 扩展把本机后端地址归一化到 8766，所以夹具必须占用 8766；跑之前确认没有真实后端。
// 需要完整 Chromium（channel: chromium），headless shell 不加载扩展。
async function startServer() {
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, {});
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/fixture") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml(server.address().port));
      return;
    }
    if (url.pathname === "/api/profile/") {
      sendJson(res, PROFILE);
      return;
    }
    if (url.pathname === "/api/profile/smart-fill/catalog") {
      sendJson(res, { profileVersion: "test", catalog: [], count: 0, signature: "fixture" });
      return;
    }
    if (url.pathname === "/api/profile/smart-fill/cache/get") {
      sendJson(res, { hit: false, mappings: [] });
      return;
    }
    if (url.pathname === "/api/profile/smart-fill/cache/set" || url.pathname === "/api/profile/smart-fill/runs/log") {
      sendJson(res, { ok: true });
      return;
    }
    if (url.pathname === "/api/profile/smart-fill/map") {
      sendJson(res, { mappings: [], runId: "fixture-run" });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(8766, "127.0.0.1");
  });
  return server;
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const userDataDir = mkdtempSync(join(testTempRoot(), "smartfill-"));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      // Keep fixture runs isolated and never attach to a system browser.
      headless: process.env.OFFERU_FIXTURE_HEADLESS !== "0",
      executablePath: FIXTURE_CHROME,
      channel: FIXTURE_CHROME ? undefined : "chromium",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-popup-blocking",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--no-service-autorun",
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/fixture`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#offeru-ext-floating-dock", { state: "attached", timeout: 15000 });

    let worker = browser.serviceWorkers()[0];
    if (!worker) {
      worker = await browser.waitForEvent("serviceworker", { timeout: 15000 });
    }
    await worker.evaluate(async (serverUrl) => {
      await chrome.storage.local.set({
        settings: { serverUrl },
        smartFillSettingsV1: {
          enabled: false,
          provider: "openai-compatible",
          baseUrl: "",
          apiKey: "",
          model: "",
          enableFallback: true,
        },
      });
    }, `http://127.0.0.1:${port}`);

    await page.evaluate(() => {
      const dock = document.querySelector("#offeru-ext-floating-dock");
      const root = dock?.shadowRoot;
      root?.querySelector('[data-action="toggle-panel"]')?.click();
    });
    await page.waitForFunction(() => {
      const root = document.querySelector("#offeru-ext-floating-dock")?.shadowRoot;
      return Boolean(root?.querySelector('[data-action="smart-fill"]'));
    });
    await page.evaluate(() => {
      const root = document.querySelector("#offeru-ext-floating-dock")?.shadowRoot;
      root?.querySelector('[data-action="smart-fill"]')?.click();
    });

    await page.waitForSelector("#offeru-ext-field-overlay", { state: "attached", timeout: 15000 });
    const overlayChips = await page.evaluate(() => {
      const root = document.getElementById("offeru-ext-field-overlay")?.shadowRoot;
      return root ? root.querySelectorAll(".offeru-chip").length : 0;
    });
    if (overlayChips === 0) {
      throw new Error("field overlay rendered no chips");
    }
    await page.evaluate(() => {
      const root = document.getElementById("offeru-ext-field-overlay")?.shadowRoot;
      root?.querySelector('[data-action="fill-all"]')?.click();
    });

    await page.waitForFunction(() => {
      const school1 = document.querySelector('[data-field="school-1"]')?.dataset.value || "";
      const school2 = document.querySelector('[data-field="school-2"]')?.dataset.value || "";
      const filled = document.getElementById("offeru-ext-field-overlay")?.shadowRoot?.querySelectorAll(".offeru-chip.is-filled").length || 0;
      const fullName = document.querySelector("#full-name")?.value || "";
      return fullName === "张三" && school1 === "复旦大学" && school2 === "北京大学" && filled === 3;
    }, { timeout: 30000 });

    const snapshot = await page.evaluate(() => ({
      school1: document.querySelector('[data-field="school-1"]')?.dataset.value || "",
      school2: document.querySelector('[data-field="school-2"]')?.dataset.value || "",
      fullName: document.querySelector("#full-name")?.value || "",
      filledChips: document.getElementById("offeru-ext-field-overlay")?.shadowRoot?.querySelectorAll(".offeru-chip.is-filled").length || 0,
    }));

    await page.evaluate(() => {
      const root = document.getElementById("offeru-ext-field-overlay")?.shadowRoot;
      root?.querySelector('[data-action="undo-all"]')?.click();
    });
    await page.waitForFunction(() => {
      const fullName = document.querySelector("#full-name")?.value || "";
      return fullName === "";
    }, { timeout: 10000 });
    const undone = await page.evaluate(() => ({
      school1: document.querySelector('[data-field="school-1"]')?.dataset.value || "",
      school2: document.querySelector('[data-field="school-2"]')?.dataset.value || "",
      fullName: document.querySelector("#full-name")?.value || "",
      filledChips: document.getElementById("offeru-ext-field-overlay")?.shadowRoot?.querySelectorAll(".offeru-chip.is-filled").length || 0,
    }));
    console.log("smartfill browser fixture passed", JSON.stringify({ filled: snapshot, undone }));
  } finally {
    if (browser) await browser.close();
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
