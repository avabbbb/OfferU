import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "offeru-cli-"));
  dirs.push(dir);
  return dir;
}

function cli(dir: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string }>((done) => {
    // No OFFERU_LLM_* from the developer's shell: the model must come from the saved settings.
    const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OFFERU_LLM_")));
    execFile(process.execPath, ["--import", "tsx", join(here, "../src/cli.ts"), ...args], {
      cwd: join(here, ".."),
      env: { ...base, OFFERU_DATA_DIR: dir, OFFERU_DB_PATH: join(dir, "offeru.db"), ...env },
    }, (error, stdout) => done({ code: error ? Number(error.code) : 0, out: stdout }));
  });
}

/** An OpenAI-compatible endpoint that answers every chat with one resume item. */
function fakeModel(): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const content = JSON.stringify({ items: [{ kind: "skill", title: "SQL", description: "会写 SQL" }] });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
  });
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies })));
}

describe("CLI", () => {
  it("model tools use the model saved in the workbench settings, not only OFFERU_LLM_* env", async () => {
    const dir = dataDir();
    const model = await fakeModel();
    writeFileSync(join(dir, "offeru-ts-config.json"), JSON.stringify({
      llm_api_configs: [{ id: "local", provider_id: "custom", service_name: "Fake", base_url: model.url, model: "fake-model", api_key: "sk-test", models: {} }],
      active_llm_config_id: "local",
    }));
    const result = await cli(dir, ["tool", "split_resume", JSON.stringify({ text: "技能：SQL" })]);
    expect(model.bodies.length).toBeGreaterThan(0);
    expect(model.bodies[0].model).toBe("fake-model");
    expect(result.out).not.toContain("没配模型");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ count: 1 });
  }, 60_000);

  it("`offeru sync` reports status and fails with {error, code} before it is set up", async () => {
    const dir = dataDir();
    const [status, now, bad, unknown] = await Promise.all([
      cli(dir, ["sync"]),
      cli(dir, ["sync", "now"]),
      cli(dir, ["sync", "configure", JSON.stringify({ bucket: "b", passphrase: "short" })]),
      cli(dir, ["sync", "nope"]),
    ]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ configured: false, syncing: false, pending: null });
    expect(now.code).toBe(1);
    expect(JSON.parse(now.out)).toMatchObject({ code: "sync_config" });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).error).toContain("至少 8 个字符");
    expect(unknown.code).toBe(2);
  }, 60_000);
});
