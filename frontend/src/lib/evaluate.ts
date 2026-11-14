// 岗位评估：POST /api/jobs/evaluate，SSE 推 start → job_start / job … → done。
// 工具调用（evaluate_jobs）是同步的；网页用这条流看进度。
import { apiUrl } from "@/lib/core";
import { readSse } from "@/lib/sse";

export type EvaluateItem = {
  id: number; label: string; score: number; reasons: string[]; greeting: string; doc_id: number;
};

export type EvaluateEvent =
  | { type: "start"; total: number }
  | { type: "job_start"; id: number; label: string; index: number; total: number }
  | ({ type: "job"; index: number; total: number } & EvaluateItem)
  | { type: "done"; count: number; change_ids: number[]; items: EvaluateItem[]; failed: string[]; remaining?: number }
  // TS backend: a failure mid-stream ends with an error event instead of a dropped connection.
  | { type: "error"; detail: string; code?: string };

export async function evaluateJobs(
  ids: number[] | null,
  signal: AbortSignal,
  onEvent: (event: EvaluateEvent) => void,
  options: { redo?: boolean } = {},
): Promise<void> {
  const res = await fetch(apiUrl("/api/jobs/evaluate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, redo: Boolean(options.redo) }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === "string" && body.detail ? body.detail : "评估请求失败（" + res.status + "）");
  }
  let failure = "";
  await readSse<EvaluateEvent>(res, (event) => {
    if (event.type === "error") failure = event.detail || "评估中断了";
    else onEvent(event);
  });
  if (failure) throw new Error(failure);
}
