// Agent board (companion-only) vs Python services/agent_board.py golden (fixtures/agent-board/gen_agent_board.py):
// same throwaway HOME, PATH with fake codex / workbuddy, same process listing.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { matchClient, normalizeBoard } from "@offeru/core";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { NodeAgentBoard } from "../src/routes/companion/agent-board";
import { SqliteCoreStore } from "../src/store";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures/agent-board/agent-board.json"), "utf8"));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "data-"));
  const bin = mkdtempSync(join(tmpdir(), "bin-"));
  for (const name of ["codex", "workbuddy"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }
  const launched: string[] = [];
  const board = new NodeAgentBoard({
    dataDir, home, env: { PATH: bin }, toolCommand: "offeru-test",
    processListing: async () => golden.processes,
    openTerminal: async (exe) => { launched.push(exe); },
  });
  const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === "at" ? undefined : v)).split(home).join("~"));
  return { board, home, dataDir, bin, launched, scrub };
}

async function attempt(fn: () => Promise<unknown>, scrub: (v: unknown) => unknown) {
  try {
    return { ok: scrub(await fn()) };
  } catch (error) {
    return { error: scrub((error as Error).message) };
  }
}

describe("agent board matches Python agent_board.py", () => {
  it("runs the same steps to the same rows and messages", async () => {
    const { board, scrub } = setup();
    const steps: Record<string, () => Promise<unknown>> = {
      list_empty: () => board.list(),
      add_bad_id: () => board.add({ id: "Bad Id", display_name: "x", skill_root: "~/.wb/skills" }),
      add_builtin: () => board.add({ id: "codex", display_name: "x", skill_root: "~/.wb/skills" }),
      add_no_name: () => board.add({ id: "wb", display_name: " ", skill_root: "~/.wb/skills" }),
      add_bad_exe: () => board.add({ id: "wb", display_name: "WorkBuddy", executable: "/usr/bin/wb", skill_root: "~/.wb/skills" }),
      add_outside_home: () => board.add({ id: "wb", display_name: "WorkBuddy", skill_root: "/etc/skills" }),
      add_relative: () => board.add({ id: "wb", display_name: "WorkBuddy", skill_root: "skills" }),
      add: () => board.add({ id: "WB", display_name: "WorkBuddy", executable: "workbuddy", skill_root: "~/.wb/skills" }),
      add_dup: () => board.add({ id: "wb", display_name: "WorkBuddy", skill_root: "~/.wb/skills" }),
      edit_builtin: () => board.update("codex", { display_name: "x" }),
      edit: () => board.update("wb", { display_name: "WorkBuddy CLI" }),
      connect_codex: () => board.connect("codex", "install"),
      connect_bad_action: () => board.connect("codex", "nuke"),
      connect_unknown: () => board.connect("nobody", "install"),
      hide_claude: () => board.setHidden("claude", true),
      check_wb: () => board.check("wb"),
      list_full: () => board.list(),
      remove_builtin: () => board.remove("codex"),
      remove: () => board.remove("wb"),
    };
    for (const want of golden.steps) {
      const { name, ...expected } = want;
      expect(await attempt(steps[name], scrub), name).toEqual(expected);
    }
  });

  it("maps MCP client names to board Agents like _match_client", () => {
    const data = normalizeBoard({ custom: [{ id: "wb", display_name: "WorkBuddy", executable: "workbuddy", skill_root: "/x" }] });
    for (const [client, id] of Object.entries(golden.match_client)) expect(matchClient(data, client.trim().toLowerCase()), client).toBe(id);
  });

  it("installs the Skill with the install's command filled in, and records MCP calls", async () => {
    const { board, home } = setup();
    await board.connect("codex", "install");
    const skill = readFileSync(join(home, ".codex/skills/offeru/SKILL.md"), "utf8");
    expect(skill).toContain("name: offeru");
    expect(skill).toContain("offeru-test tool overview");
    expect(skill).not.toContain("<offeru>");
    expect(await board.recordClientCall("Codex-MCP-Client")).toBe("codex");
    const row = (await board.list()).agents.find((a) => a.id === "codex")!;
    expect(row).toMatchObject({ running: true, connected: true, last_call: { client: "codex-mcp-client" } });
  });
});

describe("/api/agent-board", () => {
  it("serves the board on the companion; launch needs the pairing token", async () => {
    const { board, launched, bin } = setup();
    const store = new SqliteCoreStore(":memory:");
    const app = createApp({ store, runtime: "node", storage: "sqlite", agentBoard: board, pairingToken: () => "secret" });
    expect((await app.request("/api/agent-board")).status).toBe(200);
    const added = await app.request("/api/agent-board", { method: "POST", body: JSON.stringify({ id: "wb", display_name: "WB", executable: "workbuddy", skill_root: "/etc" }) });
    expect(added.status).toBe(400);
    expect((await app.request("/api/agent-board/codex/hidden", { method: "POST", body: JSON.stringify({ hidden: "yes" }) })).status).toBe(400);
    expect((await app.request("/api/agent-board/codex/launch", { method: "POST" })).status).toBe(403);
    const ok = await app.request("/api/agent-board/codex/launch", { method: "POST", headers: { Authorization: "Bearer secret" } });
    expect(await ok.json()).toEqual({ launched: true, executable: join(bin, "codex") });
    expect(launched).toEqual([join(bin, "codex")]);
    store.close();
  });

  it("is 501 off the companion", async () => {
    const store = new SqliteCoreStore(":memory:");
    const web = createApp({ store, runtime: "worker", storage: "none" });
    expect((await web.request("/api/agent-board")).status).toBe(501);
    store.close();
  });
});
