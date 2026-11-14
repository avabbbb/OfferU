// What happens to fetched mails (pure part of services/email_sync.py) and the
// `email_sync` tool's output shape. Fetching (IMAP) is a host port.

import { nowIso, todayIso } from "../labels";
import type { CoreStore } from "../types";
import { CoreError } from "../types";
import type { LlmClient } from "../llm";
import { MAIL_ACTOR } from "../operations";
import { applyMailSignal, classifyMail, mailSeen, mailToday } from "./classify";
import { MAX_TRANSIENT_BODY_CHARS } from "./mime";

export type FetchedMail = {
  provider_id: string;
  message_id: string;
  subject: string;
  from: string;
  body: string;
  received_at: string | null;
};

export type MailSyncCounts = {
  synced: number;
  duplicates: number;
  failed: number;
  total_found: number;
  calendar_created: number;
  requires_review: number;
  core_change_ids: number[];
};

/** Long ids are hashed like Python _bounded_identifier. */
export async function boundedIdentifier(value: unknown, fallback = ""): Promise<string> {
  const text = String(value || fallback).trim();
  if ([...text].length <= 500) return text;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Classify every relevant mail; write back the ones never seen before. */
export async function applyFetchedMails(store: CoreStore, messages: FetchedMail[], llm?: LlmClient | null, useLlm = true): Promise<MailSyncCounts> {
  const counts: MailSyncCounts = { synced: 0, duplicates: 0, failed: 0, total_found: messages.length, calendar_created: 0, requires_review: 0, core_change_ids: [] };
  for (const message of messages) {
    const body = String(message.body || message.subject || "").slice(0, MAX_TRANSIENT_BODY_CHARS);
    const ref = await boundedIdentifier(message.message_id, message.provider_id);
    if (await mailSeen(store, ref)) {
      counts.duplicates += 1;
      continue;
    }
    counts.synced += 1;
    const classification = await classifyMail({ subject: message.subject, body, sender: message.from, receivedAt: message.received_at }, llm, useLlm);
    const written = await applyMailSignal(store, {
      mail_id: ref,
      stage: classification.stage,
      company: classification.company,
      title: classification.title,
      at: classification.at,
      sender: message.from,
      subject: message.subject,
    }, { actor: MAIL_ACTOR, now: nowIso(), today: todayIso() });
    counts.core_change_ids.push(...written.changes);
  }
  return counts;
}

export type MailAccountView = {
  account_id: string;
  provider: string;
  email_address: string;
  last_synced_at: string | null;
  last_error: string;
};

export type MailRunView = {
  status: string;
  completed_at: string | null;
  error: string;
  result: Partial<MailSyncCounts>;
};

/** Host side of mail sync (the local companion's IMAP service). */
export interface MailSyncPort {
  activeAccounts(): Promise<MailAccountView[]>;
  recentRuns(accountId: string | null, limit: number): Promise<MailRunView[]>;
  sync(accountId: string | null): Promise<{ runs: Array<Partial<MailSyncCounts>>; failed_accounts: number }>;
}

/** The `email_sync` tool: same output as Python core/tools.email_sync. */
export async function emailSyncTool(store: CoreStore, port: MailSyncPort, args: { action?: unknown; account?: unknown }): Promise<Record<string, unknown>> {
  const action = args.action === undefined || args.action === null ? "status" : String(args.action);
  const account = typeof args.account === "string" && args.account ? args.account : null;
  if (action !== "status" && action !== "sync") throw new CoreError("action 只能是 status 或 sync");
  if (action === "sync") {
    const result = await port.sync(account);
    return {
      accounts: result.runs.length,
      found: result.runs.reduce((sum, run) => sum + Number(run.total_found || 0), 0),
      new: result.runs.reduce((sum, run) => sum + Number(run.synced || 0), 0),
      changes: result.runs.flatMap((run) => run.core_change_ids ?? []),
      failed_accounts: result.failed_accounts,
    };
  }
  const accounts = (await port.activeAccounts()).filter((item) => !account || item.account_id === account);
  const runs = await port.recentRuns(account, 5);
  return {
    accounts: accounts.map(({ account_id, provider, email_address, last_synced_at, last_error }) => ({ account_id, provider, email_address, last_synced_at, last_error })),
    recent_runs: runs.map((run) => ({
      status: run.status,
      completed_at: run.completed_at,
      error: run.error,
      found: run.result.total_found,
      changes: (run.result.core_change_ids ?? []).length,
    })),
    today: await mailToday(store, todayIso()),
  };
}
