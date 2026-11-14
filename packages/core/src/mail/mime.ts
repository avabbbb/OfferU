// Minimal RFC 822/2045/2047 reader for job mails: headers (encoded words),
// first text/plain part (else stripped text/html), transfer encodings and
// charsets via TextDecoder (gbk/gb18030/big5 included). Pure, no node:*.

export type ParsedMail = {
  message_id: string;
  thread_id: string;
  received_at: string | null;
  subject: string;
  from: string;
  body: string;
};

export const MAX_TRANSIENT_BODY_CHARS = 200_000;

export const EMAIL_RELEVANCE_TERMS = [
  "面试", "笔试", "测评", "网申", "投递", "招聘", "简历已收到", "申请已提交", "录用", "拒信",
  "offer", "interview", "assessment", "application received", "application submitted",
  "未通过", "遗憾", "not moving forward", "rejection", "follow up", "follow-up", "recruit", "hiring",
];

export function isRelevantMail(message: { subject?: string; from?: string; body?: string }): boolean {
  const text = [message.subject ?? "", message.from ?? "", (message.body ?? "").slice(0, 20_000)].join("\n").toLowerCase();
  return EMAIL_RELEVANCE_TERMS.some((term) => text.includes(term.toLowerCase()));
}

const latin1 = (bytes: Uint8Array): string => {
  let out = "";
  for (let index = 0; index < bytes.length; index += 0x8000) out += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return out;
};

const toBytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label === "gb2312" ? "gbk" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    return toBytes(atob(clean.length % 4 ? clean.padEnd(clean.length + 4 - (clean.length % 4), "=") : clean));
  } catch {
    return new Uint8Array();
  }
}

function decodeQuotedPrintable(text: string, header = false): Uint8Array {
  const source = header ? text.replace(/_/g, " ") : text.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const hex = source.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      index += 2;
    } else {
      out.push(source.charCodeAt(index) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words; whitespace between two encoded words is dropped. Raw 8-bit headers are read as UTF-8. */
export function decodeHeader(raw: string): string {
  if (!raw) return "";
  const utf8 = /[\x80-\xff]/.test(raw) ? decodeCharset(toBytes(raw), "utf-8") : raw;
  return utf8
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, text: string) =>
      decodeCharset(encoding.toUpperCase() === "B" ? decodeBase64(text) : decodeQuotedPrintable(text, true), charset))
    .trim();
}

type Headers = Map<string, string>;

function splitMessage(raw: string): { headers: Headers; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";
  const headers: Headers = new Map();
  let current = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(current)) headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function contentType(headers: Headers): { type: string; params: Record<string, string> } {
  const raw = headers.get("content-type") || "text/plain";
  const [type, ...rest] = raw.split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { type: type.trim().toLowerCase(), params };
}

function payloadText(headers: Headers, body: string, charset: string | undefined): string {
  const encoding = (headers.get("content-transfer-encoding") || "").trim().toLowerCase();
  const bytes = encoding === "base64" ? decodeBase64(body) : encoding === "quoted-printable" ? decodeQuotedPrintable(body) : toBytes(body);
  return decodeCharset(bytes, charset);
}

type Leaf = { type: string; text: string };

function leaves(raw: string, depth = 0): Leaf[] {
  const { headers, body } = splitMessage(raw);
  const { type, params } = contentType(headers);
  if (type.startsWith("multipart/") && params.boundary && depth < 8) {
    const marker = `--${params.boundary}`;
    const parts = body.split(marker).slice(1);
    const out: Leaf[] = [];
    for (const part of parts) {
      if (part.startsWith("--")) break;
      out.push(...leaves(part.replace(/^\r?\n/, ""), depth + 1));
    }
    return out;
  }
  if (type === "message/rfc822" && depth < 8) return leaves(body, depth + 1);
  return [{ type, text: type.startsWith("text/") ? payloadText(headers, body, params.charset) : "" }];
}

function receivedAt(raw: string): string | null {
  const match = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|UT|UTC|GMT|Z)?/i.exec(raw || "");
  if (!match) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const p = (value: string | number) => String(value).padStart(2, "0");
  const zone = !match[7] || /^(UT|UTC|GMT|Z)$/i.test(match[7]) ? "+00:00" : `${match[7].slice(0, 3)}:${match[7].slice(3)}`;
  return `${year}-${p(months.indexOf(match[2].toLowerCase()) + 1)}-${p(match[1])}T${p(match[4])}:${match[5]}:${p(match[6] ?? "00")}${zone}`;
}

/** Parse a raw RFC 822 message (bytes as fetched over IMAP). */
export function parseMail(bytes: Uint8Array): ParsedMail {
  const raw = latin1(bytes);
  const { headers } = splitMessage(raw);
  const parts = leaves(raw);
  const plain = parts.find((part) => part.type === "text/plain" && part.text);
  const html = parts.find((part) => part.type === "text/html" && part.text);
  const body = plain ? plain.text : html ? html.text.replace(/<[^>]+>/g, " ") : "";
  return {
    message_id: decodeHeader(headers.get("message-id") || ""),
    thread_id: decodeHeader(headers.get("references") || headers.get("in-reply-to") || ""),
    received_at: receivedAt(headers.get("date") || ""),
    subject: decodeHeader(headers.get("subject") || ""),
    from: decodeHeader(headers.get("from") || ""),
    body: body.slice(0, MAX_TRANSIENT_BODY_CHARS),
  };
}
