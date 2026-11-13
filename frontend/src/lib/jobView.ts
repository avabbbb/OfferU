import { JOB_STATUS, type Job, type JobStatus } from "@/lib/core";

// 岗位多维表的视图逻辑：筛选、搜索、排序、分组，以及每个视图的配置（存本机 localStorage）。
// 纯函数，表格 / 看板 / 甘特共用同一份结果。

export type FieldKey = "company" | "title" | "status" | "city" | "hire_type" | "tags" | "score" | "applied_at" | "created_at";
export type FieldType = "text" | "select" | "tags" | "number" | "date";

export const FIELDS: Record<FieldKey, { name: string; type: FieldType }> = {
  company: { name: "公司", type: "text" },
  title: { name: "岗位", type: "text" },
  status: { name: "状态", type: "select" },
  city: { name: "城市", type: "select" },
  hire_type: { name: "招聘类型", type: "select" },
  tags: { name: "标签", type: "tags" },
  score: { name: "评分", type: "number" },
  applied_at: { name: "投递日", type: "date" },
  created_at: { name: "收藏日", type: "date" },
};
export const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[];
/** 主字段：冻结在最左、不能隐藏。 */
export const PRIMARY: FieldKey = "company";
export const STATUS_ORDER = Object.keys(JOB_STATUS) as JobStatus[];
/** 状态胶囊配色，表格 / 看板 / 甘特共用。 */
export const STATUS_TONE: Record<JobStatus, "gray" | "blue" | "yellow" | "orange" | "green" | "red"> = {
  saved: "gray", applied: "blue", test: "yellow", interview: "orange", offer: "green", rejected: "red", closed: "gray",
};
// 状态下拉的分组（照 Notion：待办 / 进行中 / 已完成）。
export const STATUS_GROUPS: Array<[string, JobStatus[]]> = [
  ["待办", ["saved"]], ["进行中", ["applied", "test", "interview"]], ["已完成", ["offer", "rejected", "closed"]],
];

export type Op = "is" | "isNot" | "contains" | "notContains" | "empty" | "notEmpty" | "gt" | "lt";
export const OPS: Record<FieldType, Op[]> = {
  text: ["contains", "notContains", "is", "isNot", "empty", "notEmpty"],
  select: ["is", "isNot", "empty", "notEmpty"],
  tags: ["contains", "notContains", "empty", "notEmpty"],
  number: ["is", "gt", "lt", "empty", "notEmpty"],
  date: ["is", "gt", "lt", "empty", "notEmpty"],
};
export const OP_NAME: Record<Op, string> = {
  is: "是", isNot: "不是", contains: "包含", notContains: "不包含", empty: "为空", notEmpty: "不为空", gt: "大于", lt: "小于",
};

/** select / tags 的 value 是「任一」；text / number / date 只看 value[0]。没填值的条件不生效（同飞书）。 */
export type Condition = { field: FieldKey; op: Op; value: string[] };
export type Filter = { mode: "and" | "or"; conditions: Condition[] };
export type Sort = { field: FieldKey; desc: boolean };

type Cell = string | number | string[] | undefined;

/** 岗位在某个字段上的值；空串、空数组、null 都算空。日期只取 YYYY-MM-DD。 */
export function cell(job: Job, field: FieldKey): Cell {
  switch (field) {
    case "hire_type": return job.posting?.hire_type || undefined;
    case "tags": return job.tags?.length ? job.tags : undefined;
    case "score": return job.score ?? undefined;
    case "applied_at":
    case "created_at": return job[field]?.slice(0, 10) || undefined;
    default: return job[field] || undefined;
  }
}

const lower = (s: string) => s.toLowerCase();

export function matches(job: Job, c: Condition): boolean {
  const v = cell(job, c.field);
  if (c.op === "empty") return v === undefined;
  if (c.op === "notEmpty") return v !== undefined;
  const want = c.value.map((s) => s.trim()).filter(Boolean);
  if (!want.length) return true;
  const type = FIELDS[c.field].type;
  if (type === "number") {
    const b = Number(want[0]);
    if (Number.isNaN(b)) return true;
    if (v === undefined) return false;
    const a = Number(v);
    return c.op === "gt" ? a > b : c.op === "lt" ? a < b : a === b;
  }
  if (type === "date") {
    if (v === undefined) return false;
    const a = String(v);
    const b = want[0];
    return c.op === "gt" ? a > b : c.op === "lt" ? a < b : a === b;
  }
  const have = (Array.isArray(v) ? v : v === undefined ? [] : [String(v)]).map(lower);
  const hit = type === "text"
    ? (c.op === "is" || c.op === "isNot" ? have[0] === lower(want[0]) : have.some((h) => h.includes(lower(want[0]))))
    : want.some((w) => have.includes(lower(w)));
  return c.op === "isNot" || c.op === "notContains" ? !hit : hit;
}

