// 按岗位改简历：POST /api/resume/{id}/tailor，SSE 推 start → delta… → done | error。abort 就是取消，后端没跑完不写库。
import { apiUrl } from "@/lib/core";
import { readSse } from "@/lib/sse";

export type TailorEvent =
  | { type: "start"; job: string }
  | { type: "delta"; text: string }
  | { type: "done"; body: string; resume: unknown; change_id: number }
  | { type: "error"; message: string };

export async function tailorResume(docId: number, jobId: number, signal: AbortSignal, onEvent: (event: TailorEvent) => void): Promise<void> {
  const res = await fetch(apiUrl(`/api/resume/${docId}/tailor`), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: jobId }), signal,
  });
  if (!res.ok) throw new Error(`改写请求失败（${res.status}），简历没动`);
  await readSse(res, onEvent);
}
