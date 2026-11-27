// Proactive Action Engine (Hark-style one-tap Action Buttons):
// Pure, deterministic rules over the 5 OfferU record types (profile / memory / job / event / doc).
// Every action is 100% grounded in real records in store — never fabricated, never calls an LLM,
// and works identically in local-web (IndexedDB), web-to-local bridge, lite, and desktop.

import { EVENT_KIND, addDays, dayOf, label } from "../labels";
import type { CoreContext, CoreStore, EventKind, StoredRecord } from "../types";

export type ProactivePriority = "urgent" | "high" | "normal";

export type ProactiveActionKind =
  | "overdue_event"
  | "upcoming_interview"
  | "unconfirmed_memories"
  | "missing_profile"
  | "missing_resume"
  | "unevaluated_jobs"
  | "tailor_top_job"
  | "stale_application"
  | "interview_review";

export type ProactiveDirectAction = "confirm_memories" | "open_route";

export interface ProactiveAction {
  id: string;
  kind: ProactiveActionKind;
  priority: ProactivePriority;
  title: string;
  reason: string;
  button_label: string;
  prompt: string;
  route?: string;
  job_id?: number | null;
  record_ids?: number[];
  direct_action?: ProactiveDirectAction;
}

export interface ProactiveSnapshot {
  today: string;
  actions: ProactiveAction[];
  counts: {
    unconfirmed_memories: number;
    unevaluated_jobs: number;
    overdue_events: number;
    upcoming_events: number;
  };
}

const MAX_ACTIONS = 6;

function numericScore(job: StoredRecord): number | null {
  return typeof job.score === "number" && Number.isFinite(job.score) ? job.score : null;
}

