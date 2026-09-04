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
      const popupPath = path.resolve(wxt.config.root, "popup.html");
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
    permissions: ["storage", "activeTab", "tabs", "scripting", "clipboardWrite", "offscreen"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
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
