import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const REACTION_CATALOG_ID = "virtual:offeru-interview-reactions";
const RESOLVED_REACTION_CATALOG_ID = `\0${REACTION_CATALOG_ID}`;
const REACTION_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as { version?: string };
const APP_VERSION = packageManifest.version || "0.0.0";

function readReactionCatalog(root: string) {
  const assetRoot = path.join(root, "public", "interview-reactions");
  if (!fs.existsSync(assetRoot)) return {};
  return Object.fromEntries(
    fs
      .readdirSync(assetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const assets = fs
          .readdirSync(path.join(assetRoot, entry.name), { withFileTypes: true })
          .filter(
            (item) =>
              item.isFile() && REACTION_EXTENSIONS.has(path.extname(item.name).toLowerCase()),
          )
          .map(
            (item) =>
              `/interview-reactions/${encodeURIComponent(entry.name)}/${encodeURIComponent(item.name)}`,
          );
        return [entry.name, assets];
      })
      .filter(([, assets]) => assets.length > 0),
  );
}

function reactionCatalogPlugin(root: string) {
  return {
    name: "offeru-interview-reaction-catalog",
    resolveId(id: string) {
      return id === REACTION_CATALOG_ID ? RESOLVED_REACTION_CATALOG_ID : null;
    },
    load(id: string) {
      if (id !== RESOLVED_REACTION_CATALOG_ID) return null;
      return `export default ${JSON.stringify(readReactionCatalog(root))};`;
    },
  };
}

// 校徽 PNG（约 800 个、5.8 MB）放在 backend-ts/assets/school_logos。网页版把它们当静态文件放在 school-logos/ 下，
// 用户挑中学校时才按文件名单个去取（core 的 staticSchoolLogos），不进 JS 主包；桌面版（Tauri）由本机伴侣提供，不拷。
const SCHOOL_LOGO_DIR = path.resolve(__dirname, "../backend-ts/assets/school_logos");
const SCHOOL_LOGO_FILE = /^\d{4}\.png$/;

function schoolLogoAssetsPlugin() {
  return {
    name: "offeru-school-logo-assets",
    configureServer(server: { middlewares: { use: (path: string, fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use("/school-logos", (req, res, next) => {
        const file = (req.url || "").replace(/^\/+/, "").split("?")[0];
        if (!SCHOOL_LOGO_FILE.test(file) || !fs.existsSync(path.join(SCHOOL_LOGO_DIR, file))) return next();
        res.setHeader("Content-Type", "image/png");
        res.end(fs.readFileSync(path.join(SCHOOL_LOGO_DIR, file)));
      });
    },
    generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: Uint8Array }) => void }) {
      if (process.env.TAURI_ENV_PLATFORM || !fs.existsSync(SCHOOL_LOGO_DIR)) return;
      for (const file of fs.readdirSync(SCHOOL_LOGO_DIR)) {
        if (SCHOOL_LOGO_FILE.test(file)) {
          this.emitFile({ type: "asset", fileName: `school-logos/${file}`, source: fs.readFileSync(path.join(SCHOOL_LOGO_DIR, file)) });
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const tauriHost = process.env.TAURI_DEV_HOST;

  return {
    base: "./",
    plugins: [reactionCatalogPlugin(__dirname), schoolLogoAssetsPlugin(), react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "next/link": path.resolve(__dirname, "src/compat/next-link.tsx"),
        "next/navigation": path.resolve(__dirname, "src/compat/next-navigation.ts"),
        "next/dynamic": path.resolve(__dirname, "src/compat/next-dynamic.tsx"),
      },
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(APP_VERSION),
      "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(
        env.VITE_API_URL || env.NEXT_PUBLIC_API_URL || "",
      ),
      "process.env.VITE_SHOWCASE": JSON.stringify(
        process.env.VITE_SHOWCASE || env.VITE_SHOWCASE || "",
      ),
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    server: {
      host: tauriHost || "127.0.0.1",
      port: 7410,
      strictPort: true,
      open: false,
      hmr: tauriHost
        ? {
            protocol: "ws",
            host: tauriHost,
            port: 7411,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome111" : "safari16.4",
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      css: false,
    },
  };
});