export function passes(job: Job, filter: Filter): boolean {
  if (!filter.conditions.length) return true;
  return filter.mode === "or" ? filter.conditions.some((c) => matches(job, c)) : filter.conditions.every((c) => matches(job, c));
}

/** 顶栏搜索：公司、岗位、城市、招聘类型、备注、标签里有就算，不分大小写。 */
export function searchHit(job: Job, query: string): boolean {
  const q = lower(query.trim());
  if (!q) return true;
  return [job.company, job.title, job.city, job.posting?.hire_type, job.notes, ...(job.tags ?? [])].some((x) => !!x && lower(x).includes(q));
}

function compareValues(field: FieldKey, a: string | number, b: string | number): number {
  if (field === "status") return STATUS_ORDER.indexOf(a as JobStatus) - STATUS_ORDER.indexOf(b as JobStatus);
  if (FIELDS[field].type === "number") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "zh");
}

/** 多级排序；空值不论升降序都排最后。原数组不动，同值保持原顺序。 */
export function sortJobs(jobs: Job[], sorts: Sort[]): Job[] {
  const key = (v: Cell) => (Array.isArray(v) ? v.join(",") : v);
  return [...jobs].sort((x, y) => {
    for (const s of sorts) {
      const a = key(cell(x, s.field));
      const b = key(cell(y, s.field));
      if (a === undefined || b === undefined) {
        if (a !== b) return a === undefined ? 1 : -1;
        continue;
      }
      const d = compareValues(s.field, a, b);
      if (d) return s.desc ? -d : d;
    }
    return 0;
  });
}

export function applyView(jobs: Job[], view: Pick<ViewConfig, "filter" | "sort">, search = ""): Job[] {
  return sortJobs(jobs.filter((job) => searchHit(job, search) && passes(job, view.filter)), view.sort);
}

export type Group = { key: string; field: FieldKey; value: string | null; label: string; jobs: Job[]; children: Group[] };

export function valueLabel(field: FieldKey, value: string): string {
  return field === "status" ? JOB_STATUS[value as JobStatus] ?? value : value;
}

/** 按字段逐层分组（最多两层由调用方控制）。标签字段一个岗位会出现在它的每个标签组里；空值组放最后。组内保持传入顺序。 */
export function groupJobs(jobs: Job[], fields: FieldKey[], prefix = ""): Group[] {
  const [field, ...rest] = fields;
  if (!field) return [];
  const buckets = new Map<string | null, Job[]>();
  for (const job of jobs) {
    const v = cell(job, field);
    const keys = Array.isArray(v) ? v : [v === undefined ? null : String(v)];
    for (const k of keys) {
      const list = buckets.get(k);
      if (list) list.push(job);
      else buckets.set(k, [job]);
    }
  }
  const values = [...buckets.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : compareValues(field, a, b)));
  return values.map((value) => {
    const key = prefix + field + "=" + (value ?? "");
    const list = buckets.get(value)!;
    return { key, field, value, label: value === null ? "（空）" : valueLabel(field, value), jobs: list, children: groupJobs(list, rest, key + "/") };
  });
}

// ---- 视图配置 ----

export type ViewKind = "table" | "board" | "gantt" | "calendar";
export const VIEW_KINDS: ViewKind[] = ["table", "board", "gantt", "calendar"];
export const VIEW_NAME: Record<ViewKind, string> = { table: "表格", board: "看板", gantt: "甘特", calendar: "日历" };
export type RowHeight = "low" | "medium" | "high";
export const ROW_HEIGHT: Record<RowHeight, number> = { low: 32, medium: 44, high: 64 };

/** 每个视图各存一份，不跨视图同步（同飞书）。 */
export type ViewConfig = {
  filter: Filter;
  group: FieldKey[];
  sort: Sort[];
  hidden: FieldKey[];
  order: FieldKey[];
  widths: Partial<Record<FieldKey, number>>;
  rowHeight: RowHeight;
};
export type ViewState = { active: ViewKind; views: Record<ViewKind, ViewConfig> };

export const MAX_GROUP = 2;
export const MIN_WIDTH = 60;
export const MAX_WIDTH = 600;
export const STORAGE_KEY = "offeru.jobs.views.v1";

export function defaultView(kind: ViewKind): ViewConfig {
  return {
    filter: { mode: "and", conditions: [] },
    group: [],
    sort: [{ field: "score", desc: true }],
    hidden: kind === "table" ? ["created_at"] : [],
    order: [...FIELD_KEYS],
    widths: {},
    rowHeight: "low",
  };
}

