// Files the user attaches in the Agent composer — port of
// backend/app/services/agent_attachments.py. Images reach the model as vision
// input; PDF and PPTX are read to text once, at upload, and joined into the
// user's message when it is sent. Every file is stored under a random id so a
// client filename never becomes part of a path.
//
// Runtime split: storage is an injected FileStore (companion: <data>/agent_attachments,
// web: the browser's file store). PPTX is read here on every runtime (zip +
// XML, no native code). PDF text needs a parser the runtime injects
// (`pdfText`; the Node companion uses poppler's pdftotext); without one a PDF
// upload is CoreError("unsupported") → 501.

import type { PreparedAttachments } from "../agent/host";
import type { FileStore } from "../resume/render";
import { CoreError } from "../types";
import { pptxText, PptxError } from "./pptx";

export { pptxText, PptxError, MAX_SLIDES, MAX_PPTX_UNCOMPRESSED_BYTES } from "./pptx";
export { zipEntries, zipRead } from "./zip";

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export const DOCUMENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_DOCUMENT_BYTES);
export const MAX_ATTACHMENTS = 8;
export const MAX_PDF_PAGES = 60;
export const MAX_DOCUMENT_CHARS = 30_000;
export const MAX_TOTAL_DOCUMENT_CHARS = 60_000;
export const IMAGE_REF_PREFIX = "offeru-attachment://";

const ID_RE = /^[0-9a-f]{32}\.(png|jpg|jpeg|webp|gif|pdf|pptx)$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const TRUNCATED = "\n…（内容过长，已截断）";

export type AttachmentKind = "image" | "document";
export interface StoredAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime_type: string;
  size: number;
}

export interface AttachmentDeps {
  files: FileStore;
  /** PDF → text (companion). Throws CoreError with a user-facing reason. Absent = PDFs unsupported here. */
  pdfText?: (bytes: Uint8Array) => Promise<string>;
}

/** Path(filename).name without control chars, ≤120 chars (Python _display_name). */
export function displayName(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(CONTROL_RE, "").trim();
  return [...(name || "未命名文件")].slice(0, 120).join("");
}

/** Path(name).suffix.lower(). */
export function suffixOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "";
}

const startsWith = (bytes: Uint8Array, sig: number[] | string, at = 0): boolean => {
  const codes = typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig;
  return codes.every((code, i) => bytes[at + i] === code);
};

export function matchesSignature(suffix: string, bytes: Uint8Array): boolean {
  if (suffix === ".png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (suffix === ".jpg" || suffix === ".jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (suffix === ".gif") return startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a");
  if (suffix === ".webp") return startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8);
  if (suffix === ".pdf") {
    let at = 0;
    const head = Math.min(bytes.length, 1024);
    while (at < head && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(bytes[at])) at += 1;
    return at < head && startsWith(bytes.subarray(0, head), "%PDF-", at);
  }
  if (suffix === ".pptx") return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  return false;
}

const randomHex = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Validate an upload; returns its kind and mime type or throws the user-facing reason. */
export function classifyAttachment(filename: string, bytes: Uint8Array): { name: string; suffix: string; kind: AttachmentKind; mime_type: string } {
  const name = displayName(filename);
  const suffix = suffixOf(name);
  let kind: AttachmentKind;
  let mime: string;
  let limit: number;
  if (suffix in IMAGE_TYPES) {
    [kind, mime, limit] = ["image", IMAGE_TYPES[suffix], MAX_IMAGE_BYTES];
  } else if (suffix in DOCUMENT_TYPES) {
    [kind, mime, limit] = ["document", DOCUMENT_TYPES[suffix], MAX_DOCUMENT_BYTES];
  } else {
    throw new CoreError("只支持图片（PNG/JPG/WebP/GIF）、PDF 和 PPTX");
  }
  if (!bytes.length) throw new CoreError("文件是空的");
  if (bytes.length > limit) throw new CoreError(`${kind === "image" ? "图片" : "文档"}不能超过 ${Math.floor(limit / (1024 * 1024))} MB`);
  if (!matchesSignature(suffix, bytes)) throw new CoreError("文件内容和扩展名不一致");
  return { name, suffix, kind, mime_type: mime };
}

