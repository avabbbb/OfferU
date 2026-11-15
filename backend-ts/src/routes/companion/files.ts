// read_file / find_files: the user's local files (Python app/core/tools.py read_file, find_files).
// Node companion only. The browser / Worker never get these handlers, so the shared
// registry answers CoreError("unsupported") there (see @offeru/core callCoreTool).

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

import { CoreError, type ToolHandler } from "@offeru/core";

export type LocalFileText = { path: string; text: string; truncated: boolean };

export const DOC_SUFFIXES = [".pdf", ".docx", ".txt", ".md", ".markdown"];
const MAX_TEXT = 30_000;
const WALK_DEPTH = 3;
const GREP_MAX_FILES = 300;

/** s[:n] in code points. */
const cut = (text: string, n: number) => (text.length <= n ? text : Array.from(text).slice(0, n).join(""));

const expandUser = (path: string) => (path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(1)) : path);

// ---------- read_file ----------

/** Minimal ZIP reader (central directory + stored/deflate entries) for .docx; no dependency. */
function zipEntry(buffer: Buffer, name: string): Buffer | null {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && at + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const entryName = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (entryName === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const unescapeXml = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
  if (code[0] === "#") return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return XML_ENTITIES[code] ?? whole;
});

function paragraphText(xml: string): string {
  // <w:t> runs, <w:tab/> and <w:br/> inside one paragraph.
  let out = "";
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
    out += match[1] !== undefined ? unescapeXml(match[1]) : match[2] === "tab" ? "\t" : "\n";
  }
  return out;
}

/** python-docx: body paragraphs (tables excluded), then every table row as "cell | cell". */
export function docxText(buffer: Buffer): string {
  const xml = zipEntry(buffer, "word/document.xml")?.toString("utf8");
  if (xml === undefined) throw new CoreError("这个 Word 文件打不开（不是 .docx 或已损坏）");
  const body = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, "");
  const paragraphs = [...body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((m) => paragraphText(m[1] ?? ""));
  let text = paragraphs.join("\n");
  for (const table of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    for (const row of table[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) =>
        [...cell[0].matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((p) => paragraphText(p[1] ?? "")).join("\n"));
      text += "\n" + cells.join(" | ");
    }
  }
  return text;
}

/** PDF text via poppler's pdftotext (Python used PyMuPDF; no pure-JS PDF parser is bundled yet). */
function pdfText(file: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(process.env.OFFERU_PDFTOTEXT || "pdftotext", ["-enc", "UTF-8", "-layout", file, "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        fail(new CoreError(missing
          ? "读 PDF 需要本机装 poppler（pdftotext）；也可以把简历文字直接贴进来"
          : `PDF 读取失败：${error.message}`, missing ? "unsupported" : "invalid"));
        return;
      }
      done(stdout.replace(/\f/g, "\n"));
    });
  });
}

export function createLocalFiles(filesDir: string) {
  async function readFile(path: string): Promise<LocalFileText> {
    let file = expandUser(path);
    if (!isAbsolute(file)) file = join(filesDir, basename(path));
    let stat: Stats | null = null;
    try {
      stat = statSync(file);
    } catch { /* missing */ }
    if (!stat?.isFile()) throw new CoreError(`找不到文件 ${path}`);
    const suffix = extname(file).toLowerCase();
    let text: string;
    if (suffix === ".pdf") text = await pdfText(file);
    else if (suffix === ".docx") text = docxText(readFileSync(file));
    else if ([".txt", ".md", ".markdown"].includes(suffix)) text = readFileSync(file, "utf8");
    else throw new CoreError("只支持 PDF、Word（.docx）、txt 和 md");
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return { path: file, text: cut(text, MAX_TEXT), truncated: Array.from(text).length > MAX_TEXT };
  }

  async function findFiles(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dir = String(args.dir);
    const folder = expandUser(dir);
    if (!isAbsolute(folder)) throw new CoreError("dir 要是本机目录的绝对路径，比如 H:\\学习\\留档");
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch { /* missing */ }
    if (!isDir) throw new CoreError(`找不到目录 ${dir}`);
    const query = typeof args.query === "string" ? args.query : "";
    const terms = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    const recursive = typeof args.recursive === "boolean" ? args.recursive : terms.length > 0;
    const docsOnly = args.docs_only === undefined ? true : Boolean(args.docs_only);
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const pattern = fnmatchRegex(String(args.pattern ?? "*").toLowerCase() || "*");

    const items: Array<Record<string, unknown>> = [];
    let scanned = 0;
    for (const file of walk(resolve(folder), pattern, recursive ? WALK_DEPTH : 0, docsOnly || terms.length > 0)) {
      let stat: Stats;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const item: Record<string, unknown> = { path: file, name: basename(file), size: stat.size, modified: localMinutes(stat.mtime) };
      if (terms.length) {
        if (scanned >= GREP_MAX_FILES) break;
        scanned += 1;
        let text: string;
        try {
          text = (await readFile(file)).text;
        } catch {
          continue;
        }
        if (!terms.every((t) => `${basename(file)} ${text}`.toLowerCase().includes(t))) continue;
        const at = Math.max(0, text.toLowerCase().indexOf(terms[0]));
        item.snippet = text.slice(Math.max(0, at - 60), at + 120);
      }
      items.push(item);
    }
    items.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    let subdirs: string[] = [];
    try {
      subdirs = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    } catch { /* unreadable */ }
    const out: Record<string, unknown> = {
      dir: folder, total: items.length, items: items.slice(0, limit),
      truncated: items.length > limit || scanned >= GREP_MAX_FILES, dirs: subdirs.slice(0, 50),
    };
    if (terms.length) out.scanned = scanned;
    return out;
  }

  const handlers: Record<string, ToolHandler> = {
    read_file: (args) => readFile(String(args.path)),
    find_files: (args) => findFiles(args),
  };
  return { readFile, findFiles, handlers };
}

/** Like os.walk top-down: hidden dirs skipped, unreadable dirs ignored, at most maxDepth levels below root. */
function* walk(root: string, pattern: RegExp, maxDepth: number, docsOnly: boolean): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const depth = relative(root, dir).split(sep).filter(Boolean).length;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith(".")) stack.push(join(dir, entry.name));
        continue;
      }
      const name = entry.name.toLowerCase();
      if (!pattern.test(name)) continue;
      if (docsOnly && !DOC_SUFFIXES.includes(extname(name))) continue;
      yield join(dir, entry.name);
    }
  }
}

/** fnmatch.translate: * ? [seq] [!seq]. */
export function fnmatchRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        let body = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        else if (body.startsWith("^")) body = "\\" + body;
        out += `[${body}]`;
        i = end;
      }
    } else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** datetime.fromtimestamp(t).isoformat(timespec="minutes"), local time. */
function localMinutes(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
