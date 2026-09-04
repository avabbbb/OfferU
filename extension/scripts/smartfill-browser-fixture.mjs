import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const EXTENSION_ROOT = resolve(import.meta.dirname, "..");
const BUILT_EXTENSION_DIR = resolve(EXTENSION_ROOT, ".output", "chrome-mv3");
const EXTENSION_DIR = existsSync(join(BUILT_EXTENSION_DIR, "manifest.json"))
  ? BUILT_EXTENSION_DIR
  : EXTENSION_ROOT;
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
    if (url.pathname === "/api/jobs/ingest") {
      sendJson(res, { created: 0, skipped: 0, accepted_hash_keys: [] });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const userDataDir = mkdtempSync(join(tmpdir(), "offeru-smartfill-"));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      // Keep fixture runs isolated and never attach to a system browser.
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
    await page.waitForSelector("#offeru-ext-floating-dock", { timeout: 15000 });

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

    await page.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll("[data-field]")).map((el) => el.dataset.value || "");
      const idNumber = document.querySelector("#id-number")?.value || "";
      return values.includes("复旦大学")
        && values.includes("北京大学")
        && values.includes("2022-09")
        && values.includes("2026-09")
        && values.some((value) => value.includes("广东省") && value.includes("深圳市") && value.includes("南山区"))
        && idNumber === "440305200305180026";
    }, { timeout: 30000 });

    const snapshot = await page.evaluate(() => ({
      school1: document.querySelector('[data-field="school-1"]')?.dataset.value || "",
      school2: document.querySelector('[data-field="school-2"]')?.dataset.value || "",
      start1: document.querySelector('[data-field="start-1"]')?.dataset.value || "",
      start2: document.querySelector('[data-field="start-2"]')?.dataset.value || "",
      city: document.querySelector('[data-field="city"]')?.dataset.value || "",
      idNumber: document.querySelector("#id-number")?.value || "",
    }));

    const expected = {
      school1: "复旦大学",
      school2: "北京大学",
      start1: "2022-09",
      start2: "2026-09",
      city: "广东省/深圳市/南山区",
      idNumber: "440305200305180026",
    };
    for (const [key, value] of Object.entries(expected)) {
      if (snapshot[key] !== value) {
        throw new Error(`${key} expected ${value}, got ${snapshot[key]}`);
      }
    }
    console.log("smartfill browser fixture passed", JSON.stringify(snapshot));
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
