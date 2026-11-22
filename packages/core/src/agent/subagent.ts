// Read-only sub-agents: the parent Agent hands out a few independent fact-finding branches
// (「比较三家公司的数据分析岗」→ one branch per company), each runs its own short loop with
// read-only tools and a small step budget, and returns structured evidence. The parent compares
// and does every write itself.
//
// - Read-only by construction: a child only gets READ_ONLY_TOOLS (minus asking the user).
// - Independent: one branch failing or timing out leaves the others' results usable; the result
//   says which branch is missing and why.
// - Cancellation flows down: aborting the parent run aborts every child.
// - Model budget is shared: children call the same (limited) client, so they queue on the
//   provider's request slots like any other call; the parent holds no slot while it waits.

import type { LlmClient } from "../llm";
import type { Json } from "../types";
import { runAgentLoop, type AgentTool } from "./loop";
import { READ_ONLY_TOOLS } from "./sandbox";

export const DELEGATE_TOOL_NAME = "delegate_research";
export const MAX_SUBTASKS = 4;
export const SUBTASK_STEPS = 6;

export const DELEGATE_DESCRIPTION = "把几个互相独立的只读核查分给子任务并行做（例如三家公司的岗位各查一份）。"
  + "每个子任务只能用只读工具（get / search / list / web_search / fetch_page …），不写数据、不问用户，"
  + `最多 ${SUBTASK_STEPS} 步，返回结构化证据。最多 ${MAX_SUBTASKS} 个子任务。拿到结果后由你比较、写入。`
  + "单个岗位的固定流程（评估、改简历）不要用它，直接调对应工具。";

export const DELEGATE_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SUBTASKS,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, description: "这一份的名字，如「飞书 数据分析实习」" },
          instructions: { type: "string", minLength: 1, description: "要查什么、要回答哪些问题" },
          context: { type: "string", description: "必要材料（JD 摘要、档案要点、岗位 #id），子任务看不到对话" },
        },
        required: ["title", "instructions"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

const CHILD_PROMPT = [
  "你是 OfferU Agent 分派出来的只读核查子任务。",
  "- 只做交给你的这一份，只用给你的工具和材料；不写入任何数据，不问用户，不编来源。",
  "- 查不到就写进 gaps，不猜。",
  `- 最多 ${SUBTASK_STEPS} 步。最后只输出一个 JSON：{"summary": "一两句结论", "findings": [{"claim": "…", "source": "链接或记录 #id"}], "gaps": ["…"]}`,
].join("\n");

export type SubtaskResult =
  | { title: string; ok: true; summary: string; findings: Json[]; gaps: string[]; raw?: string; steps: number }
  | { title: string; ok: false; error: string };

function parseChild(text: string): { summary: string; findings: Json[]; gaps: string[]; raw?: string } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) {
    try {
      const value = JSON.parse(match[0]) as Json;
      return {
        summary: String(value.summary ?? ""),
        findings: Array.isArray(value.findings) ? value.findings.filter((item): item is Json => Boolean(item) && typeof item === "object") : [],
        gaps: Array.isArray(value.gaps) ? value.gaps.map(String) : [],
      };
    } catch {
      // fall through: keep the text
    }
  }
  return { summary: text.trim().slice(0, 600), findings: [], gaps: [], raw: text.slice(0, 4000) };
}

export interface DelegateDeps {
  client: LlmClient;
  /** The parent's tools; only the read-only ones reach a child. */
  tools: AgentTool[];
  /** The parent run's signal: aborting it aborts every child. */
  signal?: AbortSignal;
  model?: string;
  steps?: number;
  /** Progress for the run's event log (subtask.started / subtask.finished). */
  onEvent?: (type: "subtask.started" | "subtask.finished", payload: Json) => void | Promise<void>;
}

export function delegateTool(deps: DelegateDeps): AgentTool {
  const childTools = deps.tools.filter((tool) => READ_ONLY_TOOLS.has(tool.name) && tool.name !== "request_user_input");
  const steps = deps.steps ?? SUBTASK_STEPS;
  return {
    name: DELEGATE_TOOL_NAME,
    description: DELEGATE_DESCRIPTION,
    parameters: DELEGATE_SCHEMA,
    async execute(args) {
      const tasks = (Array.isArray(args.tasks) ? args.tasks : []).slice(0, MAX_SUBTASKS) as Array<{ title?: unknown; instructions?: unknown; context?: unknown }>;
      if (!tasks.length) {
        const failure = { ok: false, error: { code: "invalid_args", message: "tasks 至少要一项", retryable: true } };
        return { text: JSON.stringify(failure), isError: true, details: failure };
      }
      const runOne = async (task: (typeof tasks)[number], index: number): Promise<SubtaskResult> => {
        const title = String(task.title || `子任务 ${index + 1}`).slice(0, 80);
        const child = new AbortController();
        const abort = () => child.abort();
        if (deps.signal?.aborted) child.abort();
        deps.signal?.addEventListener("abort", abort, { once: true });
        await deps.onEvent?.("subtask.started", { index, title });
        try {
          const brief = [String(task.instructions || ""), task.context ? `材料：\n${String(task.context)}` : ""].filter(Boolean).join("\n\n");
          const result = await runAgentLoop({
            client: deps.client,
            systemPrompt: CHILD_PROMPT,
            messages: [{ role: "user", content: `【${title}】\n${brief}` }],
            tools: childTools,
            softLimit: steps,
            hardLimit: steps + 1,
            signal: child.signal,
            model: deps.model,
            compaction: false,
          });
          if (result.stopReason === "aborted" || child.signal.aborted) return { title, ok: false, error: "已取消" };
          if (result.stopReason === "error") return { title, ok: false, error: result.error || "模型出错" };
          if (!result.assistantText.trim()) return { title, ok: false, error: `${steps} 步内没给出结论` };
          return { title, ok: true, ...parseChild(result.assistantText), steps: result.turns };
        } catch (cause) {
          return { title, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        } finally {
          deps.signal?.removeEventListener("abort", abort);
        }
      };
      const results = await Promise.all(tasks.map((task, index) => runOne(task, index).then(async (result) => {
        await deps.onEvent?.("subtask.finished", { index, title: result.title, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
        return result;
      })));
      const missing = results.filter((item) => !item.ok).map((item) => item.title);
      const payload = {
        ok: results.some((item) => item.ok),
        results,
        missing,
        note: missing.length ? `缺 ${missing.join("、")} 的结果：比较时写明缺哪一份，不要编。` : "全部子任务都有结果，由你比较并决定写什么。",
      };
      return { text: JSON.stringify(payload), isError: !payload.ok, details: payload };
    },
  };
}
