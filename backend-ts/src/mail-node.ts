// Companion mailbox service: IMAP accounts (password = the provider's app
// password, kept 0600 in the data dir like the model keys), incremental UID
// sync, and write-back through core (applyFetchedMails → undoable changes with
// actor「邮箱」). Port of the IMAP half of services/email_sync.py; Gmail OAuth
// is not ported (see migration notes).

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CoreError,
  applyFetchedMails,
  isRelevantMail,
  parseMail,
  type CoreStore,
  type FetchedMail,
  type LlmClient,
  type MailAccountView,
  type MailRunView,
  type MailSyncCounts,
  type MailSyncPort,
} from "@offeru/core";

import { ImapConnection, ImapError, imapDate } from "./imap";

export const MAIL_ACCOUNTS_FILE = "mail-accounts.json";
export const MAIL_RUNS_FILE = "mail-runs.json";
export const MAX_MESSAGES_PER_SYNC = 500;

export const IMAP_PRESETS: Record<string, { host: string; port: number }> = {
  qq: { host: "imap.qq.com", port: 993 },
  "163": { host: "imap.163.com", port: 993 },
  "126": { host: "imap.126.com", port: 993 },
  gmail: { host: "imap.gmail.com", port: 993 },
  outlook: { host: "outlook.office365.com", port: 993 },
  foxmail: { host: "imap.qq.com", port: 993 },
};
const DOMAIN_PROVIDER: Record<string, string> = {
  "qq.com": "qq", "foxmail.com": "qq", "vip.qq.com": "qq", "163.com": "163", "126.com": "126",
  "gmail.com": "gmail", "outlook.com": "outlook", "hotmail.com": "outlook",
};

type Cursor = { type: "imap_uid"; uidvalidity: number; last_uid: number };
export type MailAccount = {
  account_id: string;
  provider: "imap";
  email_address: string;
  host: string;
  port: number;
  password: string;
  status: "active" | "error";
  sync_enabled: boolean;
  cursor: Cursor | null;
  last_synced_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
};
export type MailRun = {
  run_id: string;
  provider: string;
  account_id: string;
  status: "completed" | "failed";
  attempts: number;
  result: Partial<MailSyncCounts>;
  trace: Record<string, unknown>;
  error: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/** Python _resolve_imap_host. */
export function resolveImapHost(host: string, port: number | undefined, provider: string, email: string): { host: string; port: number } {
  const cleanHost = host.trim();
  const cleanPort = Number(port || 993);
  const key = provider.trim().toLowerCase();
  if (!cleanHost && IMAP_PRESETS[key]) return IMAP_PRESETS[key];
  if (!cleanHost && email.includes("@")) {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    if (DOMAIN_PROVIDER[domain]) return IMAP_PRESETS[DOMAIN_PROVIDER[domain]];
  }
  if (!cleanHost) throw new CoreError("无法确定 IMAP 服务器地址");
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) throw new CoreError("IMAP port 无效");
  return { host: cleanHost, port: cleanPort };
}

