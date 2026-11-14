import {
  DOC_KIND,
  EVENT_KIND,
  JOB_FROZEN,
  JOB_ORDER,
  JOB_STATUS,
  MEMORY_KIND,
  TYPE_LABEL,
  addDays,
  brief,
  dayOf,
  isRecordType,
  label,
  plain,
  stable,
} from "./labels";
import type {
  ChangeView,
  CoreContext,
  CoreStore,
  EventKind,
  JobStatus,
  Json,
  PlainRecord,
  RecordType,
  StoredRecord,
} from "./types";
import { CoreError } from "./types";

type Args = Record<string, unknown>;

const recordType = (value: unknown): RecordType => {
  if (!isRecordType(value)) throw new CoreError("type 只能是 profile / memory / job / event / doc");
  return value;
};

const numberArg = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CoreError(`${name} 要是数字`);
  return value;
};

const objectArg = (value: unknown, name: string): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CoreError(`${name} 要是对象`);
  return { ...(value as Json) };
};

const oneOf = (value: unknown, allowed: Record<string, string>, name: string): void => {
  if (value !== undefined && value !== null && (typeof value !== "string" || !(value in allowed))) {
    throw new CoreError(`${name} 只能是 ${Object.keys(allowed).join(", ")}`);
  }
};

const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");

export const RESUME_TEMPLATE: Record<string, string> = { classic: "经典", clear: "清晰", kami: "留白", compact: "紧凑" };
export const RESUME_FONT: Record<string, string> = { sans: "黑体", serif: "宋体", kai: "楷体" };
/** Old docs carry doc.template; still accepted on save until the editor writes style. */
export const LEGACY_TEMPLATE: Record<string, Json> = {
  single: { template: "clear" },
  compact: { template: "compact" },
  photo: { template: "clear", photo: true },
};
export const STYLE_RANGE: Record<string, [number, number]> = {
  bodySize: [8, 14], lineHeight: [1.0, 2.0], sectionGap: [0, 30], itemGap: [0, 20],
};
export const MARGIN_RANGE: [number, number] = [3, 30];
export const STYLE_KEYS = ["template", "font", ...Object.keys(STYLE_RANGE), "margin", "accent", "photo", "logo"];
/** 经历性质：简历上全职和实习分节写、全日制和非全日制要写明。 */
export const MEMORY_MODE: Record<string, string[]> = { experience: ["全职", "实习", "兼职"], education: ["全日制", "非全日制"] };
export const MEMORY_SOURCE: Record<string, string> = { user: "用户说的", resume: "用户简历原文", agent: "Agent 推断" };
export const USER_ACTOR = "你";
export const MAIL_ACTOR = "邮箱";
export const REVIEW_QUESTION_KEYS = ["question", "answer", "reflection", "reaction"];
export const ASK_FIELDS = ["old", "why", "question"];

const isPlainObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fmt = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** doc.style: unknown keys and out-of-range values are errors, never clamped. Mirrors Python check_style. */
export function checkStyle(style: unknown): void {
  if (!isPlainObject(style)) throw new CoreError("doc.style 要是对象");
  const unknown = Object.keys(style).filter((key) => !STYLE_KEYS.includes(key)).sort();
  if (unknown.length) throw new CoreError(`doc.style 没有 ${unknown.join(", ")}；可用：${STYLE_KEYS.join(", ")}`);
  const number = (key: string, value: unknown, low: number, high: number) => {
    if (!isNumber(value) || value < low || value > high) {
      // Python formats float bounds (1.0–2.0) and int bounds (8–14) differently.
      const show = (bound: number) => (key === "lineHeight" ? fmt(bound) : String(bound));
      throw new CoreError(`doc.style.${key} 要在 ${show(low)}–${show(high)} 之间`);
    }
  };
  for (const [key, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue;
    if (key === "template" && !(typeof value === "string" && value in RESUME_TEMPLATE)) {
      throw new CoreError(`doc.style.template 只能是 ${Object.keys(RESUME_TEMPLATE).join(", ")}`);
    }
    if (key === "font" && !(typeof value === "string" && value in RESUME_FONT)) {
      throw new CoreError(`doc.style.font 只能是 ${Object.keys(RESUME_FONT).join(", ")}`);
    }
    if (key in STYLE_RANGE) number(key, value, ...STYLE_RANGE[key]);
    if (key === "margin") {
      if (!isPlainObject(value) || Object.keys(value).some((side) => !["top", "right", "bottom", "left"].includes(side))) {
        throw new CoreError("doc.style.margin 是 {top, right, bottom, left}，单位 mm");
      }
      for (const [side, mm] of Object.entries(value)) number(`margin.${side}`, mm, ...MARGIN_RANGE);
    }
    if (key === "accent" && !(typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value))) {
      throw new CoreError("doc.style.accent 要是 #RRGGBB");
    }
    if (key === "photo" && typeof value !== "boolean") throw new CoreError("doc.style.photo 是 true / false");
    if (key === "logo" && !(typeof value === "string" && value && !/[\\/]/.test(value) && value !== "." && value !== "..")) {
      throw new CoreError("doc.style.logo 是上传（POST /api/files）返回的文件名");
    }
  }
}

/** doc.questions（面试复盘的题）：数组，每项 {question, answer, reflection, reaction} 都是字符串。 */
export function checkQuestions(questions: unknown): void {
  if (!Array.isArray(questions) || questions.length > 60) throw new CoreError("doc.questions 要是数组，最多 60 道题");
  questions.forEach((item, index) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !REVIEW_QUESTION_KEYS.includes(key))) {
      throw new CoreError(`doc.questions[${index}] 只能有 ${REVIEW_QUESTION_KEYS.join(", ")}`);
    }
    if (!Object.values(item).every((value) => typeof value === "string")) {
      throw new CoreError(`doc.questions[${index}] 的值要是字符串`);
    }
  });
}

/** job.tags：最多 12 个不重复的短词，每个 1–20 字，前后不带空格。 */
export function checkTags(value: unknown, field = "job.tags"): void {
  // Python reuses check_tags for auto_tags with the job.tags wording; keep that text.
  void field;
  if (!Array.isArray(value) || value.length > 12) throw new CoreError("job.tags 要是数组，最多 12 个");
  for (const tag of value) {
    if (typeof tag !== "string" || [...tag].length < 1 || [...tag].length > 20 || tag.trim() !== tag) {
      throw new CoreError("job.tags 的每个标签是 1–20 字的字符串，前后不带空格");
    }
  }
  if (new Set(value).size !== value.length) throw new CoreError("job.tags 有重复标签");
}

/** doc.pending_asks（改写时追问成果、还没回答的句子）：最多 3 项，每项 {old, why, question} 都是字符串。 */
export function checkAsks(asks: unknown): void {
  if (!Array.isArray(asks) || asks.length > 3) throw new CoreError("doc.pending_asks 要是数组，最多 3 项");
  asks.forEach((item, index) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !ASK_FIELDS.includes(key))
      || !Object.values(item).every((value) => typeof value === "string")) {
      throw new CoreError(`doc.pending_asks[${index}] 只能有 ${ASK_FIELDS.join(", ")}，值是字符串`);
    }
  });
}

/**
 * 把 Agent 自动标签并进 job.tags：用户手打的（不在旧 auto_tags 里的）一个不动，
 * 用户删过的（tags_muted）不再加回。Mirrors Python merge_auto_tags.
 */
