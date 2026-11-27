// 在邮箱写信页填好收件人、标题、正文，附上简历 PDF。只填，不发：没有任何代码会点「发送」。
// 哪一项没填上就记进报告，由浮层给「复制」和「下载附件」退路，并用中文说清要用户手动做什么。
import { base64ToBytes, type ComposeRequest } from "./contract.js";
import {
  attachToInput, defaultFileList, dropFileOn, editableHas, recipientPresent, setEditableText, setInputValue, type FileListFactory,
} from "./dom.js";
import type { ComposeFields, WebmailAdapter } from "./providers/types.js";

export type FillField = "to" | "cc" | "subject" | "body" | "attachment";

export interface FillStep {
  field: FillField;
  ok: boolean;
  /** 没填上或需要用户确认时的一句话。 */
  note?: string;
}

export interface FillReport {
  ok: boolean;
  steps: FillStep[];
}

export const FIELD_LABEL: Record<FillField, string> = {
  to: "收件人",
  cc: "抄送",
  subject: "标题",
  body: "正文",
  attachment: "附件",
};

export function attachmentFile(request: ComposeRequest): File | null {
  if (!request.attachment) return null;
  const bytes = base64ToBytes(request.attachment.base64);
  return new File([bytes as BlobPart], request.attachment.name, { type: request.attachment.type || "application/pdf" });
}

/** 一次性把能找到的字段都填上，返回逐项结果。 */
export function fillCompose(fields: ComposeFields, request: ComposeRequest, file: File | null, makeList: FileListFactory = defaultFileList): FillReport {
  const steps: FillStep[] = [];

  if (recipientPresent(fields.root, request.to, fields.to)) steps.push({ field: "to", ok: true });
  else if (fields.to) steps.push({ field: "to", ok: setInputValue(fields.to, request.to) || recipientPresent(fields.root, request.to, fields.to) });
  else steps.push({ field: "to", ok: false, note: "没找到收件人框" });

  if (request.cc.length) {
    const all = request.cc.every((address) => recipientPresent(fields.root, address, fields.cc));
    if (all) steps.push({ field: "cc", ok: true });
    else if (fields.cc) steps.push({ field: "cc", ok: setInputValue(fields.cc, request.cc.join(", ")) });
    else steps.push({ field: "cc", ok: false, note: "抄送框没展开，请手动添加" });
  }

  if (!fields.subject) steps.push({ field: "subject", ok: false, note: "没找到标题框" });
  else if (fields.subject.value.trim() === request.subject) steps.push({ field: "subject", ok: true });
  else steps.push({ field: "subject", ok: setInputValue(fields.subject, request.subject) });

  if (!request.body.trim()) {
    // 没正文就不写
  } else if (!fields.body) {
    steps.push({ field: "body", ok: false, note: "没找到正文编辑区" });
  } else if (fields.body instanceof HTMLTextAreaElement) {
    steps.push({ field: "body", ok: fields.body.value.includes(request.body.trim().split("\n")[0]) || setInputValue(fields.body, request.body) });
  } else if (editableHas(fields.body, request.body)) {
    steps.push({ field: "body", ok: true });
  } else {
    steps.push({ field: "body", ok: setEditableText(fields.body, request.body) });
  }

  if (file) {
    if (fields.file) {
      const ok = attachToInput(fields.file, file, makeList);
      steps.push({ field: "attachment", ok, note: ok ? "已交给邮箱上传，请确认草稿里出现了附件" : "附件没放进去" });
    } else if (fields.body) {
      dropFileOn(fields.body, file, makeList);
      steps.push({ field: "attachment", ok: true, note: "已拖进写信区，请确认草稿里出现了附件" });
    } else {
      steps.push({ field: "attachment", ok: false, note: "没找到添加附件的入口" });
    }
  }

  return { ok: steps.every((step) => step.ok), steps };
}

/** 没填上的内容拼成一段纯文本，供「复制」退路用。 */
export function fallbackText(request: ComposeRequest, report: FillReport | null): string {
  const failed = new Set(report ? report.steps.filter((step) => !step.ok).map((step) => step.field) : ["to", "cc", "subject", "body"]);
  const lines: string[] = [];
  if (failed.has("to")) lines.push(`收件人：${request.to}`);
  if (failed.has("cc") && request.cc.length) lines.push(`抄送：${request.cc.join(", ")}`);
  if (failed.has("subject")) lines.push(`标题：${request.subject}`);
  if (failed.has("body")) lines.push("", request.body);
  return lines.join("\n").trim() || `收件人：${request.to}\n标题：${request.subject}\n\n${request.body}`;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 多久还没写信表单就点一次「写信」。 */
  openAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等写信表单出现（邮箱是单页应用，加载慢）；一直没有就点一次「写信」，再等。没登录时返回 null。 */
export async function waitForCompose(doc: Document, adapter: WebmailAdapter, options: WaitOptions = {}): Promise<ComposeFields | null> {
  const { timeoutMs = 30_000, intervalMs = 500, openAfterMs = 2500, sleep = realSleep, now = Date.now } = options;
  const start = now();
  let clicked = false;
  for (;;) {
    const fields = adapter.findCompose(doc);
    if (fields) return fields;
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) return null;
    if (!clicked && elapsed >= openAfterMs) clicked = adapter.openCompose(doc);
    await sleep(intervalMs);
  }
}

/** 等附件名出现在写信页（上传开始了）。只用来决定提示语，不当作发送前的保证。 */
export async function waitForAttachmentName(doc: Document, name: string, options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const { timeoutMs = 8000, sleep = realSleep } = options;
  const stem = name.replace(/\.pdf$/i, "");
  for (let waited = 0; waited <= timeoutMs; waited += 500) {
    if ((doc.body?.textContent ?? "").includes(stem)) return true;
    await sleep(500);
  }
  return false;
}
