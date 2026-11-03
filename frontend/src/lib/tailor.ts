// 按岗位改简历：POST /api/resume/{id}/tailor，SSE 推 start → delta… → done | error。abort 就是取消，后端没跑完不写库。
import { apiUrl } from "@/lib/core";
import { readSse } from "@/lib/sse";

export type TailorIssue = { kind: string; text: string; line: string };

// done 里除了写好的简历，还有改写后的确定性提醒：找不到出处、JD 关键词覆盖、预计页数、审稿。都只提醒，不挡写库。
export type TailorEvent =
  | { type: "start"; job: string }
  | { type: "delta"; text: string }
  | {
    type: "done"; doc_id: number; body: string; resume: unknown; change_id: number; unsupported?: TailorIssue[];
    coverage?: { hit: string[]; missing: string[] }; pages?: number | null; over_page?: boolean; review?: TailorIssue[];
  }
  | { type: "error"; message: string };

// 把 done 的提醒拼成几行给人看；没问题的项不写。
export function tailorNotes(event: Extract<TailorEvent, { type: "done" }>): string[] {
  const notes: string[] = [];
  const cov = event.coverage;
  if (cov && cov.hit.length + cov.missing.length) {
    notes.push("JD 关键词命中 " + cov.hit.length + "/" + (cov.hit.length + cov.missing.length)
      + (cov.missing.length ? "，没写进去：" + cov.missing.join("、") + "（档案里真有再手动补，没有别硬写）" : ""));
  }
  if (event.over_page && event.pages) notes.push("预计 " + event.pages.toFixed(1) + " 页，超过一页，可以点「智能一页」或删减");
  const review = event.review ?? [];
  if (review.length) {
    notes.push("审稿 " + review.length + " 条：" + review.slice(0, 4).map((r) => "「" + r.line.slice(0, 14) + "」" + r.text).join("；")
      + (review.length > 4 ? "；…" : ""));
  }
  const miss = event.unsupported ?? [];
  if (miss.length) notes.push("有 " + miss.length + " 处在档案里找不到出处，请核对：" + miss.map((m) => m.text).join("、"));
  return notes;
}

export async function tailorResume(docId: number, jobId: number, signal: AbortSignal, onEvent: (event: TailorEvent) => void): Promise<void> {
  const res = await fetch(apiUrl(`/api/resume/${docId}/tailor`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }), signal,
  });
  if (!res.ok) throw new Error(`改写请求失败（${res.status}），简历没动`);
  await readSse(res, onEvent);
}