export function mergeAutoTags(prev: Json | null | undefined, auto: string[]): { tags: string[] | null; auto_tags: string[] | null } {
  const before = prev ?? {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : []);
  const oldAuto = strings(before.auto_tags);
  const mine = strings(before.tags).filter((tag) => !oldAuto.includes(tag));
  const muted = new Set(strings(before.tags_muted));
  const fresh = [...new Set(auto)].filter((tag) => !muted.has(tag) && !mine.includes(tag)).slice(0, Math.max(0, 12 - mine.length));
  const tags = [...mine, ...fresh];
  return { tags: tags.length ? tags : null, auto_tags: fresh.length ? fresh : null };
}

/** 库里已有的岗位标签，用得多的在前，给模型当词表。 */
export async function knownTags(store: CoreStore): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const job of await store.all("job")) {
    for (const tag of Array.isArray(job.tags) ? job.tags : []) {
      if (typeof tag === "string") counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  // Stable sort by count desc keeps first-seen order on ties, like Python sorted().
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
}

function isIsoDateTime(value: string): boolean {
  // Python datetime.fromisoformat: YYYY-MM-DD[(T| )HH[:MM[:SS[.ffffff]]][offset]]
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match) return false;
  const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
    && Number(hh) < 24 && Number(mm) < 60 && Number(ss) < 60;
}

async function checkRecord(type: RecordType, data: Json, creating: boolean, store: CoreStore): Promise<void> {
  if (type === "job") {
    oneOf(data.status, JOB_STATUS, "job.status");
    if (creating && !stringValue(data.company) && !stringValue(data.title)) {
      throw new CoreError("岗位至少要有 company 或 title");
    }
    if (data.tags !== undefined && data.tags !== null) checkTags(data.tags);
    if (data.auto_tags !== undefined && data.auto_tags !== null) checkTags(data.auto_tags, "job.auto_tags");
    const muted = data.tags_muted;
    if (muted !== undefined && muted !== null
      && (!Array.isArray(muted) || muted.length > 100 || !muted.every((tag) => typeof tag === "string" && tag))) {
      throw new CoreError("job.tags_muted 要是非空字符串数组，最多 100 个");
    }
  } else if (type === "event") {
    oneOf(data.kind, EVENT_KIND, "event.kind");
    if (creating && !stringValue(data.title)) throw new CoreError("事项要有 title");
    if (data.at !== undefined && data.at !== null && data.at !== "" && !(typeof data.at === "string" && isIsoDateTime(data.at))) {
      throw new CoreError("event.at 要是 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM");
    }
    if (data.done !== undefined && data.done !== null && typeof data.done !== "boolean") {
      throw new CoreError("event.done 只能是 true 或 false");
    }
  } else if (type === "doc") {
    oneOf(data.kind, DOC_KIND, "doc.kind");
    oneOf(data.template, Object.fromEntries(Object.keys(LEGACY_TEMPLATE).map((key) => [key, key])), "doc.template");
    if (data.style !== undefined && data.style !== null) checkStyle(data.style);
    if (data.questions !== undefined && data.questions !== null) checkQuestions(data.questions);
    if (data.pending_asks !== undefined && data.pending_asks !== null) checkAsks(data.pending_asks);
    if (creating && !stringValue(data.kind)) throw new CoreError("文档要有 kind");
  } else if (type === "memory") {
    oneOf(data.kind, MEMORY_KIND, "memory.kind");
    if (creating && !stringValue(data.title) && !stringValue(data.body)) throw new CoreError("记忆要有 title 或 body");
    if (data.said_at && !(typeof data.said_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.said_at))) {
      throw new CoreError("memory.said_at 是 YYYY-MM-DD");
    }
    oneOf(data.source, MEMORY_SOURCE, "memory.source");
    if (data.confirmed !== undefined && data.confirmed !== null && typeof data.confirmed !== "boolean") {
      throw new CoreError("memory.confirmed 只能是 true 或 false");
    }
    if (data.mode !== undefined && data.mode !== null) {
      const allowed = MEMORY_MODE[stringValue(data.kind)] ?? Object.values(MEMORY_MODE).flat();
      if (typeof data.mode !== "string" || !allowed.includes(data.mode)) {
        throw new CoreError(`memory.mode 只能是 ${allowed.join("/")}`);
      }
    }
  }
  if (data.job_id !== undefined && data.job_id !== null) {
    if (typeof data.job_id !== "number" || !(await store.get("job", data.job_id))) {
      throw new CoreError(`岗位 #${String(data.job_id)} 不存在`, "not_found");
    }
  }
}

