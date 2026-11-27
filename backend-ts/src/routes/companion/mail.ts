import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";

import { ImapFlow, type MessageStructureObject } from "imapflow";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser, type AddressObject } from "mailparser";
import {
  CoreError,
  MAIL_PROVIDERS,
  mailAccount,
  mailAccountView,
  mailHtmlText,
  mailPreview,
  type MailAccount,
  type MailClient,
  type MailDraftRef,
  type MailMessage,
  type MailSummary,
  type OutgoingMail,
} from "@offeru/core";

import type { MailCheck, MailRuntime, MailStatusView, MailTestResult } from "../mail";
import { APP_VERSION } from "../../runtime-identity";

/**
 * Desktop mailbox: IMAP (imapflow) for reading and the Drafts folder, SMTP (nodemailer) for sending.
 * The account — address, 授权码, servers — sits in <data>/offeru-mail.json (0600), like the model
 * settings file; it never goes into offeru.db, the change log, tool output or logs (both libraries
 * run with logging off). Every call opens its own short connection: the tool is used a few times a
 * day, so there is no idle connection to keep alive or reconnect.
 */

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000 };
const PREVIEW_BYTES = 4096;
const READ_BYTES = 10 * 1024 * 1024;

export function nodeMailAccountFile(path: string) {
  return {
    load(): MailAccount | null {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as MailAccount;
    },
    save(account: MailAccount): void {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(account, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
    },
    clear(): void {
      rmSync(path, { force: true });
    },
  };
}

type Failure = Error & { authenticationFailed?: boolean; code?: string; responseText?: string; response?: string };

/** imapflow / nodemailer error → one Chinese line, plus whether it is the credentials (not_configured) or the network. */
function describe(cause: unknown, what: "IMAP" | "SMTP", server: string): { message: string; auth: boolean } {
  const error = cause as Failure;
  const auth = Boolean(error?.authenticationFailed) || error?.code === "EAUTH";
  if (auth) {
    return { message: `${what} 登录被拒：邮箱地址或授权码不对，或者还没在邮箱网页版开启 IMAP/SMTP 服务`, auth: true };
  }
  const network = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS", "NoConnection"];
  if (error?.code && network.includes(error.code)) return { message: `连不上 ${what} 服务器 ${server}（${error.code}）`, auth: false };
  const detail = String(error?.responseText || error?.response || error?.message || cause).replace(/\s+/g, " ").slice(0, 200);
  return { message: `${what} 出错：${detail}`, auth: false };
}

function failure(cause: unknown, what: "IMAP" | "SMTP", server: string): CoreError {
  if (cause instanceof CoreError) return cause;
  const { message, auth } = describe(cause, what, server);
  return new CoreError(auth ? `${message}；到 设置 › 邮箱 重新填` : message, auth ? "not_configured" : "upstream");
}

async function withImap<T>(account: MailAccount, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const server = `${account.imap.host}:${account.imap.port}`;
  const client = new ImapFlow({
    ...account.imap,
    auth: { user: account.address, pass: account.password },
    logger: false,
    // 163 / 126 refuse SELECT until the client sends IMAP ID (「Unsafe Login」); imapflow sends ID right
    // after the greeting whenever the server lists the ID capability, with this client info.
    clientInfo: { name: "OfferU", version: APP_VERSION, vendor: "OfferU" },
    disableAutoIdle: true,
    ...TIMEOUTS,
  });
  // A socket error after connect is surfaced by the pending command; without a listener it would crash the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
    return await run(client);
  } catch (cause) {
    throw failure(cause, "IMAP", server);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function smtp(account: MailAccount) {
  return createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    requireTLS: !account.smtp.secure,
    auth: { user: account.address, pass: account.password },
    ...TIMEOUTS,
  });
}

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The body part a preview comes from: the first inline text/plain, else text/html. */
function textPart(node: MessageStructureObject | undefined): { part: string; html: boolean } | null {
  const parts: Array<{ part: string; html: boolean }> = [];
  const walk = (item: MessageStructureObject) => {
    if (item.childNodes?.length) return item.childNodes.forEach(walk);
    if (item.disposition === "attachment") return;
    if (item.type === "text/plain" || item.type === "text/html") parts.push({ part: item.part ?? "1", html: item.type === "text/html" });
  };
  if (node) walk(node);
  return parts.find((item) => !item.html) ?? parts[0] ?? null;
}

