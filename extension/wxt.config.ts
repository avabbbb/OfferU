import path from "node:path";

import { defineConfig } from "wxt";

export default defineConfig({
  webExt: {
    // Development must never open the system default browser or Edge.
    // Load the built extension manually only when a developer explicitly asks.
    disabled: true,
  },
  hooks: {
    "entrypoints:found": (wxt, entrypoints) => {
      // Root popup.html is synced build output and may contain stale chunk hashes.
      const popupPath = path.resolve(wxt.config.root, "src", "popup.html");
      if (entrypoints.some((entrypoint) => entrypoint.name === "popup")) return;
      entrypoints.push({
        name: "popup",
        inputPath: popupPath,
        type: "popup",
      });
    },
  },
  manifest: {
    name: "OfferU 简历购物车助手",
    description: "在招聘站列表页/详情页手动采集岗位并同步到 OfferU",
    // cookies 仅用于「连接 BOSS 登录态」读取 zhipin.com 的 HttpOnly Cookie
    // （src/background.ts 的 syncBossScraperSession），不读取其他任何站点。
    permissions: ["storage", "activeTab", "tabs", "scripting", "clipboardWrite", "offscreen", "cookies"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    // 招聘站点权限按需申请（见 docs/architecture/browser-extension.md），
    // 仅限常见招聘站点；用户连接对应站点登录态时才逐站申请，不再开放通配所有 http/https。
    optional_host_permissions: [
      "https://*.zhipin.com/*",
      "https://*.liepin.com/*",
      "https://*.51job.com/*",
      "https://*.zhaopin.com/*",
      "https://*.linkedin.com/*",
      "https://*.indeed.com/*",
    ],
    web_accessible_resources: [
      {
        resources: ["popup.html", "assets/*", "chunks/*"],
        matches: ["<all_urls>"],
      },
    ],
    browser_specific_settings: {
      gecko: {
        id: "offeru-extension@offeru.local",
      },
    },
    action: {
      default_title: "OfferU 浏览器助手",
      default_popup: "popup.html",
    },
  },
});
