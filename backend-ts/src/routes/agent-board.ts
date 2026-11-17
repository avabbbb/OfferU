import type { Hono } from "hono";
import { CoreError } from "@offeru/core";

import { jsonBody, type AppDeps, type AppEnv } from "../app";

/** What the companion implements (routes/companion/agent-board.ts). */
export interface AgentBoardService {
  list(): Promise<Record<string, unknown>>;
  add(raw: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(id: string, raw: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(id: string): Promise<Record<string, unknown>>;
  setHidden(id: string, hidden: boolean): Promise<Record<string, unknown>>;
  connect(id: string, action: string): Promise<Record<string, unknown>>;
  check(id: string): Promise<Record<string, unknown>>;
  launch(id: string): Promise<Record<string, unknown>>;
  /** MCP client name / CLI actor → board Agent; records the call. "" when none matches. */
  recordClientCall(client: string): Promise<string>;
}

function board(deps: AppDeps): AgentBoardService {
  if (!deps.agentBoard) throw new CoreError("Agent 看板管理的是本机装的 Agent，只在本机 OfferU 里可用", "unsupported");
  return deps.agentBoard;
}

const FIELDS = ["id", "display_name", "executable", "skill_root"] as const;
const LIMITS: Record<string, number> = { id: 40, display_name: 60, executable: 80, skill_root: 500 };

/** CustomAgentRequest: known string fields with Python's max_length; exclude_unset on PATCH. */
function customBody(raw: unknown, keepUnset: boolean): Record<string, unknown> {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (!(key in body)) {
      if (keepUnset) out[key] = "";
      continue;
    }
    const value = body[key];
    if (typeof value !== "string") throw new CoreError(`${key} 要是字符串`);
    if (value.length > LIMITS[key]) throw new CoreError(`${key} 最长 ${LIMITS[key]} 个字符`);
    out[key] = value;
  }
  return out;
}

/**
 * /api/agent-board — Python routes/agent_board.py. Runtime-agnostic module; the
 * board itself is companion-only (AppDeps.agentBoard), so the web answers 501.
 * Launch opens a terminal on the user's machine, so it needs
 * `Authorization: Bearer <pairing token>` (Python: the UI approval token).
 */
export function registerAgentBoard(app: Hono<AppEnv>): void {
  app.get("/api/agent-board", async (c) => c.json(await board(c.get("deps")).list()));
  app.post("/api/agent-board", async (c) => c.json(await board(c.get("deps")).add(customBody(await jsonBody(c), true))));
  app.patch("/api/agent-board/:id", async (c) => {
    const body = customBody(await jsonBody(c), false);
    delete body.id;
    return c.json(await board(c.get("deps")).update(c.req.param("id"), body));
  });
  app.delete("/api/agent-board/:id", async (c) => c.json(await board(c.get("deps")).remove(c.req.param("id"))));
  app.post("/api/agent-board/:id/hidden", async (c) => {
    const body = await jsonBody(c) as { hidden?: unknown };
    if (typeof body?.hidden !== "boolean") throw new CoreError("hidden 要是 true / false");
    return c.json(await board(c.get("deps")).setHidden(c.req.param("id"), body.hidden));
  });
  app.post("/api/agent-board/:id/connect", async (c) => {
    const body = await jsonBody(c) as { action?: unknown };
    const action = body?.action === undefined ? "install" : String(body.action);
    if (!/^(install|update|repair)$/.test(action)) throw new CoreError("连接动作只支持 install、update 或 repair");
    return c.json(await board(c.get("deps")).connect(c.req.param("id"), action));
  });
  app.post("/api/agent-board/:id/check", async (c) => c.json(await board(c.get("deps")).check(c.req.param("id"))));
  app.post("/api/agent-board/:id/launch", async (c) => {
    const deps = c.get("deps");
    const service = board(deps);
    const [scheme, token] = (c.req.header("authorization") || "").split(" ");
    const accepted = [deps.pairingToken?.(), deps.approvalToken?.()].filter((value): value is string => Boolean(value));
    if (scheme?.toLowerCase() !== "bearer" || !token || !accepted.includes(token)) {
      throw new CoreError("只能在 OfferU 工作台里打开对话", "forbidden");
    }
    return c.json(await service.launch(c.req.param("id")));
  });
}