const person = (item: { name?: string; address?: string } | undefined) => (item ? (item.name ? `${item.name} <${item.address ?? ""}>` : item.address ?? "") : "");
const people = (value: AddressObject | AddressObject[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).flatMap((group) => group.value.map(person));

function parseCursor(cursor: string | null): { validity: string; uid: number } | null {
  const match = /^(\d+):(\d+)$/.exec(cursor ?? "");
  return match ? { validity: match[1], uid: Number(match[2]) } : null;
}

async function draftsFolder(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const drafts = boxes.find((box) => box.specialUse === "\\Drafts");
  if (!drafts) throw new CoreError("邮箱里找不到草稿箱（\\Drafts）：服务商没有标出草稿箱，暂时存不了草稿", "unsupported");
  return drafts.path;
}

async function removeDraft(client: ImapFlow, ref: MailDraftRef): Promise<boolean> {
  const lock = await client.getMailboxLock(ref.folder);
  try {
    const uids = await client.search({ header: { "message-id": ref.message_id } }, { uid: true });
    if (!uids || !uids.length) return false;
    return client.messageDelete(uids, { uid: true });
  } finally {
    lock.release();
  }
}

async function compose(account: MailAccount, mail: OutgoingMail): Promise<{ raw: Buffer; messageId: string }> {
  const node = new MailComposer({ from: account.address, to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.text, attachments: mail.attachments }).compile();
  const messageId = node.messageId();
  return { raw: await node.build(), messageId };
}

/** The MailClient the mail tool gets for one saved account. */
export function imapSmtpMail(account: MailAccount): MailClient {
  return {
    address: account.address,

    list: ({ sinceDays, cursor, max }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const box = client.mailbox;
        const validity = box ? String(box.uidValidity) : "";
        const after = parseCursor(cursor);
        const found = after && after.validity === validity
          ? await client.search({ uid: `${after.uid + 1}:*` }, { uid: true })
          : await client.search({ since: new Date(Date.now() - sinceDays * 86_400_000) }, { uid: true });
        const uids = (found || []).filter((uid) => !after || after.validity !== validity || uid > after.uid).sort((a, b) => b - a).slice(0, max);
        const rows = uids.length ? await client.fetchAll(uids, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true }) : [];
        const messages: MailSummary[] = [];
        for (const row of rows.sort((a, b) => b.uid - a.uid)) {
          const part = textPart(row.bodyStructure);
          const download = part ? await client.download(String(row.uid), part.part, { uid: true, maxBytes: PREVIEW_BYTES }) : null;
          const body = download?.content ? await text(download.content) : "";
          const date = row.envelope?.date ?? row.internalDate;
          messages.push({
            id: String(row.uid),
            from: person(row.envelope?.from?.[0]),
            subject: row.envelope?.subject ?? "",
            date: date ? new Date(date).toISOString() : null,
            preview: mailPreview(part?.html ? mailHtmlText(body) : body),
            seen: Boolean(row.flags?.has("\\Seen")),
          });
        }
        const newest = uids[0] ?? after?.uid ?? (box ? Number(box.uidNext) - 1 : 0);
        return { messages, cursor: validity ? `${validity}:${newest}` : null };
      } finally {
        lock.release();
      }
    }),

    read: (id) => withImap(account, async (client) => {
      if (!/^\d+$/.test(id)) throw new CoreError(`邮件 id 不对：${id}（用 mail list 返回的 id）`);
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const download = await client.download(id, undefined, { uid: true, maxBytes: READ_BYTES });
        if (!download?.content) throw new CoreError(`收件箱里没有邮件 ${id}`, "not_found");
        const parsed = await simpleParser(download.content, { keepCidLinks: true });
        const message: MailMessage = {
          id,
          from: parsed.from ? people(parsed.from).join(", ") : "",
          to: people(parsed.to),
          cc: people(parsed.cc),
          subject: parsed.subject ?? "",
          date: parsed.date ? parsed.date.toISOString() : null,
          text: parsed.text ?? "",
          html: typeof parsed.html === "string" ? parsed.html : null,
          attachments: parsed.attachments.map((item) => item.filename ?? item.contentType),
        };
        return message;
      } finally {
        lock.release();
      }
    }),

    saveDraft: async (mail, replace) => {
      const { raw, messageId } = await compose(account, mail);
      return withImap(account, async (client) => {
        const folder = await draftsFolder(client);
        await client.append(folder, raw, ["\\Draft", "\\Seen"]);
        if (replace) await removeDraft(client, replace);
        return { folder, message_id: messageId };
      });
    },

    send: async (mail, draft) => {
      const server = `${account.smtp.host}:${account.smtp.port}`;
      const transport = smtp(account);
      let info;
      try {
        info = await transport.sendMail({ from: account.address, to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.text, attachments: mail.attachments });
      } catch (cause) {
        throw failure(cause, "SMTP", server);
      } finally {
        transport.close();
      }
      // Sent: a leftover draft is reported, never turned into a failed send.
      const draftRemoved = draft ? await withImap(account, (client) => removeDraft(client, draft)).catch(() => false) : true;
      const addr = (list: unknown[]) => list.map((item) => (typeof item === "string" ? item : person(item as { name?: string; address?: string })));
      return { message_id: info.messageId, accepted: addr(info.accepted), rejected: addr(info.rejected), draft_removed: draftRemoved };
    },
  };
}