export async function buildProactiveActions(store: CoreStore, ctx: CoreContext): Promise<ProactiveSnapshot> {
  const [profile, memories, jobs, events, docs] = await Promise.all([
    store.first("profile"),
    store.all("memory"),
    store.all("job"),
    store.all("event"),
    store.all("doc"),
  ]);

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const openEvents = events
    .filter((event) => !event.done && !["rejected", "closed"].includes(String(jobsById.get(event.job_id ?? -1)?.status)))
    .sort((a, b) => String(a.at ?? "9999").localeCompare(String(b.at ?? "9999")));

  const overdueEvents = openEvents.filter((event) => {
    const day = dayOf(event.at);
    return Boolean(day && day < ctx.today);
  });

  const soonLimit = addDays(ctx.today, 2);
  const upcomingEvents = openEvents.filter((event) => {
    const day = dayOf(event.at);
    return Boolean(day && day >= ctx.today && day <= soonLimit && ["test", "interview", "deadline"].includes(String(event.kind)));
  });

  const unconfirmedMemories = memories.filter((memory) => memory.confirmed === false);
  const resumes = docs.filter((doc) => doc.kind === "resume");
  const tailoredJobIds = new Set(resumes.map((doc) => doc.job_id).filter((id): id is number => typeof id === "number"));
  const reviewedJobIds = new Set(docs.filter((doc) => doc.kind === "review").map((doc) => doc.job_id).filter((id): id is number => typeof id === "number"));

  const savedJobs = jobs.filter((job) => job.status === "saved");
  const unevaluatedJobs = savedJobs.filter((job) => numericScore(job) === null);
  const evaluatedSaved = savedJobs
    .filter((job) => numericScore(job) !== null && !tailoredJobIds.has(job.id))
    .sort((a, b) => (numericScore(b) ?? 0) - (numericScore(a) ?? 0));

  const staleThreshold = addDays(ctx.today, -7);
  const staleApplied = jobs
    .filter((job) => job.status === "applied" && String(job.updated_at || "").slice(0, 10) <= staleThreshold)
    .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));

  const pastInterviewJobs = jobs.filter((job) => {
    if (job.status !== "interview" || reviewedJobIds.has(job.id)) return false;
    return events.some((event) => event.job_id === job.id && event.kind === "interview" && Boolean(dayOf(event.at)) && dayOf(event.at)! < ctx.today);
  });

  const actions: ProactiveAction[] = [];

  // 1. Overdue event (urgent)
  if (overdueEvents.length > 0) {
    const first = overdueEvents[0];
    const job = first.job_id !== null ? jobsById.get(first.job_id) : undefined;
    actions.push({
      id: `overdue_event:${first.id}`,
      kind: "overdue_event",
      priority: "urgent",
      title: `处理逾期事项「${label(first)}」`,
      reason: overdueEvents.length > 1
        ? `原定 ${String(first.at).replace("T", " ")}，另有 ${overdueEvents.length - 1} 件逾期事项`
        : `原定 ${String(first.at).replace("T", " ")}，还没标记完成`,
      button_label: "交给 Agent 整理",
      prompt: `帮我处理逾期的事项「${label(first)}」（#${first.id}${job ? `，关联岗位 ${label(job)} #${job.id}` : ""}）：核对现状、决定改期还是标记完成。`,
      route: first.job_id ? `/jobs/${first.job_id}` : "/",
      job_id: first.job_id,
      record_ids: overdueEvents.map((item) => item.id),
    });
  }

  // 2. Upcoming test / interview / deadline within 48h (urgent)
  if (upcomingEvents.length > 0) {
    const first = upcomingEvents[0];
    const job = first.job_id !== null ? jobsById.get(first.job_id) : undefined;
    const kindName = EVENT_KIND[first.kind as EventKind] ?? "事项";
    actions.push({
      id: `upcoming_interview:${first.id}`,
      kind: "upcoming_interview",
      priority: "urgent",
      title: `准备「${label(first)}」`,
      reason: `${kindName}在 ${String(first.at).replace("T", " ")}（48 小时内）`,
      button_label: first.kind === "interview" ? "开始面试准备" : "开始准备",
      prompt: job
        ? `帮我准备即将到来的${kindName}「${label(first)}」（岗位 ${label(job)} #${job.id}）：拆解 JD 重点、列出针对性押题和我的经历证据。`
        : `帮我准备即将到来的${kindName}「${label(first)}」（#${first.id}），列出时间节点和准备清单。`,
      route: first.job_id ? `/jobs/${first.job_id}` : "/",
      job_id: first.job_id,
      record_ids: [first.id],
    });
  }

  // 3. Unconfirmed memories waiting for user approval (high, 1-tap direct confirm!)
  if (unconfirmedMemories.length > 0) {
    actions.push({
      id: `unconfirmed_memories:${unconfirmedMemories.length}`,
      kind: "unconfirmed_memories",
      priority: "high",
      title: `${unconfirmedMemories.length} 条职业记忆待确认`,
      reason: "Agent 写入的记忆确认后才会用于定制简历与网申回答（可随时撤销）",
      button_label: "全部确认",
      prompt: "帮我逐条核对当前待确认的职业记忆，确认无误后提示我生效。",
      route: "/profile",
      record_ids: unconfirmedMemories.map((item) => item.id).sort((a, b) => a - b),
      direct_action: "confirm_memories",
    });
  }

  // 4. Missing profile (high)
  if (!profile?.name) {
    actions.push({
      id: "missing_profile",
      kind: "missing_profile",
      priority: "high",
      title: "建立第一份职业档案",
      reason: "档案建好后，评估岗位、改写简历和网申回答都会自动复用",
      button_label: "开始建档",
      prompt: "帮我建立第一份职业档案：先问我最关键的几个问题（或让我提供旧简历），把基本信息和核心经历整理进档案。",
      route: "/profile",
    });
  }

  // 5. Missing base resume (high, when profile or memories already exist)
  if (profile?.name && resumes.length === 0) {
    actions.push({
      id: "missing_resume",
      kind: "missing_resume",
      priority: "high",
      title: "生成第一份基准简历",
      reason: "已有档案但还没有简历文档，生成后即可按岗位一键定制",
      button_label: "生成简历",
      prompt: "基于我的职业档案和已确认记忆，帮我生成一份结构化的基准简历并保存。",
      route: "/resume",
    });
  }

  // 6. Unevaluated saved jobs (high)
  if (unevaluatedJobs.length > 0) {
    const sample = unevaluatedJobs.slice(0, 3).map((job) => label(job)).join("、");
    actions.push({
      id: `unevaluated_jobs:${unevaluatedJobs.length}`,
      kind: "unevaluated_jobs",
      priority: "high",
      title: `评估 ${unevaluatedJobs.length} 个未打分岗位`,
      reason: `${sample}${unevaluatedJobs.length > 3 ? " 等" : ""} 还没有匹配分和打招呼语`,
      button_label: "一键评估",
      prompt: "帮我评估目前还没打分的收藏岗位，按匹配度排序并给出核心理由和打招呼语。",
      route: "/jobs",
      record_ids: unevaluatedJobs.map((job) => job.id),
    });
  }

  // 7. Top evaluated saved job missing tailored resume (normal)
  if (evaluatedSaved.length > 0) {
    const top = evaluatedSaved[0];
    const score = numericScore(top);
    actions.push({
      id: `tailor_top_job:${top.id}`,
      kind: "tailor_top_job",
      priority: "normal",
      title: `为「${label(top)}」定制简历`,
      reason: `匹配度 ${score} 分，还没有该岗位专属的定制简历`,
      button_label: "定制简历",
      prompt: `请按岗位「${label(top)}」（#${top.id}）的 JD 和评估结果，为我定制一份专属简历，只使用我档案里真实确认过的经历。`,
      route: `/jobs/${top.id}`,
      job_id: top.id,
      record_ids: [top.id],
    });
  }

  // 8. Stale applied job > 7 days (normal)
  if (staleApplied.length > 0) {
    const stale = staleApplied[0];
    actions.push({
      id: `stale_application:${stale.id}`,
      kind: "stale_application",
      priority: "normal",
      title: `跟进「${label(stale)}」投递进度`,
      reason: "已投递超过 7 天没有新动态，可以准备一段简洁的跟进话术",
      button_label: "起草跟进",
      prompt: `「${label(stale)}」（#${stale.id}）已投递超过 7 天没有进展，帮我写一段简洁得体的进度跟进消息草稿（不代发）。`,
      route: `/jobs/${stale.id}`,
      job_id: stale.id,
      record_ids: [stale.id],
    });
  }

  // 9. Past interview missing review doc (normal)
  if (pastInterviewJobs.length > 0) {
    const job = pastInterviewJobs[0];
    actions.push({
      id: `interview_review:${job.id}`,
      kind: "interview_review",
      priority: "normal",
      title: `复盘「${label(job)}」面试`,
      reason: "面试时间已过，记录问题和复盘可以沉淀新证据回写档案",
      button_label: "开始复盘",
      prompt: `帮我复盘「${label(job)}」（#${job.id}）的面试：先问我这场面试被问到的关键问题和表现，整理成面试复盘文档，并把值得补充的经历沉淀进记忆。`,
      route: `/jobs/${job.id}`,
      job_id: job.id,
      record_ids: [job.id],
    });
  }

  return {
    today: ctx.today,
    actions: actions.slice(0, MAX_ACTIONS),
    counts: {
      unconfirmed_memories: unconfirmedMemories.length,
      unevaluated_jobs: unevaluatedJobs.length,
      overdue_events: overdueEvents.length,
      upcoming_events: upcomingEvents.length,
    },
  };
}
