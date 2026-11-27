// 邮箱网页（Gmail / QQ / 163）上的内容脚本主体。
// 1. 写信：本标签页是 OfferU 打开的，就向后台取待填草稿，等写信表单出现后填好，浮层告诉用户检查后自己点发送。
// 2. 读信：用户打开了一封邮件时，右下角出「交给 OfferU」；点了才读这一封交给 OfferU。不扫描收件箱。
import { base64ToBytes, type ComposeRequest } from "./contract.js";
import { attachmentFile, fallbackText, fillCompose, waitForAttachmentName, waitForCompose, type FillReport } from "./compose.js";
import { copyText, MailOverlay } from "./overlay.js";
import { adapterForHost, type WebmailAdapter } from "./providers/index.js";

export interface WebmailRuntime {
  send(message: unknown): Promise<Record<string, unknown> | undefined>;
}

function download(request: ComposeRequest, doc: Document): void {
  if (!request.attachment) return;
  const blob = new Blob([base64ToBytes(request.attachment.base64) as BlobPart], { type: request.attachment.type });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = request.attachment.name;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function runPendingCompose(doc: Document, adapter: WebmailAdapter, runtime: WebmailRuntime, overlay: MailOverlay): Promise<FillReport | null> {
  const response = await runtime.send({ type: "OFFERU_MAIL_COMPOSE_TAKE" });
  const request = response?.compose as ComposeRequest | null | undefined;
  if (!request) return null;
  const onCopy = () => copyText(fallbackText(request, null), doc);
  const onDownload = request.attachment ? () => download(request, doc) : undefined;
  const fields = await waitForCompose(doc, adapter);
  if (!fields) {
    // 多半是还没登录：草稿留着，登录后页面重载会再填。
    overlay.showCompose({
      provider: adapter.label,
      report: null,
      message: `没找到${adapter.label}的写信页。先在这个标签页登录，登录后 OfferU 会接着填；也可以先复制邮件内容。`,
      onCopy,
      onDownload,
    });
    return null;
  }
  const file = attachmentFile(request);
  const report = fillCompose(fields, request, file);
  await runtime.send({ type: "OFFERU_MAIL_COMPOSE_DONE" });
  const show = () => overlay.showCompose({
    provider: adapter.label,
    report,
    onCopy: () => copyText(fallbackText(request, report), doc),
    onDownload,
  });
  show();
  const attach = report.steps.find((step) => step.field === "attachment");
  if (file && attach?.ok && (await waitForAttachmentName(doc, file.name))) {
    attach.note = `已附上 ${file.name}`;
    show();
  }
  return report;
}

/** 读信页出现时挂「交给 OfferU」，离开时收起。 */
export function watchOpenMessages(doc: Document, adapter: WebmailAdapter, runtime: WebmailRuntime, overlay: MailOverlay): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  const check = () => {
    timer = null;
    const open = adapter.readOpen(doc);
    if (open && !shown) {
      shown = true;
      overlay.showHandoff(async () => {
        const message = adapter.readOpen(doc);
        if (!message) return "没读到这封邮件";
        const result = await runtime.send({ type: "OFFERU_MAIL_HANDOFF", message });
        if (!result?.ok) return String(result?.error || "没交出去，再点一次");
        return result.delivered === "tab" ? "已交给 OfferU" : "已打开 OfferU";
      });
    } else if (!open && shown && overlay.hasHandoff()) {
      shown = false;
      overlay.close();
    }
  };
  const observer = new MutationObserver(() => {
    if (!timer) timer = setTimeout(check, 800);
  });
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  check();
  return () => observer.disconnect();
}

export function startWebmail(win: Window, runtime: WebmailRuntime): boolean {
  if (win.top !== win) return false;
  const adapter = adapterForHost(win.location.hostname);
  if (!adapter) return false;
  const overlay = new MailOverlay(win.document);
  void runPendingCompose(win.document, adapter, runtime, overlay)
    .catch(() => undefined)
    .finally(() => watchOpenMessages(win.document, adapter, runtime, overlay));
  return true;
}
