// Node-only resume pieces: printing with a local Chromium, the school-logo PNGs bundled on disk, the <data>/files store.
// Plus the Node FileStore (<data>/files), the on-disk school-logo source, the Playwright PageRenderer and exportResumePdf.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Hono } from "hono";
import {
  CoreError,
  guessMime,
  isSchoolLogoFile,
  resumeDocHtml,
  resumeFileName,
  safeStem,
  type CoreStore,
  type FileStore,
  type PageRenderer,
} from "@offeru/core";

import type { AppEnv } from "../../app";
import { baseName, needRenderer } from "../resume";

// ---------- files ----------

/** <dir>/<name>, bare names only (Python: store.data_dir("files") / Path(name).name). */
export function nodeFileStore(dir: string): FileStore {
  return {
    async read(name) {
      const safe = baseName(name);
      if (!safe || safe === "." || safe === "..") return null;
      try {
        const bytes = new Uint8Array(await readFile(join(dir, safe)));
        return { bytes, type: guessMime(safe) ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },
    async write(name, bytes) {
      const safe = baseName(name);
      if (!safe || safe === "." || safe === "..") throw new CoreError("文件名不合法");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, safe), bytes);
    },
  };
}

/** Same layout as Python: uploads next to the database, <data>/files. */
export const filesDirFor = (dbFile: string): string => process.env.OFFERU_FILES_DIR || join(dirname(dbFile), "files");

// ---------- school logos ----------

const here = dirname(fileURLToPath(import.meta.url));

/** The ~800 bundled emblems (5.8 MB): backend-ts/assets/school_logos, or OFFERU_SCHOOL_LOGO_DIR (packaged builds). */
export function schoolLogoDir(): string | null {
  const candidates = [process.env.OFFERU_SCHOOL_LOGO_DIR, resolve(here, "../../../assets/school_logos")]
    .filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, "index.json"))) ?? null;
}

/** deps.schoolLogos for the companion: read the PNG from disk; null when it is not there. */
export function nodeSchoolLogos(dir: string | null = schoolLogoDir()): (file: string) => Promise<Uint8Array | null> {
  return async (file) => {
    if (!dir || !isSchoolLogoFile(file)) return null;
    try {
      return new Uint8Array(await readFile(join(dir, file)));
    } catch {
      return null;
    }
  };
}

// ---------- printing ----------

type Browser = { newPage(options?: Record<string, unknown>): Promise<Page>; close(): Promise<void> };
type Page = {
  setContent(html: string, options?: Record<string, unknown>): Promise<void>;
  pdf(options: Record<string, unknown>): Promise<Uint8Array>;
  locator(selector: string): { screenshot(options: Record<string, unknown>): Promise<Uint8Array>; evaluate(fn: string): Promise<unknown> };
};
type Chromium = { launch(options?: Record<string, unknown>): Promise<Browser> };

const NO_BROWSER = "本机没有可用的 Chromium：装 Chrome / Edge，并在 backend-ts 里 npm install playwright-core 后再导出";

function which(name: string): string | null {
  for (const dir of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    const path = join(dir, name);
    if (dir && existsSync(path)) return path;
  }
  return null;
}

/** Use whatever Chromium is on the machine: Chrome, Edge, or one on PATH (Python resume._launch). */
async function launch(): Promise<Browser> {
  let chromium: Chromium;
  try {
    const name = "playwright-core";
    chromium = ((await import(/* @vite-ignore */ name)) as { chromium: Chromium }).chromium;
  } catch {
    throw new CoreError(NO_BROWSER, "unsupported");
  }
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // not installed, try the next one
    }
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const path = which(name);
    if (path) {
      try {
        return await chromium.launch({ executablePath: path });
      } catch {
        // try the next one
      }
    }
  }
  try {
    return await chromium.launch();
  } catch {
    throw new CoreError(NO_BROWSER, "unsupported");
  }
}

async function withPage<T>(viewport: Record<string, unknown> | undefined, html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await launch();
  try {
    const page = await browser.newPage(viewport);
    await page.setContent(html, { waitUntil: "load" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** Playwright (playwright-core, optional dependency) over a locally installed Chromium. */
export function playwrightRenderer(): PageRenderer {
  return {
    pdf: (html) => withPage(undefined, html, (page) => page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })),
    png: (html) => withPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 }, html,
      (page) => page.locator("main.resume").screenshot({ type: "png" })),
    pageCount: (html) => withPage({ viewport: { width: 794, height: 1123 } }, html, async (page) => {
      const height = Number(await page.locator("main.resume").evaluate("el => el.scrollHeight"));
      return Math.round((height / 1123) * 100) / 100;
    }),
  };
}


/**
 * Tool export_resume_pdf (core/tools.py): print a resume doc into <exportsDir>/<name>.pdf and return its path.
 * name：JD 指定的附件文件名（不含 .pdf）；不给就用「姓名-简历标题」。
 */
export async function exportResumePdf(
  deps: { store: CoreStore; files?: FileStore | null; renderer?: PageRenderer | null },
  exportsDir: string,
  id: number,
  name = "",
): Promise<{ path: string }> {
  const doc = await deps.store.get("doc", id);
  if (!doc || doc.kind !== "resume") throw new CoreError(`简历 #${id} 不存在`, "not_found");
  const stem = name ? safeStem(name) : "";
  const fileName = stem ? `${stem}.pdf` : resumeFileName(doc, await deps.store.first("profile"));
  const html = await resumeDocHtml(deps.store, doc, deps.files);
  const bytes = await needRenderer(deps.renderer).pdf(html);
  await mkdir(exportsDir, { recursive: true });
  const path = join(exportsDir, fileName);
  await writeFile(path, bytes);
  return { path };
}

// ---------- routes ----------

/**
 * Nothing Node-only is left to mount: /pdf, /png and the school-logo PNGs now live in routes/resume (runtime-agnostic)
 * and use deps.renderer / deps.schoolLogos, which server.ts fills with playwrightRenderer() / nodeSchoolLogos().
 * Kept so routes/companion/index.ts does not change.
 */
export function registerResumeCompanion(app: Hono<AppEnv>): void {
  void app;
}
