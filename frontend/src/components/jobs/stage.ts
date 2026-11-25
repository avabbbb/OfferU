import type { Tone } from "@/components/ui";
import { JOB_STATUS, type JobStatus } from "@/lib/core";
import { STATUS_TONE } from "@/lib/jobView";

// 岗位列表 / 详情里的阶段胶囊：沿用多维表的状态色，只把「已投递」从蓝换成棕——新版岗位页不出现蓝色。
export const STAGE_TONE: Record<JobStatus, Tone> = { ...STATUS_TONE, applied: "brown" };

/** 阶段 chip：把七个状态收成用户真正用来筛的几档。 */
export type StageFilter = "all" | "active" | "saved" | "offer" | "ended";
export const STAGE_FILTERS: Array<{ value: StageFilter; label: string; statuses: JobStatus[] | null }> = [
  { value: "all", label: "全部", statuses: null },
  { value: "active", label: "进行中", statuses: ["applied", "test", "interview"] },
  { value: "saved", label: JOB_STATUS.saved, statuses: ["saved"] },
  { value: "offer", label: JOB_STATUS.offer, statuses: ["offer"] },
  { value: "ended", label: "已结束", statuses: ["rejected", "closed"] },
];
export const ENDED: JobStatus[] = ["rejected", "closed"];
