// 按岗位改简历：POST /api/resume/{id}/tailor，SSE 推 start → delta…（起草）→ review…（每轮审稿）→ done | error。
// abort 就是取消，后端没跑完不写库。
import { apiUrl } from "@/lib/core";
import { readSse } from "@/lib/sse";

// 审稿给的一条修改：old 按原文精确替换成 new；跳过的带 why。
export type TailorEdit = { old: string; new: string; reason: string; category: string; why?: string };
export type TailorRound = { round: number; pages: number | null; applied: TailorEdit[]; skipped: TailorEdit[]; error?: string };

export type TailorEvent =
  | { type: "start"; job: string }
  | { type: "delta"; text: string }
  | { type: "review"; round: number; pages: number | null }
  | {
    type: "done"; doc_id: number; body: string; resume: unknown; change_id: number; pages: number | null;
    rounds: TailorRound[]; notes: Record<string, string>; grounding: TailorEdit[];
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

export async function tailorResume(docId: number, jobId: number, signal: AbortSignal, onEvent: (event: TailorEvent) => void): Promise<void> {
  const res = await fetch(apiUrl(`/api/resume/${docId}/tailor`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }), signal,
  });
  if (!res.ok) throw new Error(`改写请求失败（${res.status}），简历没动`);
  await readSse(res, onEvent);
}