export function jobUrlKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return "";
    const path = url.pathname.replace(/\/+$/, "");
    // BOSS 链接里的 lid、securityId 每次打开都不一样，按 job_detail 里的岗位编号认；小红书按笔记编号认。
    const boss = host.endsWith("zhipin.com") ? /job_detail.([0-9A-Za-z_~-]+)/.exec(path) : null;
    if (boss) return `boss:${boss[1]}`;
    const xhs = host.endsWith("xiaohongshu.com") ? /(?:explore|item).([0-9A-Za-z]+)/.exec(path) : null;
    if (xhs) return `xhs:${xhs[1]}`;
    const tracking: Record<string, true> = {
      lid: true, securityid: true, ka: true, spm: true, from: true, share: true,
      sessionid: true, xsec_token: true, xsec_source: true, share_from_user_hidden: true,
    };
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !tracking[key.toLowerCase()])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    return host + path + (query ? `?${query}` : "");
  } catch {
    return "";
  }
}

export async function findJobByUrl(store: CoreStore, url: unknown): Promise<StoredRecord | null> {
  const key = jobUrlKey(url);
  if (!key) return null;
  return (await store.all("job")).find((job) => jobUrlKey(job.url) === key) ?? null;
}

/** 重复存同一个岗位：只补原来空着的字段，JD 更长才换；不动投递状态。 */
export function mergeSavedJob(existing: Json, data: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "status" || key === "applied_at" || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    const old = existing[key];
    if (old === null || old === undefined || old === "" || (Array.isArray(old) && !old.length)) out[key] = value;
    else if (key === "jd" && String(value).length > String(old).length) out[key] = value;
    else if ((key === "tags" || key === "auto_tags") && stable(value) !== stable(old)) out[key] = value;
  }
  return out;
}

export function statusMoveError(current: JobStatus | undefined, next: JobStatus): string | null {
  if (next === current) return null;
  if (current && JOB_FROZEN.includes(current)) {
    return `岗位已是 ${current}，只有用户能改回其他状态；请让用户在岗位页手动改`;
  }
  if (next === "rejected" || next === "closed" || !current || !JOB_ORDER.includes(current) || !JOB_ORDER.includes(next)) {
    return null;
  }
  if (JOB_ORDER.indexOf(next) < JOB_ORDER.indexOf(current)) {
    return `岗位状态不能从 ${current} 回退到 ${next}；回退只有用户能做`;
  }
  return null;
}

async function logChange(
  store: CoreStore,
  data: { actor: string; summary: string; type: RecordType; record_id: number; before: PlainRecord | null; after: PlainRecord | null; now: string },
): Promise<number> {
  const last = await store.lastChange();
  if (
    last
    && last.before !== null
    && last.after !== null
    && !last.undone_at
    && last.actor === data.actor
    && last.summary === data.summary
    && last.type === data.type
    && last.record_id === data.record_id
    && Date.parse(data.now) - Date.parse(last.at) < 600_000
  ) {
    await store.updateChange(last.id, { at: data.now, after: data.after });
    return last.id;
  }
  return (await store.addChange({
    at: data.now,
    actor: data.actor,
    summary: data.summary,
    type: data.type,
    record_id: data.record_id,
    before: data.before,
    after: data.after,
  }));
}

export type SaveResult = {
  record: StoredRecord;
  change_id: number | null;
  existed: boolean;
  open_events?: number;
};

export type SaveOptions = {
  /** Memories split out of the user's own resume: source=resume, confirmed=true (Python from_resume). */
  fromResume?: boolean;
};

