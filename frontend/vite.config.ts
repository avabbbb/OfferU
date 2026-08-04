import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const REACTION_CATALOG_ID = "virtual:offeru-interview-reactions";
const RESOLVED_REACTION_CATALOG_ID = `\0${REACTION_CATALOG_ID}`;
const REACTION_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const tauriHost = process.env.TAURI_DEV_HOST;

  return {
    base: "./",
    plugins: [reactionCatalogPlugin(__dirname), react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "next/link": path.resolve(__dirname, "src/compat/next-link.tsx"),
        "next/navigation": path.resolve(__dirname, "src/compat/next-navigation.ts"),
        "next/dynamic": path.resolve(__dirname, "src/compat/next-dynamic.tsx"),
      },
    },
    define: {
      "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(
        env.VITE_API_URL || env.NEXT_PUBLIC_API_URL || "",
      ),
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    server: {
      host: tauriHost || "127.0.0.1",
      port: 3300,
      strictPort: true,
      hmr: tauriHost
        ? {
            protocol: "ws",
            host: tauriHost,
            port: 3301,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    },
  };
});
