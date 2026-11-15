import type { Hono } from "hono";
import { CoreError } from "@offeru/core";

import type { AppEnv } from "../../app";
import type { BossLogin } from "./boss-cli";

/**
 * BOSS 直聘 QR login for the settings page (Python routes/boss.py, mounted at
 * /api/applications). Node companion only: the CLI module is imported lazily so
 * this registration is safe in the Worker bundle, where it answers 501.
 */
let login: Promise<BossLogin> | null = null;

async function service(runtime: string): Promise<BossLogin> {
  if (runtime !== "node") throw new CoreError("BOSS 扫码登录只在本机 OfferU 里可用", "unsupported");
  login ??= import("./boss-cli").then(({ BossLogin: Login }) => new Login());
  return login;
}

const ACTIONS = ["start", "cancel", "logout"] as const;

export function registerBossLogin(app: Hono<AppEnv>): void {
  app.get("/api/applications/boss-login", async (c) => c.json(await (await service(c.get("deps").runtime)).view()));

  app.post("/api/applications/boss-login/:action", async (c) => {
    const action = c.req.param("action");
    if (!(ACTIONS as readonly string[]).includes(action)) throw new CoreError("action 只能是 start / cancel / logout");
    const boss = await service(c.get("deps").runtime);
    const view = action === "start" ? await boss.start() : action === "cancel" ? await boss.cancel() : await boss.logout();
    return c.json(view);
  });
}
