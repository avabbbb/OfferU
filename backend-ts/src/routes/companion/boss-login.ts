import type { Hono } from "hono";
import { CoreError } from "@offeru/core";

import type { AppEnv } from "../../app";

/** What the settings page drives; the Node companion implements it with the boss CLI (./boss-cli). */
export interface BossLoginService {
  view(): Promise<unknown> | unknown;
  start(): Promise<unknown>;
  cancel(): Promise<unknown>;
  logout(): Promise<unknown>;
}

/**
 * BOSS 直聘 QR login for the settings page (Python routes/boss.py, mounted at
 * /api/applications). Companion-only: the service is injected as
 * AppDeps.bossLogin by the Node entry; this module imports nothing from node:*
 * so the Worker bundle stays clean and answers 501.
 */
async function service(deps: AppEnv["Variables"]["deps"]): Promise<BossLoginService> {
  if (!deps.bossLogin) throw new CoreError("BOSS 扫码登录只在本机 OfferU 里可用", "unsupported");
  return deps.bossLogin();
}

const ACTIONS = ["start", "cancel", "logout"] as const;

export function registerBossLogin(app: Hono<AppEnv>): void {
  app.get("/api/applications/boss-login", async (c) => c.json(await (await service(c.get("deps"))).view()));

  app.post("/api/applications/boss-login/:action", async (c) => {
    const action = c.req.param("action");
    if (!(ACTIONS as readonly string[]).includes(action)) throw new CoreError("action 只能是 start / cancel / logout");
    const boss = await service(c.get("deps"));
    const view = action === "start" ? await boss.start() : action === "cancel" ? await boss.cancel() : await boss.logout();
    return c.json(view);
  });
}