export async function saveAttachment(deps: AttachmentDeps, filename: string, bytes: Uint8Array): Promise<StoredAttachment> {
  const { name, suffix, kind, mime_type } = classifyAttachment(filename, bytes);
  let text = "";
  if (suffix === ".pdf") {
    if (!deps.pdfText) throw new CoreError("PDF 附件需要在本机 OfferU 里读取；网页版可以先复制文字或上传 PPTX / 图片", "unsupported");
    text = await deps.pdfText(bytes);
  } else if (suffix === ".pptx") {
    try {
      text = await pptxText(bytes);
    } catch (error) {
      if (error instanceof PptxError) throw new CoreError(error.message);
      throw error;
    }
  }
  const attachment: StoredAttachment = { id: `${randomHex()}${suffix}`, name, kind, mime_type, size: bytes.length };
  await deps.files.write(attachment.id, bytes);
  if (kind === "document") await deps.files.write(`${attachment.id}.txt`, encoder.encode(text));
  await deps.files.write(`${attachment.id}.json`, encoder.encode(JSON.stringify(attachment)));
  return attachment;
}

export async function loadAttachment(deps: AttachmentDeps, id: string): Promise<{ attachment: StoredAttachment; bytes: Uint8Array }> {
  if (!ID_RE.test(id || "")) throw new CoreError("附件编号无效");
  const data = await deps.files.read(id);
  const meta = await deps.files.read(`${id}.json`);
  if (!data || !meta) throw new CoreError("附件不存在或已被清理，请重新添加", "not_found");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(meta.bytes));
  } catch {
    throw new CoreError("附件信息已损坏，请重新添加");
  }
  const kind = String(raw?.kind ?? "");
  const mime = String(raw?.mime_type ?? "");
  if ((kind !== "image" && kind !== "document") || ![...Object.values(IMAGE_TYPES), ...Object.values(DOCUMENT_TYPES)].includes(mime)) {
    throw new CoreError("附件信息已损坏，请重新添加");
  }
  return {
    attachment: {
      id,
      name: displayName(String(raw.name ?? "")),
      kind,
      mime_type: mime,
      size: Number.isInteger(raw.size) ? raw.size as number : data.bytes.length,
    },
    bytes: data.bytes,
  };
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : text.slice(0, Math.max(0, limit)) + TRUNCATED);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Python prepare_message: the model reads the user's words plus every
 * document's text (each ≤30k chars, ≤60k total); history keeps only the typed
 * words; images go out as data: URLs.
 */
export async function prepareAttachmentMessage(deps: AttachmentDeps, message: string, ids: string[]): Promise<PreparedAttachments> {
  if (ids.length > MAX_ATTACHMENTS) throw new CoreError(`一次最多发送 ${MAX_ATTACHMENTS} 个附件`);
  const seen = new Set<string>();
  const saved: PreparedAttachments["attachments"] = [];
  const images: string[] = [];
  const sections: string[] = [];
  let budget = MAX_TOTAL_DOCUMENT_CHARS;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const { attachment, bytes } = await loadAttachment(deps, id);
    saved.push({ id: attachment.id, name: attachment.name, kind: attachment.kind });
    if (attachment.kind === "image") {
      images.push(`data:${attachment.mime_type};base64,${base64(bytes)}`);
      continue;
    }
    const textFile = await deps.files.read(`${attachment.id}.txt`);
    const text = textFile ? decoder.decode(textFile.bytes).trim() : "";
    let body: string;
    if (!text) {
      body = "（没能从这个文件读出文字，可能是纯图片或扫描件）";
    } else {
      body = clip(text, Math.min(MAX_DOCUMENT_CHARS, budget));
      budget = Math.max(0, budget - Math.min(text.length, MAX_DOCUMENT_CHARS));
    }
    sections.push(`<attachment name="${attachment.name}">\n${body}\n</attachment>`);
  }
  const base = message.trim();
  let modelMessage = base;
  if (sections.length) modelMessage = [base, "以下是用户随消息附上的文件内容：", ...sections].join("\n\n");
  if (images.length) modelMessage += `\n\n（用户附上了 ${images.length} 张图片）`;
  return { modelMessage, historyMessage: base, attachments: saved, images };
}
