// Node-only resume routes: printing with a local Chromium and the school-logo PNGs bundled on disk.
//   GET  /api/resume/{doc_id}/pdf
//   GET  /api/resume/{doc_id}/png
//   GET  /api/resume/assets/school-logos/{file}
//   POST /api/resume/assets/school-logos/{file}/use
// Plus the Node FileStore (<data>/files), the Playwright PageRenderer and exportResumePdf for the export tool.

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
import { transparentLogo } from "../resume/image";
import { baseName, needFiles } from "../resume";

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

/**
 * The ~800 bundled emblems (6 MB). They still live in the Python tree; when Python is deleted, move the folder to
 * backend-ts/assets/school_logos (first candidate) or point OFFERU_SCHOOL_LOGO_DIR at it.
 */
export function schoolLogoDir(): string | null {
  const candidates = [
    process.env.OFFERU_SCHOOL_LOGO_DIR,
    resolve(here, "../../../assets/school_logos"),
    resolve(here, "../../../../backend/app/assets/school_logos"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, "index.json"))) ?? null;
}

async function schoolLogo(file: string): Promise<Uint8Array> {
  if (!isSchoolLogoFile(file)) throw new CoreError("未知的校徽文件", "not_found");
  const dir = schoolLogoDir();
  try {
    if (dir) return new Uint8Array(await readFile(join(dir, file)));
  } catch {
    // fall through
  }
  throw new CoreError("校徽不存在", "not_found");
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

function needRenderer(renderer: PageRenderer | null | undefined): PageRenderer {
  if (!renderer) throw new CoreError(NO_BROWSER, "unsupported");
  return renderer;
}

const disposition = (fallback: string, name: string): string =>
  `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;

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

export function registerResumeCompanion(app: Hono<AppEnv>): void {
  for (const kind of ["pdf", "png"] as const) {
    app.get(`/api/resume/:doc_id{[0-9]+}/${kind}`, async (c) => {
      const { store, files, renderer } = c.get("deps");
      const doc = await store.get("doc", Number(c.req.param("doc_id")));
      if (!doc) throw new CoreError("简历不存在", "not_found");
      const html = await resumeDocHtml(store, doc, files);
      const printer = needRenderer(renderer);
      const bytes = kind === "pdf" ? await printer.pdf(html) : await printer.png(html);
      const pdfName = resumeFileName(doc, await store.first("profile"));
      const name = kind === "pdf" ? pdfName : pdfName.slice(0, -4) + ".png";
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": kind === "pdf" ? "application/pdf" : "image/png",
        "Content-Disposition": disposition(`resume.${kind}`, name),
      });
    });
  }

  app.get("/api/resume/assets/school-logos/:file", async (c) => {
    const bytes = await schoolLogo(c.req.param("file"));
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
  });

  // 选中的校徽抠成透明底存进 files/，返回文件名；前端写进 doc.style.logo。
  app.post("/api/resume/assets/school-logos/:file/use", async (c) => {
    const file = c.req.param("file");
    const bytes = await schoolLogo(file);
    const files = needFiles(c);
    const name = "logo-" + file;
    await files.write(name, transparentLogo(bytes));
    return c.json({ name });
  });
}