/** Public view of an account: never the password. */
export function accountPayload(account: MailAccount): Record<string, unknown> {
  return {
    account_id: account.account_id,
    provider: account.provider,
    email_address: account.email_address,
    host: account.host,
    port: account.port,
    auth_type: "password",
    scopes: ["imap:read"],
    status: account.status,
    sync_enabled: account.sync_enabled,
    cursor_type: account.cursor?.type ?? null,
    last_synced_at: account.last_synced_at,
    last_error: redact(account.last_error, account.password).slice(0, 500),
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

function redact(text: string, secret: string): string {
  return secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text;
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function readList<T>(path: string): T[] {
  try {
    const value = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export type ImapOpener = (host: string, port: number) => Promise<Pick<ImapConnection, "login" | "examineInbox" | "uidSearch" | "fetchRaw" | "logout">>;

export class NodeMailService {
  private readonly accountsPath: string;
  private readonly runsPath: string;

  constructor(dataDir: string, private readonly open: ImapOpener = (host, port) => ImapConnection.open(host, port), private readonly now = () => new Date()) {
    this.accountsPath = join(dataDir, MAIL_ACCOUNTS_FILE);
    this.runsPath = join(dataDir, MAIL_RUNS_FILE);
  }

  accounts(): MailAccount[] {
    return readList<MailAccount>(this.accountsPath);
  }

  runs(): MailRun[] {
    return readList<MailRun>(this.runsPath);
  }

  /** POST /api/email/imap-connect: verify login + read-only INBOX, then save (upsert by user@host). */
  async connect(input: { user?: unknown; password?: unknown; provider?: unknown; host?: unknown; port?: unknown }): Promise<Record<string, unknown>> {
    const user = String(input.user ?? "").trim();
    const password = String(input.password ?? "");
    if (!user) throw new CoreError("user 不能为空");
    if (user.length > 320) throw new CoreError("user 最长 320 个字符");
    if (!password.trim()) throw new CoreError("password 不能为空");
    if (password.length > 4000) throw new CoreError("password 最长 4000 个字符");
    const { host, port } = resolveImapHost(String(input.host ?? ""), input.port === undefined ? undefined : Number(input.port), String(input.provider ?? ""), user);
    const probe = await this.withConnection(host, port, user, password, (conn) => conn.examineInbox());
    if (!probe.uidvalidity) throw new CoreError("IMAP 服务器未返回 UIDVALIDITY");
    const stamp = this.now().toISOString();
    const accounts = this.accounts();
    let account = accounts.find((item) => item.email_address.toLowerCase() === user.toLowerCase() && item.host === host);
    if (account) {
      Object.assign(account, { port, password, status: "active", sync_enabled: true, last_error: "", updated_at: stamp });
    } else {
      account = {
        account_id: randomUUID().replace(/-/g, ""),
        provider: "imap",
        email_address: user,
        host,
        port,
        password,
        status: "active",
        sync_enabled: true,
        cursor: null,
        last_synced_at: null,
        last_error: "",
        created_at: stamp,
        updated_at: stamp,
      };
      accounts.push(account);
    }
    writePrivate(this.accountsPath, accounts);
    return accountPayload(account);
  }

  disconnect(accountId: string): { deleted: string } {
    const accounts = this.accounts();
    const next = accounts.filter((item) => item.account_id !== accountId);
    if (next.length === accounts.length) throw new CoreError("邮箱账号不存在", "not_found");
    writePrivate(this.accountsPath, next);
    return { deleted: accountId };
  }

  /** Python email_connection_status. */
  status(): Record<string, unknown> {
    const items = this.accounts().filter((item) => item.status === "active").map(accountPayload);
    const first = items[0];
    return {
      connected: items.length > 0,
      gmail_connected: false,
      has_refresh: false,
      imap_connected: items.length > 0,
      imap_host: first?.host ?? "",
      imap_user: first?.email_address ?? "",
      accounts: items,
    };
  }

  private async withConnection<T>(host: string, port: number, user: string, password: string, task: (conn: Awaited<ReturnType<ImapOpener>>) => Promise<T>): Promise<T> {
    let conn: Awaited<ReturnType<ImapOpener>> | null = null;
    try {
      conn = await this.open(host, port);
      await conn.login(user, password);
      return await task(conn);
    } catch (cause) {
      if (cause instanceof ImapError) throw new CoreError(redact(cause.message, password));
      throw cause;
    } finally {
      await conn?.logout().catch(() => undefined);
    }
  }

  /** Incremental UID fetch (Python _fetch_imap_delta_blocking): relevant mails + next cursor. */
  async fetchDelta(account: MailAccount): Promise<{ messages: FetchedMail[]; cursor: Cursor; recovered: boolean }> {
    return this.withConnection(account.host, account.port, account.email_address, account.password, async (conn) => {
      const { uidvalidity, uidnext } = await conn.examineInbox();
      if (!uidvalidity) throw new ImapError("IMAP 服务器未返回 UIDVALIDITY");
      const previous = account.cursor?.uidvalidity ?? 0;
      let lastUid = account.cursor?.last_uid ?? 0;
      const recovered = Boolean(previous && previous !== uidvalidity);
      if (recovered) lastUid = 0;
      const criteria = lastUid
        ? `UID ${lastUid + 1}:*`
        : `SINCE ${imapDate(new Date(this.now().getTime() - 30 * 86_400_000))}`;
      const uids = (await conn.uidSearch(criteria)).filter((uid) => uid > lastUid).sort((a, b) => a - b).slice(0, MAX_MESSAGES_PER_SYNC);
      const messages: FetchedMail[] = [];
      let high = lastUid;
      for (const uid of uids) {
        const parsed = parseMail(await conn.fetchRaw(uid));
        const item: FetchedMail = {
          provider_id: String(uid),
          message_id: parsed.message_id || `imap:${uidvalidity}:${uid}`,
          subject: parsed.subject,
          from: parsed.from,
          body: parsed.body,
          received_at: parsed.received_at,
        };
        if (isRelevantMail(item)) messages.push(item);
        high = Math.max(high, uid);
      }
      if (!uids.length && !lastUid) high = Math.max(0, uidnext - 1);
      return { messages, cursor: { type: "imap_uid", uidvalidity, last_uid: high }, recovered };
    });
  }

  /** Sync one or all active accounts and write back; one failed account does not stop the others. */
  async sync(store: CoreStore, llm: LlmClient | null, accountId: string | null): Promise<{ runs: Array<Partial<MailSyncCounts>>; failed_accounts: number }> {
    const accounts = this.accounts();
    const targets = accounts.filter((item) => item.status === "active" && item.sync_enabled && (!accountId || item.account_id === accountId));
    if (accountId && !targets.length) throw new CoreError("邮箱账号不存在", "not_found");
    if (!targets.length) throw new CoreError("还没有连接邮箱：先在设置里用 IMAP 授权码连接");
    const results: Array<Partial<MailSyncCounts>> = [];
    const runs = this.runs();
    let failed = 0;
    for (const account of targets) {
      const started = this.now().toISOString();
      const run: MailRun = {
        run_id: randomUUID().replace(/-/g, ""), provider: "imap", account_id: account.account_id, status: "completed", attempts: 1,
        result: {}, trace: {}, error: "", created_at: started, started_at: started, completed_at: null,
      };
      try {
        const delta = await this.fetchDelta(account);
        const counts = await applyFetchedMails(store, delta.messages, llm);
        run.result = counts;
        run.trace = { cursor_recovered: delta.recovered };
        account.cursor = delta.cursor;
        account.last_synced_at = this.now().toISOString();
        account.last_error = "";
        results.push(counts);
      } catch (cause) {
        failed += 1;
        run.status = "failed";
        run.error = redact(cause instanceof Error ? cause.message : String(cause), account.password).slice(0, 500);
        account.last_error = run.error;
        results.push({ total_found: 0, synced: 0, core_change_ids: [] });
      }
      account.updated_at = this.now().toISOString();
      run.completed_at = this.now().toISOString();
      runs.unshift(run);
    }
    writePrivate(this.accountsPath, accounts);
    writePrivate(this.runsPath, runs.slice(0, 100));
    return { runs: results, failed_accounts: failed };
  }

  /** core MailSyncPort for the `email_sync` tool shape. */
  port(store: CoreStore, llm: () => LlmClient | null): MailSyncPort {
    return {
      activeAccounts: async (): Promise<MailAccountView[]> => this.accounts()
        .filter((item) => item.status === "active")
        .map(({ account_id, provider, email_address, last_synced_at, last_error }) => ({ account_id, provider, email_address, last_synced_at, last_error })),
      recentRuns: async (accountId, limit): Promise<MailRunView[]> => this.runs()
        .filter((run) => !accountId || run.account_id === accountId)
        .slice(0, limit)
        .map(({ status, completed_at, error, result }) => ({ status, completed_at, error, result })),
      sync: (accountId) => this.sync(store, llm(), accountId),
    };
  }
}

export function mailDataDir(databasePath: string): string {
  return dirname(databasePath);
}