export function defaultState(): ViewState {
  return { active: "table", views: { table: defaultView("table"), board: defaultView("board"), gantt: defaultView("gantt"), calendar: defaultView("calendar") } };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isField = (x: unknown): x is FieldKey => typeof x === "string" && Object.prototype.hasOwnProperty.call(FIELDS, x);
const fieldList = (x: unknown): FieldKey[] => (Array.isArray(x) ? [...new Set(x.filter(isField))] : []);

function toCondition(x: unknown): Condition | null {
  if (!isObj(x) || !isField(x.field) || typeof x.op !== "string") return null;
  const op = x.op as Op;
  if (!OPS[FIELDS[x.field].type].includes(op)) return null;
  const value = Array.isArray(x.value) ? x.value.filter((v): v is string => typeof v === "string") : [];
  return { field: x.field, op, value };
}

/** 读回来的配置逐项校验：坏的项退回默认，未知字段丢掉，新加的字段补到末尾，主字段永远第一且不隐藏。 */
export function sanitizeView(raw: unknown, kind: ViewKind): ViewConfig {
  const d = defaultView(kind);
  if (!isObj(raw)) return d;
  const f = isObj(raw.filter) ? raw.filter : {};
  const conditions = Array.isArray(f.conditions) ? f.conditions.map(toCondition).filter((c): c is Condition => c !== null) : [];
  const sort = Array.isArray(raw.sort)
    ? raw.sort.filter((s): s is Record<string, unknown> => isObj(s) && isField(s.field)).map((s) => ({ field: s.field as FieldKey, desc: s.desc === true }))
    : d.sort;
  const widths: Partial<Record<FieldKey, number>> = {};
  if (isObj(raw.widths)) {
    for (const [k, w] of Object.entries(raw.widths)) {
      if (isField(k) && typeof w === "number" && Number.isFinite(w)) widths[k] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
    }
  }
  return {
    filter: { mode: f.mode === "or" ? "or" : "and", conditions },
    group: Array.isArray(raw.group) ? fieldList(raw.group).slice(0, MAX_GROUP) : d.group,
    sort: sort.filter((s, i) => sort.findIndex((t) => t.field === s.field) === i),
    hidden: Array.isArray(raw.hidden) ? fieldList(raw.hidden).filter((k) => k !== PRIMARY) : d.hidden,
    order: [PRIMARY, ...new Set([...fieldList(raw.order), ...FIELD_KEYS])].filter((k, i) => i === 0 || k !== PRIMARY),
    widths,
    rowHeight: raw.rowHeight === "medium" || raw.rowHeight === "high" ? raw.rowHeight : "low",
  };
}

type Store = Pick<Storage, "getItem" | "setItem">;
const local = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export function loadViews(store: Store | undefined = local()): ViewState {
  let raw: unknown;
  try {
    raw = JSON.parse(store?.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return defaultState();
  }
  if (!isObj(raw)) return defaultState();
  const views = isObj(raw.views) ? raw.views : {};
  return {
    active: VIEW_KINDS.includes(raw.active as ViewKind) ? (raw.active as ViewKind) : "table",
    views: { table: sanitizeView(views.table, "table"), board: sanitizeView(views.board, "board"), gantt: sanitizeView(views.gantt, "gantt"), calendar: sanitizeView(views.calendar, "calendar") },
  };
}

/** 存不进去（隐私模式、配额满）就算了，只影响下次打开。 */
export function saveViews(state: ViewState, store: Store | undefined = local()): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略
  }
}

/** 当前视图里生效的配置数，给工具栏按钮显示「2 筛选」。 */
export function activeCounts(view: ViewConfig) {
  return {
    filter: view.filter.conditions.filter((c) => c.op === "empty" || c.op === "notEmpty" || c.value.some((v) => v.trim())).length,
    group: view.group.length,
    sort: view.sort.length,
    hidden: view.hidden.length,
  };
}

// 改标签时一起算 auto_tags / tags_muted：删掉的 Agent 标签记进 tags_muted，以后重拆 JD 不再自动加回；手动加回来的从 tags_muted 拿掉。
export function tagPatch(job: Job, value: string[]) {
  const auto = job.auto_tags ?? [];
  const kept = auto.filter((t) => value.includes(t));
  const muted = [...new Set([...(job.tags_muted ?? []), ...auto.filter((t) => !value.includes(t))])].filter((t) => !value.includes(t));
  return { tags: value.length ? value : null, auto_tags: kept.length ? kept : null, tags_muted: muted.length ? muted : null };
}
