// The `mail` tool: read the inbox, save a draft to the mailbox, send a saved draft.
// IO is the injected MailClient (companion: IMAP + SMTP, routes/companion/mail.ts);
// the rules live here: what a list / read returns, how an email doc becomes a message,
// and the send gate — only the user (actor「你」, the workbench's 确认发送) sends;
// any other caller gets needs_confirmation and nothing leaves the machine.

import { label } from "../labels";
import { saveRecord, USER_ACTOR } from "../operations";
import { CoreError, type Json, type StoredRecord } from "../types";
import { unescapeHtml } from "../tools/posting-guard";
import type { ToolDeps } from "../tools/deps";

export type MailSummary = { id: string; from: string; subject: string; date: string | null; preview: string; seen: boolean };

export type MailMessage = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  text: string;
  html: string | null;
  attachments: string[];
};

export type OutgoingMail = {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: Array<{ path: string }>;
};

/** Where a draft sits in the mailbox: the Drafts folder and the draft's Message-ID. */
export type MailDraftRef = { folder: string; message_id: string };

/**
 * One connected mailbox. `cursor` is opaque to core (the companion encodes UIDVALIDITY:UID):
 * list returns the cursor of its newest message, a later list with it returns only newer mail.
 */
export interface MailClient {
  address: string;
  list(query: { sinceDays: number; cursor: string | null; max: number }): Promise<{ messages: MailSummary[]; cursor: string | null }>;
  read(id: string): Promise<MailMessage>;
  /** IMAP APPEND to the \Drafts folder with \Draft; `replace` is the previous draft of the same doc, removed after. */
  saveDraft(mail: OutgoingMail, replace: MailDraftRef | null): Promise<MailDraftRef>;
  /** SMTP send; `draft` is removed from Drafts after a successful send (draft_removed=false when it could not be). */
  send(mail: OutgoingMail, draft: MailDraftRef | null): Promise<{ message_id: string; accepted: string[]; rejected: string[]; draft_removed: boolean }>;
}

export const MAIL_READ_LIMIT = 6000;
const PREVIEW_LIMIT = 140;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
export const MAIL_UNSUPPORTED = "邮箱只在 OfferU 桌面版可用：网页版不能连 IMAP / SMTP。在桌面版 设置 › 邮箱 连上后再用";
export const MAIL_NOT_CONNECTED = "还没连邮箱：到 设置 › 邮箱 选服务商、填邮箱地址和授权码，连上后再用";
export const MAIL_CONFIRM = "没有发出：发信要用户本人确认。告诉用户去岗位详情「投递邮件」卡片上核对后点「确认发送」";

/** Read-only actions (sandbox read_only lets these through). */
export const MAIL_READ_ACTIONS: ReadonlySet<string> = new Set(["list", "read"]);