/**
 * Resume docs keep doc.resume as the source of truth and derive body from it
 * (Python `_with_resume`). The resume model lives in the resume domain; it
 * registers itself here so save stays the single write path. Until it does,
 * resume docs are stored as given.
 */
export type ResumeDocNormalizer = (data: Json, existingKind: string | undefined) => Json;
let resumeDocNormalizer: ResumeDocNormalizer | null = null;
export function setResumeDocNormalizer(fn: ResumeDocNormalizer | null): void {
  resumeDocNormalizer = fn;
}

/** All-or-nothing: the record write and its change-log row commit together. */
export function saveRecord(store: CoreStore, args: Args, ctx: CoreContext, options: SaveOptions = {}): Promise<SaveResult> {
  return store.transaction(() => saveRecordUnsafe(store, args, ctx, options));
}

async function saveRecordUnsafe(store: CoreStore, args: Args, ctx: CoreContext, options: SaveOptions): Promise<SaveResult> {
  const type = recordType(args.type);
  let data = objectArg(args.data ?? {}, "data");
  let id = args.id === undefined || args.id === null ? undefined : numberArg(args.id, "id");

  if (type === "profile" && id === undefined) {
    const existing = await store.first("profile");
    if (existing) id = existing.id;
  }

  let existed = false;
  if (type === "job" && id === undefined && data.url) {
    const previous = await findJobByUrl(store, data.url);
    if (previous) {
      existed = true;
      id = previous.id;
      data = mergeSavedJob(previous, data);
      if (!Object.keys(data).length) return { record: previous, change_id: null, existed: true };
    }
  }

  await checkRecord(type, data, id === undefined, store);

  if (type === "memory" && options.fromResume) {
    data = { ...data, source: "resume", confirmed: true };
  } else if (type === "memory") {
    if (ctx.actor !== USER_ACTOR) {
      if (data.confirmed === true) throw new CoreError("只有用户能确认记忆：Agent 存的记忆是待确认", "forbidden");
      if (data.source === "user") throw new CoreError("memory.source 不能由 Agent 记成 user", "forbidden");
    }
    if (id === undefined) {
      data = { source: ctx.actor === USER_ACTOR ? "user" : "agent", confirmed: ctx.actor === USER_ACTOR, ...data };
    }
  }

  const existing = id !== undefined ? (await store.get(type, id)) : null;
  if (type === "doc" && resumeDocNormalizer) {
    data = resumeDocNormalizer(data, typeof existing?.kind === "string" ? existing.kind : undefined);
  }
  const verb = type === "event" && data.done === true && id !== undefined ? "完成" : id === undefined ? "新建" : "更新";
  const statusNote = type === "job" && id !== undefined && typeof data.status === "string"
    ? `：${JOB_STATUS[data.status as JobStatus]}`
    : "";
  if (
    type === "job"
    && data.status === "applied"
    && !data.applied_at
    && !(existing && existing.applied_at)
  ) {
    data.applied_at = ctx.today;
  }
  if (type === "job" && id !== undefined && typeof data.status === "string" && ctx.actor !== USER_ACTOR) {
    const error = statusMoveError(existing?.status as JobStatus | undefined, data.status as JobStatus);
    if (error) throw new CoreError(error, "forbidden");
  }
  if (type === "job" && id === undefined) data = { status: "saved", ...data };

  const preview = {
    ...(existing ?? {}),
    ...data,
    type,
    id: id ?? 0,
  } as StoredRecord;
  let openEvents = 0;
  if (type === "job" && id !== undefined && (data.status === "rejected" || data.status === "closed")) {
    openEvents = (await store.all("event", id)).filter((event) => !event.done).length;
  }
  const note = openEvents ? `，还有 ${openEvents} 件未完成事项` : "";
  const summary = `${verb}${TYPE_LABEL[type]}「${label(preview)}」${statusNote}${note}`;
  if (id !== undefined && !existing) throw new CoreError(`${type} #${id} 不存在`, "not_found");
  const before = plain(existing);
  const jobId = typeof data.job_id === "number" || data.job_id === null
    ? (data.job_id as number | null)
    : existing?.job_id ?? null;
  const record = await store.put(type, data, { id, jobId, now: ctx.now, createdAt: existing?.created_at });
  const changeId = await logChange(store, {
    actor: ctx.actor,
    summary,
    type,
    record_id: record.id,
    before,
    after: plain(record),
    now: ctx.now,
  });
  return { record, change_id: changeId, existed, ...(openEvents ? { open_events: openEvents } : {}) };
}

