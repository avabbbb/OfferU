// Agent run rows for the in-page backend, persisted in IndexedDB so a page reload keeps
// conversations and finished runs. Whole-state snapshots: run history in one browser is small.

import localforage from "localforage";
import { CoreError, type AgentRunStore } from "@offeru/core";

type Store = AgentRunStore;
type Run = NonNullable<Awaited<ReturnType<Store["getRun"]>>>;
type Event = Awaited<ReturnType<Store["listEvents"]>>[number];
type Request = NonNullable<Awaited<ReturnType<Store["getInputRequest"]>>>;
type Session = NonNullable<Awaited<ReturnType<Store["getSession"]>>>;
type Conversation = NonNullable<Awaited<ReturnType<Store["getConversation"]>>>;

interface State {
  runs: Record<string, Run>;
  events: Record<string, Event[]>;
  requests: Record<string, Request>;
  sessions: Record<string, Session>;
  conversations: Record<string, Conversation>;
}

const KEY = "agent-runs:v1";
const clone = <T>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
const empty = (): State => ({ runs: {}, events: {}, requests: {}, sessions: {}, conversations: {} });

export class IndexedDbAgentRunStore implements AgentRunStore {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly db: LocalForage;

  constructor(database = "offeru-local-agent") {
    this.db = localforage.createInstance({ name: database, storeName: "runs" });
  }

  private async s(): Promise<State> {
    if (this.state) return this.state;
    this.loading ??= this.db.getItem<State>(KEY).then((saved) => (this.state = saved && typeof saved === "object" ? { ...empty(), ...saved } : empty()));
    return this.loading;
  }

  private persist(): void {
    const snapshot = clone(this.state);
    this.writes = this.writes.then(() => this.db.setItem(KEY, snapshot).then(() => undefined)).catch(() => undefined);
  }

  async getRun(id: string) { return clone((await this.s()).runs[id] ?? null); }
  async putRun(run: Run) { (await this.s()).runs[run.id] = clone(run); this.persist(); }
  async listRuns(filter: { conversation_id?: string; task_id?: string; status?: string[]; limit: number }) {
    return Object.values((await this.s()).runs)
      .filter((run) => (!filter.conversation_id || run.conversation_id === filter.conversation_id)
        && (!filter.task_id || run.task_id === filter.task_id)
        && (!filter.status || filter.status.includes(run.status)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filter.limit)
      .map(clone);
  }
  async putEvent(event: Event) {
    const state = await this.s();
    const list = state.events[event.run_id] ?? [];
    if (list.some((item) => item.sequence === event.sequence)) throw new CoreError(`duplicate event sequence ${event.sequence}`, "conflict");
    list.push(clone(event));
    state.events[event.run_id] = list;
    this.persist();
  }
  async listEvents(runId: string, afterSequence: number, limit: number) {
    return ((await this.s()).events[runId] ?? []).filter((event) => event.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(clone);
  }
  async getInputRequest(id: string) { return clone((await this.s()).requests[id] ?? null); }
  async putInputRequest(request: Request) { (await this.s()).requests[request.request_id] = clone(request); this.persist(); }
  async listInputRequests(runId: string) { return Object.values((await this.s()).requests).filter((item) => item.run_id === runId).map(clone); }
  async getSession(runId: string) { return clone((await this.s()).sessions[runId] ?? null); }
  async putSession(runId: string, messages: Session) { (await this.s()).sessions[runId] = clone(messages); this.persist(); }
  async listConversations() { return Object.values((await this.s()).conversations).map(clone); }
  async getConversation(id: string) { return clone((await this.s()).conversations[id] ?? null); }
  async putConversation(conversation: Conversation) { (await this.s()).conversations[conversation.id] = clone(conversation); this.persist(); }
  async deleteConversation(id: string) {
    const state = await this.s();
    if (!(id in state.conversations)) return false;
    delete state.conversations[id];
    this.persist();
    return true;
  }

  /** Serialized, never nested. No rollback (same contract as MemoryAgentRunStore). */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Test helper: wait for pending IndexedDB writes. */
  flush(): Promise<void> { return this.writes; }
}
