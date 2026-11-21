// SQLite rows for Agent runs, in the same offeru.db file and on the same
// connection / transaction queue as SqliteCoreStore (user decision
// 2026-11-15). All rules live in @offeru/core (AgentRunState,
// AgentConversations); this adapter only stores JSON rows.
//
// Migration: five new tables, created with IF NOT EXISTS. The Python core
// store only reads records/changes, so it keeps working on the same file.
// (The legacy SQLAlchemy layer kept its own agent_runs in djm.db; that file
// is never touched here.)

import type {
  AgentInputRequest,
  AgentRun,
  AgentRunEvent,
  AgentRunStore,
  ChatMessage,
  Conversation,
} from "@offeru/core";
import { CoreError } from "@offeru/core";

import type { SqliteCoreStore } from "./store";

export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL DEFAULT '', conversation_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_runs_conversation ON agent_runs(conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS agent_runs_task ON agent_runs(task_id, updated_at);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status);
CREATE TABLE IF NOT EXISTS agent_run_events (
  event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
  timestamp TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id, sequence));
CREATE TABLE IF NOT EXISTS agent_input_requests (
  request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_input_requests_run ON agent_input_requests(run_id, status);
CREATE TABLE IF NOT EXISTS agent_sessions (
  run_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, messages TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_conversations_updated ON agent_conversations(updated_at);
`;

type DataRow = { data: string };

export class SqliteAgentRunStore implements AgentRunStore {
  private readonly db: SqliteCoreStore["db"];

  constructor(private readonly core: SqliteCoreStore) {
    this.db = core.db;
    this.db.exec(AGENT_SCHEMA);
  }

  async getRun(id: string): Promise<AgentRun | null> {
    const row = this.db.prepare("SELECT data FROM agent_runs WHERE id=?").get(id) as DataRow | undefined;
    return row ? JSON.parse(row.data) as AgentRun : null;
  }

  async putRun(run: AgentRun): Promise<void> {
    this.db.prepare(`INSERT INTO agent_runs(id, task_id, conversation_id, status, created_at, updated_at, data)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, conversation_id=excluded.conversation_id,
        status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`)
      .run(run.id, run.task_id || "", run.conversation_id || "", run.status, run.created_at, run.updated_at, JSON.stringify(run));
  }

  async listRuns(filter: { conversation_id?: string; task_id?: string; status?: string[]; limit: number }): Promise<AgentRun[]> {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filter.conversation_id) { where.push("conversation_id=?"); values.push(filter.conversation_id); }
    if (filter.task_id) { where.push("task_id=?"); values.push(filter.task_id); }
    if (filter.status?.length) { where.push(`status IN (${filter.status.map(() => "?").join(",")})`); values.push(...filter.status); }
    const sql = `SELECT data FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, rowid DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...values, filter.limit) as DataRow[]).map((row) => JSON.parse(row.data) as AgentRun);
  }

  async putEvent(event: AgentRunEvent): Promise<void> {
    try {
      this.db.prepare("INSERT INTO agent_run_events(event_id, run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?,?)")
        .run(event.event_id, event.run_id, event.sequence, event.type, event.timestamp, JSON.stringify(event.payload ?? {}));
    } catch (cause) {
      if (String((cause as Error)?.message || "").includes("UNIQUE")) throw new CoreError(`duplicate event sequence ${event.sequence}`, "conflict");
      throw cause;
    }
  }

  async listEvents(runId: string, afterSequence: number, limit: number): Promise<AgentRunEvent[]> {
    const rows = this.db.prepare("SELECT * FROM agent_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(runId, afterSequence, limit) as Array<Omit<AgentRunEvent, "payload"> & { payload: string }>;
    return rows.map((row) => ({
      event_id: row.event_id,
      run_id: row.run_id,
      sequence: Number(row.sequence),
      type: row.type,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload),
    }));
  }

  async getInputRequest(requestId: string): Promise<AgentInputRequest | null> {
    const row = this.db.prepare("SELECT data FROM agent_input_requests WHERE request_id=?").get(requestId) as DataRow | undefined;
    return row ? JSON.parse(row.data) as AgentInputRequest : null;
  }

  async putInputRequest(request: AgentInputRequest): Promise<void> {
    this.db.prepare(`INSERT INTO agent_input_requests(request_id, run_id, status, created_at, data) VALUES (?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET status=excluded.status, data=excluded.data`)
      .run(request.request_id, request.run_id, request.status, request.created_at, JSON.stringify(request));
  }

  async listInputRequests(runId: string): Promise<AgentInputRequest[]> {
    return (this.db.prepare("SELECT data FROM agent_input_requests WHERE run_id=? ORDER BY created_at, rowid").all(runId) as DataRow[])
      .map((row) => JSON.parse(row.data) as AgentInputRequest);
  }

  async getSession(runId: string): Promise<ChatMessage[] | null> {
    const row = this.db.prepare("SELECT messages FROM agent_sessions WHERE run_id=?").get(runId) as { messages: string } | undefined;
    return row ? JSON.parse(row.messages) as ChatMessage[] : null;
  }

  async putSession(runId: string, messages: ChatMessage[]): Promise<void> {
    this.db.prepare(`INSERT INTO agent_sessions(run_id, messages, updated_at) VALUES (?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at`)
      .run(runId, JSON.stringify(messages), new Date().toISOString());
  }

  async listConversations(): Promise<Conversation[]> {
    return (this.db.prepare("SELECT * FROM agent_conversations ORDER BY updated_at DESC").all() as Array<Omit<Conversation, "messages"> & { messages: string }>)
      .map((row) => ({ id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at, messages: JSON.parse(row.messages) }));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = this.db.prepare("SELECT * FROM agent_conversations WHERE id=?").get(id) as (Omit<Conversation, "messages"> & { messages: string }) | undefined;
    return row ? { id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at, messages: JSON.parse(row.messages) } : null;
  }

  async putConversation(conversation: Conversation): Promise<void> {
    this.db.prepare(`INSERT INTO agent_conversations(id, title, created_at, updated_at, messages) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, messages=excluded.messages`)
      .run(conversation.id, conversation.title, conversation.created_at, conversation.updated_at, JSON.stringify(conversation.messages));
  }

  async deleteConversation(id: string): Promise<boolean> {
    return Number(this.db.prepare("DELETE FROM agent_conversations WHERE id=?").run(id).changes) > 0;
  }

  /** Same queue as record writes: one connection, one writer at a time. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.core.transaction(fn);
  }
}
