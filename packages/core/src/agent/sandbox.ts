// 沙箱模式：一个 Run 能不能改数据。
//
// - workspace_write（默认）：工具照常执行（写入直接生效、可撤销）。
// - read_only：只放行读类工具；写类工具不执行，直接给模型回一个结构化错误
//   {ok:false, error:{code:"read_only", …}}，让它改用只读的方式回答或告诉用户切到可写。
//
// 用白名单（只列读类工具）而不是黑名单：新加的工具默认算写，只读模式下不会漏放。

import type { AgentTool } from "./loop";
import { failureResult } from "./tools";
import type { ToolFailure } from "../tools/preflight";
import { MAIL_READ_ACTIONS } from "../mail/tool";

export type SandboxMode = "read_only" | "workspace_write";
export const SANDBOX_MODES: readonly SandboxMode[] = ["read_only", "workspace_write"];
export const DEFAULT_SANDBOX: SandboxMode = "workspace_write";

/** 只读模式下放行的工具：只读数据、查网页、读方法，不改任何东西。 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "overview", "search", "list", "get", "changes",
  "read_file", "find_files",
  "web_search", "fetch_page",
  "reconcile_memory", "export_data",
  "tool_manual", "skill_read",
  "request_user_input",
]);

/** 带 action 的工具：只读模式只放行这些 action（mail 的 list / read）。 */
export const READ_ONLY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = { mail: MAIL_READ_ACTIONS };

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "read_only" || value === "workspace_write";
}

/** 这次调用在只读模式下能不能做。 */
export function isReadOnlyCall(name: string, args: Record<string, unknown> = {}): boolean {
  return READ_ONLY_TOOLS.has(name) || Boolean(READ_ONLY_ACTIONS[name]?.has(String(args.action)));
}

export function readOnlyFailure(name: string): ToolFailure {
  return {
    ok: false,
    error: {
      code: "read_only",
      message: `只读模式：不能执行 ${name}（会改动数据）`,
      retryable: false,
      suggestedAction: "不要换别的写入工具绕过。用读类工具给出结果或草拟内容放在回复里，并告诉用户：要真正写入，请在输入框把沙箱切到「可写」再说一次。",
    },
  };
}

/** 显式给的模式优先，其次是这个 Run 之前记下的（续跑、回答 Ask 时沿用），都没有就默认可写。 */
export function resolveSandbox(explicit: unknown, stored: unknown): SandboxMode {
  if (isSandboxMode(explicit)) return explicit;
  if (isSandboxMode(stored)) return stored;
  return DEFAULT_SANDBOX;
}

/** 只读模式：写类工具换成直接回 read_only 错误的版本（描述里也标出来，模型少走弯路）。 */
export function applySandbox(tools: AgentTool[], mode: SandboxMode): AgentTool[] {
  if (mode !== "read_only") return tools;
  return tools.map((tool) => {
    if (READ_ONLY_TOOLS.has(tool.name)) return tool;
    const actions = READ_ONLY_ACTIONS[tool.name];
    if (actions) {
      return {
        ...tool,
        description: `【只读模式下只能 ${[...actions].join(" / ")}】${tool.description}`,
        async execute(args, context) {
          return isReadOnlyCall(tool.name, args) ? tool.execute(args, context) : failureResult(readOnlyFailure(`${tool.name}(action=${String(args.action)})`));
        },
      };
    }
    return {
      ...tool,
      description: `【只读模式下不可用】${tool.description}`,
      async execute() {
        return failureResult(readOnlyFailure(tool.name));
      },
    };
  });
}
