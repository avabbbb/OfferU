// 按岗位改简历：POST /api/resume/{id}/tailor，SSE 推 start → delta…（起草）→ review…（每轮审稿）→ done | error。
// abort 就是取消，后端没跑完不写库。review_only：不重新起草，拿已有的定制简历只跑审稿（档案补了新成果后再改一下）。
import { apiUrl } from "@/lib/core";
import { readSse } from "@/lib/sse";

// 审稿给的一条修改：old 按原文精确替换成 new；跳过的带 why。
export type TailorEdit = { old: string; new: string; reason: string; category: string; why?: string };
export type TailorRound = { round: number; pages: number | null; applied: TailorEdit[]; skipped: TailorEdit[]; error?: string };
// 只写了动作、没写结果的句子（最多 3 句），拿去问用户。
export type TailorAsk = { old: string; why: string; question: string };
// 改写结果核对：终稿逐行对照档案和原简历。block 是数字找不到出处，warn 是说法可能拔高；只提醒，简历没改。
export type TailorCheck = { line: string; kind: string; detail: string };
// dropped：终稿留了某条确认过的经历，它的数字或强动词却不见了；omitted：整条没写进去的经历标题（按相关性取舍，不提醒）。
export type TailorDropped = { memory_id: number; title: string; missing: string[] };
export type TailorChecks = { block: TailorCheck[]; warn: TailorCheck[]; unchecked: string; dropped?: TailorDropped[]; omitted?: string[] };

export type TailorEvent =
  | { type: "start"; job: string }
  | { type: "delta"; text: string }
  | { type: "review"; round: number; pages: number | null }
  | {
    type: "done"; doc_id: number; body: string; resume: unknown; change_id: number; pages: number | null;
    rounds: TailorRound[]; notes: Record<string, string>; grounding: TailorEdit[]; asks?: TailorAsk[]; checks?: TailorChecks;
  }
  | { type: "error"; message: string };

const CATEGORY: Record<string, string> = { grounding: "出处", keyword: "关键词", depth: "技术深度", length: "篇幅", tone: "语气" };

// 把审稿过程拼成几行给人看：每轮改了什么、跳过了什么，最终页数，审稿人没法替你补的缺口。
export function tailorNotes(event: Extract<TailorEvent, { type: "done" }>): string[] {
  const notes: string[] = [];
  for (const round of event.rounds) {
    if (round.error) {
      notes.push("第 " + round.round + " 轮审稿没完成：" + round.error + "，停在这一轮");
      continue;
    }
    const parts = ["第 " + round.round + " 轮审稿改了 " + round.applied.length + " 处"];
    if (round.applied.length) {
      parts.push(round.applied.map((e) => (CATEGORY[e.category] ?? e.category) + "：" + (e.reason || e.old.slice(0, 16)).trim().replace(/[。；;.]+$/, "")).join("；"));
    }
    if (round.skipped.length) parts.push("跳过 " + round.skipped.length + " 处（" + round.skipped.map((e) => e.why).filter(Boolean).join("、") + "）");
    notes.push(parts.join("，"));
  }
  if (event.pages) notes.push("预计 " + event.pages.toFixed(1) + " 页");
  for (const [key, value] of Object.entries(event.notes ?? {})) if (value && value !== "无") notes.push(key + "：" + value);
  return notes;
}

export async function tailorResume(docId: number, jobId: number, signal: AbortSignal, onEvent: (event: TailorEvent) => void,
  options: { reviewOnly?: boolean } = {}): Promise<void> {
  const res = await fetch(apiUrl("/api/resume/" + docId + "/tailor"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, review_only: Boolean(options.reviewOnly) }), signal,
  });
  if (!res.ok) throw new Error("改写请求失败（" + res.status + "），简历没动");
  await readSse(res, onEvent);
}

// 追问成果：回答 → 记忆草稿（只出草稿不写库）。data 原样传给 save("memory", data, memory_id)。
export type ImpactAnswer = { old: string; question: string; answer: string };
export type ImpactDraft = { memory_id: number | null; title: string; data: Record<string, unknown>; answers: (ImpactAnswer & { add: string; flags?: string[] })[] };
export type ImpactDropped = { index: number; old: string; question: string; quote: string; add?: string; why: string };

export async function captureImpact(answers: ImpactAnswer[], jobId: number | null): Promise<{ drafts: ImpactDraft[]; dropped: ImpactDropped[] }> {
  const res = await fetch(apiUrl("/api/resume/impact"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers, job_id: jobId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && typeof data.detail === "string" ? data.detail : "整理失败（" + res.status + "）") + "，档案没动");
  return data;
}
