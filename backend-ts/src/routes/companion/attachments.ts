import { execFile } from "node:child_process";
import { dirname, join } from "node:path";

import { CoreError, MAX_PDF_PAGES } from "@offeru/core";

import { nodeFileStore } from "./resume";

/** <data>/agent_attachments, next to offeru.db (Python store.data_dir("agent_attachments")). */
export const attachmentsDirFor = (dbFile: string): string => join(dirname(dbFile), "agent_attachments");
export const nodeAttachmentFiles = (dbFile: string) => nodeFileStore(attachmentsDirFor(dbFile));

function run(command: string, args: string[], input: Uint8Array): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, stdout, stderr });
    });
    child.stdin?.end(Buffer.from(input));
  });
}

/**
 * Companion PDF reader for attachments (Python used PyMuPDF): poppler's
 * pdfinfo / pdftotext when they are on PATH, same limits and messages as
 * agent_attachments._pdf_text. Without poppler a PDF upload is "unsupported".
 */
export function popplerPdfText(bin = { info: "pdfinfo", text: "pdftotext" }): (bytes: Uint8Array) => Promise<string> {
  return async (bytes) => {
    let info;
    try {
      info = await run(bin.info, ["-"], bytes);
    } catch {
      throw new CoreError("本机没有 PDF 读取工具（poppler 的 pdftotext），先安装它，或把 PDF 内容复制进对话", "unsupported");
    }
    if (/Incorrect password|encrypted/i.test(info.stderr)) throw new CoreError("这个 PDF 有密码保护，请先取消密码再上传");
    if (info.code !== 0) throw new CoreError("这个 PDF 无法打开，可能已损坏");
    const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
    if (pages > MAX_PDF_PAGES) throw new CoreError(`PDF 最多支持 ${MAX_PDF_PAGES} 页，这个文件有 ${pages} 页`);
    const text = await run(bin.text, ["-enc", "UTF-8", "-", "-"], bytes);
    if (text.code !== 0) throw new CoreError("这个 PDF 的文字读取失败");
    return text.stdout.replace(/\f/g, "\n").trim();
  };
}