/** HTML mail body → plain text (previews and html-only mails). */
export function mailHtmlText(html: string): string {
  return unescapeHtml(html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First ~140 chars of a body, whitespace collapsed. */
export function mailPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat;
}

/** http(s) links from the html hrefs and the text, in order, deduplicated, max 30. */
export function mailLinks(text: string, html: string | null): string[] {
  const found: string[] = [];
  for (const match of (html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) found.push(unescapeHtml(match[1]));
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'（）「」，。]+/gi)) found.push(match[0]);
  const links = found.map((url) => url.trim().replace(/[),.;:!?]+$/, "")).filter((url) => /^https?:\/\/\S+$/i.test(url));
  return [...new Set(links)].slice(0, 30);
}

function client(deps: ToolDeps): MailClient {
  if (deps.mail === undefined) throw new CoreError(MAIL_UNSUPPORTED, "unsupported");
  if (deps.mail === null) throw new CoreError(MAIL_NOT_CONNECTED, "not_configured");
  return deps.mail;
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const addresses = (value: unknown): string[] => (Array.isArray(value) ? value : String(value ?? "").split(/[,，;；\s]+/))
  .map((item) => String(item).trim()).filter(Boolean);

async function emailDoc(deps: ToolDeps, id: unknown): Promise<StoredRecord> {
  const doc = typeof id === "number" ? await deps.store.get("doc", id) : null;
  if (!doc || doc.kind !== "email") throw new CoreError(`邮件草稿 #${String(id)} 不存在（要 doc kind=email，先 draft_email 或 mail draft）`, "not_found");
  return doc;
}

/** An email doc → the message to append / send. Checks the fields a mail server would reject. */
export function outgoingOf(doc: Json): OutgoingMail {
  const to = addresses(doc.to);
  const cc = addresses(doc.cc);
  const bad = [...to, ...cc].filter((item) => !EMAIL.test(item));
  if (!to.length) throw new CoreError("草稿没有收件人：先补上 to");
  if (bad.length) throw new CoreError(`收件人地址不对：${bad.join("、")}`);
  const subject = str(doc.subject);
  if (!subject) throw new CoreError("草稿没有标题：先补上 subject");
  const files = [doc.attachment, ...(Array.isArray(doc.files) ? doc.files : [])].filter((item): item is string => typeof item === "string" && Boolean(item));
  return { to, cc, subject, text: String(doc.body ?? ""), attachments: [...new Set(files)].map((path) => ({ path })) };
}

const draftRef = (doc: Json): MailDraftRef | null => {
  const ref = doc.draft as Partial<MailDraftRef> | null | undefined;
  return ref && typeof ref.folder === "string" && typeof ref.message_id === "string" ? { folder: ref.folder, message_id: ref.message_id } : null;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

async function list(deps: ToolDeps, args: Record<string, unknown>): Promise<Json> {
  const mail = client(deps);
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const words = str(args.query).toLowerCase().split(/\s+/).filter(Boolean);
  const out = await mail.list({ sinceDays: typeof args.days === "number" ? args.days : 7, cursor: str(args.cursor) || null, max: words.length ? 200 : limit });
  const hit = (item: MailSummary) => {
    const hay = `${item.from}\n${item.subject}\n${item.preview}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  };
  const messages = out.messages.filter(hit).slice(0, limit);
  return {
    account: mail.address,
    count: messages.length,
    messages,
    cursor: out.cursor,
    next: messages.length
      ? "要看正文和链接就 mail(action=read, id)；邀约邮件按公司 search 岗位，save 推进 status 并存 event（带 url）"
      : "这段时间没有符合条件的邮件",
  };
}

async function read(deps: ToolDeps, args: Record<string, unknown>): Promise<Json> {
  const id = str(args.id);
  if (!id) throw new CoreError("read 要给邮件 id（list 返回的 id）");
  const message = await client(deps).read(id);
  const body = message.text.trim() || (message.html ? mailHtmlText(message.html) : "");
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    text: body.slice(0, MAIL_READ_LIMIT),
    truncated: body.length > MAIL_READ_LIMIT,
    links: mailLinks(body, message.html),
    attachments: message.attachments,
  };
}

/** Draft: an existing email doc (draft_email's), or a new one composed from to / subject / body. */
async function draft(deps: ToolDeps, args: Record<string, unknown>): Promise<Json> {
  const mail = client(deps);
  let existing: StoredRecord | null = null;
  const patch: Json = {};
  if (args.doc_id !== undefined && args.doc_id !== null) {
    existing = await emailDoc(deps, args.doc_id);
    for (const key of ["to", "subject", "body"] as const) if (typeof args[key] === "string") patch[key] = args[key];
    if (args.cc !== undefined && args.cc !== null) patch.cc = addresses(args.cc);
  } else {
    const jobId = typeof args.job_id === "number" ? args.job_id : null;
    const job = jobId ? await deps.store.get("job", jobId) : null;
    if (jobId && !job) throw new CoreError(`岗位 #${jobId} 不存在`, "not_found");
    Object.assign(patch, {
      kind: "email", job_id: jobId, title: job ? `投递邮件 · ${label(job)}` : `邮件 · ${str(args.subject) || "未命名"}`,
      to: str(args.to), cc: addresses(args.cc), subject: str(args.subject), body: String(args.body ?? ""),
    });
  }
  if (typeof args.resume_id === "number") {
    const resume = await deps.store.get("doc", args.resume_id);
    if (!resume || resume.kind !== "resume") throw new CoreError(`简历 #${args.resume_id} 不存在`, "not_found");
    if (!deps.exportResumePdf) throw new CoreError("这个运行环境不能导出简历 PDF", "unsupported");
    patch.attachment = (await deps.exportResumePdf(resume.id, "")).path;
    patch.resume_id = resume.id;
  }
  if (Array.isArray(args.files)) patch.files = args.files.map(String).filter(Boolean);
  const message = outgoingOf({ ...existing, ...patch });
  const ref = await mail.saveDraft(message, existing ? draftRef(existing) : null);
  const saved = await saveRecord(deps.store, {
    type: "doc",
    id: existing?.id,
    data: { ...patch, draft: ref, drafted_at: deps.ctx.now, sent_at: null },
  }, deps.ctx);
  return {
    doc_id: saved.record.id,
    change_id: saved.change_id,
    job_id: saved.record.job_id ?? null,
    account: mail.address,
    draft: ref,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    attachments: message.attachments.map((item) => fileName(item.path)),
    next: "草稿已存进邮箱草稿箱，没有发出。要发：请用户在岗位详情「投递邮件」卡片上核对后点「确认发送」（或调 mail(action=send, doc_id)，它会等用户确认）",
  };
}

/** The send gate: only the user sends. Anyone else gets needs_confirmation and nothing is sent or written. */
async function send(deps: ToolDeps, args: Record<string, unknown>): Promise<Json> {
  const mail = client(deps);
  const doc = await emailDoc(deps, args.doc_id);
  const message = outgoingOf(doc);
  const summary = { doc_id: doc.id, job_id: doc.job_id ?? null, to: message.to, cc: message.cc, subject: message.subject, attachments: message.attachments.map((item) => fileName(item.path)) };
  if (deps.ctx.actor !== USER_ACTOR) return { status: "needs_confirmation", sent: false, ...summary, message: MAIL_CONFIRM };
  if (doc.sent_at) throw new CoreError(`这封邮件 ${String(doc.sent_at).slice(0, 16).replace("T", " ")} 已经发过了；要再发先重写草稿`, "conflict");
  const result = await mail.send(message, draftRef(doc));
  const saved = await saveRecord(deps.store, {
    type: "doc", id: doc.id, data: { sent_at: deps.ctx.now, message_id: result.message_id, draft: null },
  }, deps.ctx);
  // 发出去了：还在「想投」的岗位推进到「已投递」（投递日自动记今天），一条改动可撤销。
  const job = typeof doc.job_id === "number" ? await deps.store.get("job", doc.job_id) : null;
  const moved = job && job.status === "saved"
    ? await saveRecord(deps.store, { type: "job", id: job.id, data: { status: "applied" } }, deps.ctx)
    : null;
  return {
    status: "sent",
    sent: true,
    ...summary,
    message_id: result.message_id,
    accepted: result.accepted,
    rejected: result.rejected,
    draft_removed: result.draft_removed,
    change_ids: [saved.change_id, moved?.change_id].filter((item) => item != null),
    job_status: moved ? "applied" : job?.status ?? null,
  };
}

export async function mailTool(args: Record<string, unknown>, deps: ToolDeps): Promise<Json> {
  switch (args.action) {
    case "list": return list(deps, args);
    case "read": return read(deps, args);
    case "draft": return draft(deps, args);
    case "send": return send(deps, args);
    default: throw new CoreError("action 只能是 list / read / draft / send");
  }
}