export async function getRecord(store: CoreStore, args: Args): Promise<{ record: StoredRecord | null; events?: StoredRecord[]; docs?: StoredRecord[] }> {
  const type = recordType(args.type);
  const record = type === "profile" ? (await store.first("profile")) : (await store.get(type, numberArg(args.id, "id")));
  if (!record) {
    if (type === "profile") return { record: null };
    throw new CoreError(`${type} #${String(args.id)} 不存在`, "not_found");
  }
  if (type === "job") {
    return {
      record,
      events: (await store.all("event", record.id)).map(brief),
      docs: (await store.all("doc", record.id)).map(brief),
    };
  }
  return { record };
}

export async function listRecords(store: CoreStore, args: Args): Promise<{ total: number; items: Array<StoredRecord & { label: string }> }> {
  const type = recordType(args.type);
  let items = await store.all(type);
  if (typeof args.status === "string" && args.status) items = items.filter((item) => item.status === args.status);
  if (typeof args.kind === "string" && args.kind) items = items.filter((item) => item.kind === args.kind);
  if (typeof args.job_id === "number") items = items.filter((item) => item.job_id === args.job_id);
  if (typeof args.done === "boolean") items = items.filter((item) => Boolean(item.done) === args.done);
  if (typeof args.tag === "string" && args.tag) {
    items = items.filter((item) => Array.isArray(item.tags) && item.tags.includes(args.tag));
  }
  if (type === "event") {
    items = [...items].sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)) || String(a.at ?? "9999").localeCompare(String(b.at ?? "9999")));
  }
  const limit = Math.max(1, Math.min(500, typeof args.limit === "number" ? args.limit : 50));
  const full = args.full === true;
  return { total: items.length, items: items.slice(0, limit).map((item) => (full ? { ...item, label: label(item) } : brief(item))) };
}

/** All-or-nothing: the record write and its change-log row commit together. */
export function deleteRecord(store: CoreStore, args: Args, ctx: CoreContext): Promise<{ change_id: number }> {
  return store.transaction(() => deleteRecordUnsafe(store, args, ctx));
}

async function deleteRecordUnsafe(store: CoreStore, args: Args, ctx: CoreContext): Promise<{ change_id: number }> {
  const type = recordType(args.type);
  const id = numberArg(args.id, "id");
  const record = await store.get(type, id);
  if (!record) throw new CoreError(`${type} #${id} 不存在`, "not_found");
  await store.remove(type, id);
  const changeId = await logChange(store, {
    actor: ctx.actor,
    summary: `删除${TYPE_LABEL[type]}「${label(record)}」`,
    type,
    record_id: id,
    before: plain(record),
    after: null,
    now: ctx.now,
  });
  return { change_id: changeId };
}

/** All-or-nothing: the record write and its change-log row commit together. */
export function undoChange(store: CoreStore, args: Args, ctx: CoreContext): Promise<{ undone: number; summary: string; actor: string }> {
  return store.transaction(() => undoChangeUnsafe(store, args, ctx));
}

