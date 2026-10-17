import { request } from "@/lib/api";

export type ReviewOutcome = "pending" | "passed" | "failed";

export interface ReviewQuestion {
  question: string;
  answer: string;
  reflection: string;
  reaction: string;
}

export interface InterviewReview {
  id: number;
  job_id: number | null;
  company: string;
  role: string;
  round_label: string;
  interviewed_on: string | null;
  outcome: ReviewOutcome;
  summary: string;
  transcript: string;
  questions: ReviewQuestion[];
  updated_at: string | null;
}

export type ReviewDraft = Omit<InterviewReview, "id" | "updated_at">;

const BASE = "/api/interviews/reviews";
const json = (body: unknown) => ({ body: JSON.stringify(body) });
const draftOf = (r: InterviewReview): ReviewDraft => ({
  job_id: r.job_id,
  company: r.company,
  role: r.role,
  round_label: r.round_label,
  interviewed_on: r.interviewed_on,
  outcome: r.outcome,
  summary: r.summary,
  transcript: r.transcript,
  questions: r.questions.map(({ question, answer, reflection, reaction }) => ({ question, answer, reflection, reaction })),
});

export const emptyQuestion = (): ReviewQuestion => ({ question: "", answer: "", reflection: "", reaction: "" });

export const listReviews = () => request<{ items: InterviewReview[] }>(BASE).then((r) => r.items);
export const getReview = (id: number) => request<InterviewReview>(`${BASE}/${id}`);
export const createReview = (draft: Partial<ReviewDraft>) => request<InterviewReview>(BASE, { method: "POST", ...json(draft) });
export const saveReview = (review: InterviewReview) =>
  request<InterviewReview>(`${BASE}/${review.id}`, { method: "PUT", ...json(draftOf(review)) });
export const deleteReview = (id: number) => request<{ deleted: number }>(`${BASE}/${id}`, { method: "DELETE" });
export const extractQuestions = (transcript: string) =>
  request<{ questions: ReviewQuestion[] }>(`${BASE}/extract`, { method: "POST", ...json({ transcript }) }).then((r) => r.questions);

export function transcribeAudio(file: Blob, name: string) {
  const form = new FormData();
  form.append("file", file, name);
  return request<{ transcript: string }>(`${BASE}/transcribe`, { method: "POST", body: form, headers: {} }).then((r) => r.transcript);
}
export interface WeakTopic {
  title: string;
  advice: string;
  /** "复盘id:题序" */
  refs: string[];
}
export const groupWeakSpots = () => request<{ topics: WeakTopic[] }>(`${BASE}/weak-spots`, { method: "POST" }).then((r) => r.topics);
export const markApplicationRejected = (id: number) => request<{ workspace_status: string }>(`${BASE}/${id}/mark-rejected`, { method: "POST" });

/** 看板阶段 → 复盘轮次名。 */
export const ROUND_FOR_STAGE: Record<string, string> = { interview_1: "一面", interview_2: "二面", interview_hr: "HR 面" };