async function check(run: () => Promise<unknown>, what: "IMAP" | "SMTP", server: string): Promise<MailCheck> {
  try {
    await run();
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof CoreError ? cause.message : describe(cause, what, server).message };
  }
}

/** Log in to IMAP and SMTP with the account, without reading or sending anything. */
export async function checkMailAccount(account: MailAccount): Promise<MailTestResult> {
  const [imap, smtpCheck] = await Promise.all([
    check(() => withImap(account, async () => undefined), "IMAP", `${account.imap.host}:${account.imap.port}`),
    check(async () => {
      const transport = smtp(account);
      try { await transport.verify(); } finally { transport.close(); }
    }, "SMTP", `${account.smtp.host}:${account.smtp.port}`),
  ]);
  return { ok: imap.ok && smtpCheck.ok, imap, smtp: smtpCheck };
}

/** AppDeps.mail on the companion. `connect` / `verify` are swapped out by tests (no real mail server). */
export function nodeMail(path: string, connect = imapSmtpMail, verify = checkMailAccount): MailRuntime {
  const file = nodeMailAccountFile(path);
  const status = async (): Promise<MailStatusView> => {
    const account = file.load();
    return { connected: Boolean(account), account: mailAccountView(account), providers: MAIL_PROVIDERS };
  };
  return {
    status,
    test: (input) => {
      const account = input ? mailAccount(input, file.load()) : file.load();
      if (!account) throw new CoreError("还没连邮箱：先填邮箱地址和授权码", "not_configured");
      return verify(account);
    },
    async configure(input) {
      const account = mailAccount(input, file.load());
      const result = await verify(account);
      if (!result.ok) throw new CoreError([result.imap.error, result.smtp.error].filter(Boolean).join("；"), "invalid");
      file.save(account);
      return status();
    },
    async disconnect() {
      file.clear();
      return status();
    },
    client() {
      const account = file.load();
      return account ? connect(account) : null;
    },
  };
}
