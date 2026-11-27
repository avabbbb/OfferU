import type { Context, Hono } from "hono";

import { CoreError, MAIL_UNSUPPORTED, type MailAccountView, type MailClient, type MailProvider } from "@offeru/core";

import type { AppEnv } from "../app";
import { jsonBody } from "../app";

/**
 * 设置 › 邮箱. The account (address + 授权码 + servers) lives with the runtime that can reach
 * IMAP / SMTP — the desktop companion's local file — injected as AppDeps.mail. This module only
 * parses and maps; it stays Worker-safe. Without AppDeps.mail (web, Worker) every route answers 501.
 *
 *   GET  /api/mail/status     -> MailStatusView (never the password)
 *   POST /api/mail/test       {provider, address, password, imap?, smtp?} | {} (the saved account) -> MailTestResult
 *   POST /api/mail/configure  {provider, address, password, imap?, smtp?} (tested, saved only when both work) | {clear: true}
 */
export type MailStatusView = {
  connected: boolean;
  account: MailAccountView | null;
  providers: MailProvider[];
};

export type MailCheck = { ok: boolean; error: string | null };
export type MailTestResult = { ok: boolean; imap: MailCheck; smtp: MailCheck };

export interface MailRuntime {
  status(): Promise<MailStatusView>;
  test(input: Record<string, unknown> | null): Promise<MailTestResult>;
  configure(input: Record<string, unknown>): Promise<MailStatusView>;
  disconnect(): Promise<MailStatusView>;
  /** The connected mailbox for the mail tool; null = nothing connected. */
  client(): MailClient | null;
}

function runtime(c: Context<AppEnv>): MailRuntime {
  const mail = c.get("deps").mail;
  if (!mail) throw new CoreError(MAIL_UNSUPPORTED, "unsupported");
  return mail;
}

async function form(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await jsonBody(c);
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export function registerMail(app: Hono<AppEnv>): void {
  app.get("/api/mail/status", async (c) => c.json(await runtime(c).status()));
  app.post("/api/mail/test", async (c) => {
    const mail = runtime(c);
    const body = await form(c);
    return c.json(await mail.test(Object.keys(body).length ? body : null));
  });
  app.post("/api/mail/configure", async (c) => {
    const mail = runtime(c);
    const body = await form(c);
    return c.json(body.clear === true ? await mail.disconnect() : await mail.configure(body));
  });
}