async function undoChangeUnsafe(store: CoreStore, args: Args, ctx: CoreContext): Promise<{ undone: number; summary: string; actor: string }> {
  const changeId = numberArg(args.change_id, "change_id");
  const row = await store.getChange(changeId);
  if (!row) throw new CoreError(`改动 #${changeId} 不存在`, "not_found");
  if (row.undone_at) throw new CoreError("这条改动已经撤销过了", "conflict");
  const current = await store.get(row.type, row.record_id);
  if (stable(plain(current)) !== stable(row.after)) {
    throw new CoreError("这条记录在这次改动之后又被改过，撤销会盖掉后面的改动；请先撤销更新的那条", "conflict");
  }
  if (row.before === null) {
    await store.remove(row.type, row.record_id);
  } else {
    const { job_id: jobId = null, ...data } = row.before;
    await store.put(row.type, data, {
      id: row.record_id,
      jobId: typeof jobId === "number" || jobId === null ? jobId : null,
      now: ctx.now,
      createdAt: current?.created_at,
      replace: true,
      restore: true,
    });
  }
  await store.updateChange(changeId, { undone_at: ctx.now });
  return { undone: changeId, summary: row.summary, actor: ctx.actor };
}

export async function changesView(store: CoreStore, limit = 20): Promise<{ items: ChangeView[] }> {
  return {
    items: (await store.changes(Math.max(1, Math.min(200, limit)))).map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      summary: row.summary,
      type: row.type,
      record_id: row.record_id,
      created: row.before === null,
      deleted: row.after === null,
      undone_at: row.undone_at,
    })),
  };
}

export async function searchRecords(store: CoreStore, args: Args): Promise<{ items: Array<{ type: RecordType; id: number; label: string; snippet: string }> }> {
  if (typeof args.query !== "string" || !args.query) throw new CoreError("query 不能为空");
  const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { items: [] };
  const picked = Array.isArray(args.types) ? args.types.filter(isRecordType) : [];
  const types = picked.length ? picked : (["profile", "memory", "job", "event", "doc"] as RecordType[]);
  const limit = Math.max(1, Math.min(100, typeof args.limit === "number" ? args.limit : 20));
  const hits: Array<{ score: number; item: { type: RecordType; id: number; label: string; snippet: string } }> = [];
  for (const type of types) {
    for (const record of (await store.all(type))) {
      const raw = Object.entries(record)
        .filter(([key, value]) => !["id", "type", "created_at", "updated_at", "job_id"].includes(key) && value !== null && value !== "")
        .map(([, value]) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" ");
      const text = raw.toLowerCase();
      const score = terms.reduce((sum, term) => sum + text.split(term).length - 1, 0);
      if (!score) continue;
      const at = Math.max(0, text.indexOf(terms[0]));
      hits.push({
        score,
        item: {
          type,
          id: record.id,
          label: label(record),
          snippet: raw.slice(Math.max(0, at - 40), at + 80),
        },
      });
    }
  }
  return { items: hits.sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => hit.item) };
}

export type Overview = {
  today: string;
  stage: string;
  next_step: { title: string; why: string; link: string };
  todos: Record<"overdue" | "today" | "week" | "later" | "undated", Array<StoredRecord & { label: string; job_label?: string }>>;
  jobs: Record<JobStatus, number>;
  recent_changes: ChangeView[];
  mail: { today_changes: number; last_change_at: string | null };
};

/** 邮箱同步的每日进度：今天邮箱写了几条改动、最后一条是什么时候。 */
async function mailToday(store: CoreStore, today: string): Promise<Overview["mail"]> {
  if (store.changeStats) {
    const stats = await store.changeStats(MAIL_ACTOR, today);
    return { today_changes: stats.count, last_change_at: stats.last };
  }
  const rows = (await store.changes(1000)).filter((row) => row.actor === MAIL_ACTOR && row.at >= today);
  return { today_changes: rows.length, last_change_at: rows.reduce<string | null>((last, row) => (!last || row.at > last ? row.at : last), null) };
}

