// Files attached in the Agent composer: images go to a vision model, PDF and
// PPTX are read to text by the backend. These checks mirror the backend's so
// the user hears about a wrong file before it uploads; the backend still decides.

export type AgentAttachmentKind = "image" | "document";

export interface AgentAttachment {
  id: string;
  name: string;
  kind: AgentAttachmentKind;
  mime_type: string;
  size: number;
}

export const AGENT_ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.pptx";
export const MAX_AGENT_ATTACHMENTS = 8;
export const MAX_AGENT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_DOCUMENT_BYTES = 25 * 1024 * 1024;

const KIND_BY_EXTENSION: Partial<Record<string, AgentAttachmentKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  pdf: "document",
  pptx: "document",
};

export type AttachmentCheck =
  | { ok: true; kind: AgentAttachmentKind }
  | { ok: false; reason: string };

export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function classifyAttachmentFile(file: { name: string; size: number }): AttachmentCheck {
  const kind = KIND_BY_EXTENSION[attachmentExtension(file.name)] ?? null;
  if (kind === null) {
    return { ok: false, reason: "只支持图片、PDF 和 PPTX" };
  }
  if (file.size <= 0) {
    return { ok: false, reason: "文件是空的" };
  }
  const limit = kind === "image" ? MAX_AGENT_IMAGE_BYTES : MAX_AGENT_DOCUMENT_BYTES;
  if (file.size > limit) {
    return { ok: false, reason: (kind === "image" ? "图片" : "文档") + "不能超过 " + limit / 1024 / 1024 + " MB" };
  }
  return { ok: true, kind };
}

export function parseAgentAttachment(value: unknown): AgentAttachment | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || !("name" in value) || !("kind" in value)) return null;
  if (!("mime_type" in value) || !("size" in value)) return null;
  const { id, name, kind, mime_type: mimeType, size } = value;
  if (typeof id !== "string" || !id) return null;
  if (typeof name !== "string" || typeof mimeType !== "string" || typeof size !== "number") return null;
  if (kind !== "image" && kind !== "document") return null;
  return { id, name, kind, mime_type: mimeType, size };
}

// The words sent when the user attaches files without typing anything.
export const ATTACHMENT_ONLY_MESSAGE = "请看一下我发的附件";

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function hasDraggedFiles(types: ReadonlyArray<string> | DOMStringList): boolean {
  return Array.from(types).includes("Files");
}
