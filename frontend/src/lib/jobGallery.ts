import { type Event, JOB_STATUS, type Job, type JobStatus } from "@/lib/core";
import { STATUS_ORDER } from "@/lib/jobView";

// 画廊视图的纯逻辑：底部胶囊的状态分组、取当前组的岗位、每一帧在透视长廊里的位置。
// 输入是 applyView 之后的结果，所以视图的筛选 / 排序 / 搜索照样生效。

export type GalleryGroupKey = "all" | JobStatus;
export type GalleryGroup = { key: GalleryGroupKey; label: string; count: number };

/** 「全部」+ 有岗位的状态（按流程顺序）。没有岗位时只剩「全部 0」。 */
export function galleryGroups(jobs: Job[]): GalleryGroup[] {
  const counts = new Map<JobStatus, number>();
  for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  return [
    { key: "all", label: "全部", count: jobs.length },
    ...STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({ key: s, label: JOB_STATUS[s], count: counts.get(s)! })),
  ];
}

export function galleryJobs(jobs: Job[], group: GalleryGroupKey): Job[] {
  return group === "all" ? jobs : jobs.filter((job) => job.status === group);
}

/** 当前组里分数最高的岗位 id（OfferU 光标指着它）；都没分就没有。 */
export function topMatch(jobs: Job[]): number | null {
  let best: Job | null = null;
  for (const job of jobs) if (job.score != null && (best?.score == null || job.score > best.score)) best = job;
  return best?.id ?? null;
}

/** 岗位最近一个没做完的截止事项（Job 本身没有截止字段，截止记在 event 上）。 */
export function nextDeadline(job: Job, events: Event[]): Event | undefined {
  return events
    .filter((e) => e.job_id === job.id && e.kind === "deadline" && !e.done && e.at)
    .sort((a, b) => a.at!.localeCompare(b.at!))[0];
}

/** 滚轮该走几帧的方向量：普通竖滚轮返回 0，交给页面滚；Shift+滚轮或横向为主的触控板轻扫才切帧。 */
export function galleryWheelDelta(e: { deltaX: number; deltaY: number; shiftKey: boolean }): number {
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (horizontal) return e.deltaX;
  return e.shiftKey ? e.deltaY : 0;
}

export const clampIndex = (i: number, n: number) => (n <= 0 ? 0 : Math.min(n - 1, Math.max(0, i)));

/** 只渲染离焦点这么近的帧，再远的看不见也不占性能。 */
export const GALLERY_REACH = 5;

export type FramePose = { x: number; z: number; rotate: number; scale: number; opacity: number; blur: number };

/**
 * 第 d 帧（相对焦点，负数在左）的位置。x / z 以帧宽为单位，rotate 是 rotateY 的角度，blur 以 px 计。
 * stepped = 焦点帧「走上前」展开成详情，两边退成边缘的细条；flat = 减少动态效果，只平移不转不糊。
 */
export function framePose(d: number, stepped: boolean, flat: boolean): FramePose {
  const a = Math.abs(d);
  const side = Math.sign(d);
  if (a === 0) return { x: 0, z: 0, rotate: 0, scale: 1, opacity: 1, blur: 0 };
  if (flat) {
    return stepped
      ? { x: side * (1.6 + (a - 1) * 0.2), z: 0, rotate: 0, scale: 1, opacity: a === 1 ? 0.35 : 0, blur: 0 }
      : { x: side * (1.06 * a), z: 0, rotate: 0, scale: 1, opacity: Math.max(0.3, 1 - 0.25 * a), blur: 0 };
  }
  if (stepped) {
    return { x: side * (1.55 + (a - 1) * 0.12), z: -0.9 - a * 0.3, rotate: -side * 72, scale: 0.9, opacity: a === 1 ? 0.55 : a === 2 ? 0.25 : 0, blur: a * 1.5 };
  }
  // 越远挤得越紧、越往里、越暗越糊，像一排画框朝消失点退去。
  return {
    x: side * (0.74 + (a - 1) * 0.42),
    z: -0.5 - (a - 1) * 0.42,
    rotate: -side * 38,
    scale: 1 - Math.min(0.24, a * 0.05),
    opacity: Math.max(0.22, 1 - a * 0.17),
    blur: a < 2 ? 0 : (a - 1) * 0.8,
  };
}
