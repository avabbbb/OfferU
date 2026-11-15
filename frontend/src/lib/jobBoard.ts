import { toneOf, type Tone } from "@/components/ui/Pill";
import { JOB_STATUS, type Job, type JobStatus } from "@/lib/core";
import { FIELDS, STATUS_ORDER, STATUS_TONE, cell, type FieldKey, type ViewConfig } from "@/lib/jobView";

// 看板视图（照金山文档多维表格的看板）：按一个单值字段分列，列和卡片上显示哪些字段由「卡片管理」决定。
// 纯函数；配置存在看板视图自己的 ViewConfig 里（group[0] = 分组依据，order / hidden = 卡片字段的顺序和显隐，collapsed = 折叠的列）。

/** 能当分组依据的字段：只要单值的（标签一个岗位多个值，不适合拖来拖去）。 */
export const BOARD_GROUP_FIELDS: FieldKey[] = ["status", "city", "hire_type"];
/** 卡片标题已经是「公司 · 岗位」，这两个不再作为卡片字段。 */
export const CARD_FIELD_KEYS: FieldKey[] = (Object.keys(FIELDS) as FieldKey[]).filter((k) => k !== "company" && k !== "title");
/** 状态里默认折叠的两列（已结束的岗位）。 */
export const ENDED_STATUSES: JobStatus[] = ["rejected", "closed"];

export function boardGroupField(view: Pick<ViewConfig, "group">): FieldKey {
  const field = view.group[0];
  return field && BOARD_GROUP_FIELDS.includes(field) ? field : "status";
}

export const columnKey = (field: FieldKey, value: string | null) => field + "=" + (value ?? "");

/** 组的颜色和表格里同一个值的胶囊一致：状态用固定配色，其余按文字取色；未分组是灰色。 */
export function groupTone(field: FieldKey, value: string | null): Tone {
  if (value === null) return "gray";
  if (field === "status") return STATUS_TONE[value as JobStatus] ?? "gray";
  return toneOf(value);
}

export type BoardColumn = { key: string; field: FieldKey; value: string | null; label: string; tone: Tone; jobs: Job[] };

/** 分列：状态永远是全部七列（空列也在，好往里拖）；其他字段是出现过的值按拼音排，最后一列「未分组」放空值。列内保持传入顺序。 */
export function boardColumns(jobs: Job[], field: FieldKey): BoardColumn[] {
  const buckets = new Map<string | null, Job[]>();
  const values: Array<string | null> = field === "status" ? [...STATUS_ORDER] : [];
  for (const job of jobs) {
    const v = cell(job, field);
    const key = v === undefined ? null : String(Array.isArray(v) ? v[0] : v);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(job);
    if (field !== "status" && key !== null && !values.includes(key)) values.push(key);
  }
  if (field !== "status") {
    values.sort((a, b) => String(a).localeCompare(String(b), "zh"));
    values.push(null);
  }
  return values.map((value) => ({
    key: columnKey(field, value),
    field,
    value,
    label: value === null ? "未分组" : field === "status" ? JOB_STATUS[value as JobStatus] ?? value : value,
    tone: groupTone(field, value),
    jobs: buckets.get(value) ?? [],
  }));
}

/** 拖到某列 / 在某列新建时要写的字段；招聘类型来自 JD 解析，不能直接改，返回 null（拖不过去，新建也不预填）。 */
export function groupPatch(field: FieldKey, value: string | null): Record<string, unknown> | null {
  switch (field) {
    case "status": return value ? { status: value } : null;
    case "city": return { city: value };
    default: return null;
  }
}

export const canWriteGroup = (field: FieldKey) => groupPatch(field, "x") !== null;

/** 卡片上显示的字段，按「卡片管理」里的顺序。 */
export function cardFields(view: Pick<ViewConfig, "order" | "hidden">): FieldKey[] {
  return view.order.filter((k) => CARD_FIELD_KEYS.includes(k) && !view.hidden.includes(k));
}

/** 详情面板里收进「隐藏字段」的：卡片上没显示的卡片字段。 */
export function hiddenCardFields(view: Pick<ViewConfig, "order" | "hidden">): FieldKey[] {
  return view.order.filter((k) => CARD_FIELD_KEYS.includes(k) && view.hidden.includes(k));
}

export function toggleCardField(view: Pick<ViewConfig, "hidden">, key: FieldKey): Pick<ViewConfig, "hidden"> {
  return { hidden: view.hidden.includes(key) ? view.hidden.filter((k) => k !== key) : [...view.hidden, key] };
}

/** 把 from 挪到 to 的位置（拖动排序）；两者都必须在 order 里。 */
export function moveField(view: Pick<ViewConfig, "order">, from: FieldKey, to: FieldKey): Pick<ViewConfig, "order"> {
  const order = view.order.filter((k) => k !== from);
  const at = order.indexOf(to);
  if (at < 0 || from === to) return { order: view.order };
  const before = view.order.indexOf(from) > view.order.indexOf(to);
  order.splice(before ? at : at + 1, 0, from);
  return { order };
}

export function toggleCollapsed(view: Pick<ViewConfig, "collapsed">, key: string): Pick<ViewConfig, "collapsed"> {
  return { collapsed: view.collapsed.includes(key) ? view.collapsed.filter((k) => k !== key) : [...view.collapsed, key] };
}

const WEEKDAY = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 2026-11-17 → 2026/11/17 星期二（按日历日算，不受时区影响）。 */
export function formatDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  const week = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")} ${week}`;
}
