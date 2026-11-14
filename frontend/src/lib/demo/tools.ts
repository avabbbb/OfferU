// Tool calls for the in-page Agent (lib/demo/agent). They go through the same
// /api/tools/{name} endpoint as the workbench, with the actor header set, so
// the Agent hits the same core guards (forward-only status, unconfirmed
// memories) whether the browser runtime or a paired companion answers.

import { apiFetch } from "@/lib/transport";
import { safeClientErrorMessage } from "@/lib/safe-error";

export const DEMO_TOOL_NAMES = new Set([
  "overview",
  "list",
  "get",
  "save",
  "delete",
  "undo",
  "changes",
  "search",
]);

export const DEMO_UNSUPPORTED = "网页版暂时只支持查看、编辑、删除、撤销和搜索；邮箱、文件和外置 Agent 请连接本机 OfferU。";

export async function demoTool<T = unknown>(name: string, rawArgs: Record<string, unknown> = {}, actor = "你"): Promise<T> {
  if (!/^[a-z_]+$/.test(name)) throw new Error(DEMO_UNSUPPORTED);
  const response = await apiFetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OfferU-Actor": actor },
    body: JSON.stringify(rawArgs && typeof rawArgs === "object" ? rawArgs : {}),
  });
  const payload = await response.json().catch(() => ({})) as { detail?: unknown };
  if (!response.ok) {
    throw new Error(response.status === 501 ? safeClientErrorMessage(payload.detail, DEMO_UNSUPPORTED) : safeClientErrorMessage(payload.detail, `工具调用失败（${response.status}）`));
  }
  return payload as T;
}