export async function overview(store: CoreStore, ctx: CoreContext): Promise<Overview> {
  const jobs = await store.all("job");
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const events = (await store.all("event"))
    .filter((event) => !event.done && !["rejected", "closed"].includes(String(jobsById.get(event.job_id ?? -1)?.status)))
    .map((event) => {
      const job = event.job_id !== null ? jobsById.get(event.job_id) : undefined;
      return job ? { ...event, job_label: label(job) } : event;
    })
    .sort((a, b) => String(a.at ?? "9999").localeCompare(String(b.at ?? "9999")));

  const todos: Overview["todos"] = { overdue: [], today: [], week: [], later: [], undated: [] };
  for (const event of events) {
    const day = dayOf(event.at);
    const bucket = !day
      ? "undated"
      : day < ctx.today
        ? "overdue"
        : day === ctx.today
          ? "today"
          : day <= addDays(ctx.today, 7)
            ? "week"
            : "later";
    todos[bucket].push(brief(event));
  }

  const statuses = Object.fromEntries(Object.keys(JOB_STATUS).map((status) => [status, [] as StoredRecord[]])) as Record<JobStatus, StoredRecord[]>;
  for (const job of jobs) {
    const status = job.status as JobStatus;
    if (statuses[status]) statuses[status].push(job);
  }
  const profile = await store.first("profile");
  const inferred = statuses.offer.length
    ? "offer"
    : statuses.interview.length
      ? "interviewing"
      : statuses.test.length
        ? "testing"
        : statuses.applied.length
          ? "applying"
          : jobs.length
            ? "preparing"
            : "not_started";
  const soon = [...todos.today, ...todos.week].filter((event) =>
    ["test", "interview", "deadline"].includes(String(event.kind))
    && (dayOf(event.at) ?? "9999") <= addDays(ctx.today, 2));
  const stale = statuses.applied.filter((job) => String(job.updated_at).slice(0, 10) <= addDays(ctx.today, -7));

  let nextStep: Overview["next_step"];
  if (todos.overdue.length) {
    const event = todos.overdue[0];
    nextStep = { title: `处理逾期的「${event.label}」`, why: `原定 ${String(event.at)}`, link: "/" };
  } else if (soon.length) {
    const event = soon[0];
    nextStep = {
      title: `准备「${event.label}」`,
      why: `${EVENT_KIND[event.kind as EventKind] ?? "事项"}在 ${String(event.at).replace("T", " ")}`,
      link: event.job_id ? `/jobs/${event.job_id}` : "/",
    };
  } else if (!profile?.name) {
    nextStep = { title: "先建档案", why: "填好基本信息和经历，简历和网申都从这里取", link: "/profile" };
  } else if (!(await store.all("doc")).some((doc) => doc.kind === "resume")) {
    nextStep = { title: "写一份简历", why: "从档案生成一份，再按岗位改", link: "/resume" };
  } else if (!jobs.length) {
    nextStep = { title: "存几个想投的岗位", why: "还没有岗位，OfferU 没法帮你安排", link: "/jobs" };
  } else if (statuses.saved.length) {
    const job = statuses.saved[statuses.saved.length - 1];
    nextStep = { title: `投递「${label(job)}」`, why: `还有 ${statuses.saved.length} 个岗位没投`, link: `/jobs/${job.id}` };
  } else if (stale.length) {
    const job = stale[0];
    nextStep = { title: `跟进「${label(job)}」`, why: "投递超过 7 天没有进展", link: `/jobs/${job.id}` };
  } else {
    nextStep = { title: "今天没有急事", why: "可以再找几个岗位，或者准备面试", link: "/jobs" };
  }

  return {
    today: ctx.today,
    stage: stringValue(profile?.stage) || inferred,
    next_step: nextStep,
    todos,
    jobs: Object.fromEntries(Object.keys(JOB_STATUS).map((status) => [status, statuses[status as JobStatus].length])) as Record<JobStatus, number>,
    recent_changes: (await changesView(store, 5)).items,
    mail: await mailToday(store, ctx.today),
  };
}
