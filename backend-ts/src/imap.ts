// Minimal read-only IMAP4rev1 client over TLS (node:tls, no dependency):
// LOGIN, EXAMINE INBOX, UID SEARCH, UID FETCH BODY.PEEK[]. Enough for the
// mail write-back (port of services/email_sync._fetch_imap_delta_blocking).
// Companion only; the password is passed in and never logged.

import { connect, type TLSSocket } from "node:tls";

export class ImapError extends Error {}

type Tagged = { status: string; text: string; untagged: string[]; literals: Uint8Array[] };

export class ImapConnection {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private counter = 0;

  private constructor(private readonly socket: TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async open(host: string, port: number, timeoutMs = 30_000): Promise<ImapConnection> {
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = connect({ host, port, servername: host, timeout: timeoutMs }, () => resolve(s));
      s.once("error", (cause) => reject(new ImapError(`无法连接 IMAP 服务器 ${host}:${port}（${cause.message}）`)));
      s.once("timeout", () => {
        s.destroy();
        reject(new ImapError(`连接 IMAP 服务器超时 ${host}:${port}`));
      });
    });
    socket.setTimeout(timeoutMs, () => socket.destroy());
    const conn = new ImapConnection(socket);
    const greeting = await conn.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new ImapError("IMAP 服务器拒绝了连接");
    return conn;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async more(): Promise<void> {
    if (this.closed) throw new ImapError("IMAP 连接已断开");
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.buffer.subarray(0, end).toString("latin1");
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.more();
    }
  }

  private async readBytes(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) await this.more();
    const bytes = new Uint8Array(this.buffer.subarray(0, count));
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  /** Send one command; collect untagged lines and literals until the tagged reply. */
  async command(text: string): Promise<Tagged> {
    const tag = `A${(this.counter += 1).toString().padStart(3, "0")}`;
    this.socket.write(`${tag} ${text}\r\n`);
    const untagged: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      // Literals: "... {123}" then 123 raw bytes, then the rest of the line.
      let literal = /\{(\d+)\}$/.exec(line);
      while (literal) {
        literals.push(await this.readBytes(Number(literal[1])));
        const rest = await this.readLine();
        line = `${line}${rest}`;
        literal = /\{(\d+)\}$/.exec(rest);
      }
      if (line.startsWith(`${tag} `)) {
        const [, status = "", message = ""] = /^\S+ (\S+) ?(.*)$/.exec(line) ?? [];
        const result = { status: status.toUpperCase(), text: message, untagged, literals };
        if (result.status !== "OK") throw new ImapError(message || `IMAP ${status}`);
        return result;
      }
      if (line.startsWith("+")) continue;
      untagged.push(line);
    }
  }

  async login(user: string, password: string): Promise<void> {
    try {
      await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    } catch (cause) {
      throw new ImapError(`IMAP 登录失败：请检查邮箱地址和授权码（${cause instanceof Error ? redact(cause.message, password) : ""}）`);
    }
  }

  /** Read-only open of INBOX; returns UIDVALIDITY / UIDNEXT. */
  async examineInbox(): Promise<{ uidvalidity: number; uidnext: number }> {
    const reply = await this.command("EXAMINE INBOX");
    const number = (key: string) => {
      for (const line of reply.untagged) {
        const match = new RegExp(`${key}\\s+(\\d+)`, "i").exec(line);
        if (match) return Number(match[1]);
      }
      return 0;
    };
    return { uidvalidity: number("UIDVALIDITY"), uidnext: number("UIDNEXT") };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const reply = await this.command(`UID SEARCH ${criteria}`);
    return reply.untagged
      .filter((line) => /^\* SEARCH/i.test(line))
      .flatMap((line) => line.replace(/^\* SEARCH/i, "").trim().split(/\s+/))
      .filter((value) => /^\d+$/.test(value))
      .map(Number);
  }

  async fetchRaw(uid: number): Promise<Uint8Array> {
    const reply = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    const raw = reply.literals[0];
    if (!raw) throw new ImapError("IMAP 返回了无效消息");
    return raw;
  }

  async logout(): Promise<void> {
    try {
      if (!this.closed) await this.command("LOGOUT").catch(() => undefined);
    } finally {
      this.socket.destroy();
    }
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function redact(text: string, secret: string): string {
  return secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text;
}

/** IMAP SINCE date: 01-Jan-2026. */
export function imapDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
}
