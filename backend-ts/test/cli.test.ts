import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { MemoryS3, openPairing } from "@offeru/sync";

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

/** MemoryS3 behind a real HTTP port, so the CLI process can reach it as an S3 endpoint. */
function s3Server(s3: MemoryS3): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value)]));
      const response = await s3.fetch(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function cli(dir: string, args: string[], env: Record<string, string> = {}, stdin?: string) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    // No OFFERU_LLM_* from the developer's shell: the model must come from the saved settings.
    const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OFFERU_LLM_")));
    const child = execFile(process.execPath, ["--import", "tsx", join(here, "../src/cli.ts"), ...args], {
      cwd: join(here, ".."),
      env: { ...base, OFFERU_DATA_DIR: dir, OFFERU_DB_PATH: join(dir, "offeru.db"), ...env },
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, out: stdout, err: stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
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

  it("no model configured: model calls are handed to the calling Agent and its answers finish the tool", async () => {
    const dir = dataDir();
    const args = ["tool", "split_resume", JSON.stringify({ text: "技能：SQL" })];
    const first = await cli(dir, args);
    expect(first.code).toBe(0);
    const { handoff } = JSON.parse(first.out) as { handoff: { how: string; pending: Array<{ id: string; json: boolean; messages: Array<{ role: string; content: string }> }> } };
    expect(handoff.how).toContain("--answers");
    expect(handoff.pending).toHaveLength(1);
    expect(handoff.pending[0].json).toBe(true);
    // The calling Agent sees the user's real text (no desensitizing placeholders).
    expect(handoff.pending[0].messages.at(-1)?.content).toContain("技能：SQL");
    // Nothing written while the answer is pending.
    expect(JSON.parse((await cli(dir, ["tool", "list", "{\"type\":\"memory\"}"])).out).items).toEqual([]);
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ [handoff.pending[0].id]: JSON.stringify({ items: [{ kind: "skill", title: "SQL", description: "会写 SQL" }] }) }));
    const second = await cli(dir, [...args, "--answers", `@${answers}`]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ count: 1 });
  }, 60_000);

  it("`offeru tool` failures carry a stable code next to the Chinese error", async () => {
    const dir = dataDir();
    const noSearch = { BOCHA_API_KEY: "", TAVILY_API_KEY: "", SERPER_API_KEY: "" };
    const [unconfigured, broken] = await Promise.all([
      cli(dir, ["tool", "web_search", JSON.stringify({ query: "飞书 招聘" })], noSearch),
      cli(dir, ["tool", "list", "{nope"]),
    ]);
    expect(unconfigured.code).toBe(1);
    expect(JSON.parse(unconfigured.out)).toMatchObject({ code: "not_configured", error: expect.stringContaining("BOCHA_API_KEY") });
    expect(JSON.parse(unconfigured.out).error).not.toContain("ddgs");
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.out)).toMatchObject({ code: "invalid", error: expect.stringContaining("参数不是合法 JSON") });
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

  it("`offeru sync pair`: configure by flags + env, then a link the web opens only with the passphrase", async () => {
    const dir = dataDir();
    const before = await cli(dir, ["sync", "pair", "--json"]);
    expect(before.code).toBe(1);
    expect(JSON.parse(before.out)).toMatchObject({ code: "not_configured", hint: expect.stringContaining("offeru sync configure") });

    const s3 = new MemoryS3();
    const endpoint = await s3Server(s3);
    const passphrase = "agent-generated long passphrase 7Q";
    const configured = await cli(dir, [
      "sync", "configure", "--endpoint", endpoint, "--bucket", s3.bucket, "--region", "auto", "--access-key-id", s3.accessKeyId, "--path-style",
    ], { OFFERU_SYNC_SECRET_ACCESS_KEY: "the-secret-key", OFFERU_SYNC_PASSPHRASE: passphrase });
    expect(configured.code, configured.out).toBe(0);
    expect(configured.out).not.toContain("the-secret-key");
    expect(configured.out).not.toContain(passphrase);
    expect(JSON.parse(configured.out)).toMatchObject({ configured: true, config: { bucket: s3.bucket, prefix: "offeru", pathStyle: true } });
    expect(s3.keys("offeru/")).toContain("offeru/offeru-sync.json");

    const [json, plain] = await Promise.all([
      cli(dir, ["sync", "pair", "--json", "--web-origin", "http://localhost:7410"]),
      cli(dir, ["sync", "pair"]),
    ]);
    expect(json.code).toBe(0);
    const link = JSON.parse(json.out) as { url: string; expires_at: string };
    expect(link.url).toMatch(/^http:\/\/localhost:7410\/#\/sync\/pair\?c=[A-Za-z0-9_-]+$/);
    expect(link.url).not.toContain("the-secret-key");
    const minutes = (Date.parse(link.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);
    expect(plain.out.trim()).toMatch(/^https:\/\/offeru\.avabbbb\.com\/#\/sync\/pair\?c=/);
    expect(plain.err).toContain("同步口令");

    const code = new URL(link.url).hash.split("?c=")[1];
    await expect(openPairing(code, passphrase)).resolves.toMatchObject({
      v: 1, endpoint, bucket: s3.bucket, region: "auto", prefix: "offeru", pathStyle: true, accessKeyId: s3.accessKeyId, secretAccessKey: "the-secret-key",
    });
    await expect(openPairing(code, "not the passphrase")).rejects.toMatchObject({ code: "passphrase" });
    await expect(openPairing(code, passphrase, { now: new Date(Date.parse(link.expires_at) + 1) })).rejects.toMatchObject({ code: "expired" });

    const bad = await cli(dir, ["sync", "pair", "--web-origin", "offeru.avabbbb.com/x"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ code: "invalid" });

    // JSON on stdin is the other secret-safe path; the passphrase must match the bucket.
    const stdin = await cli(dir, ["sync", "configure", "-"], {}, JSON.stringify({ endpoint, bucket: s3.bucket, region: "auto", accessKeyId: s3.accessKeyId, secretAccessKey: "the-secret-key", passphrase: "a different passphrase" }));
    expect(stdin.code).toBe(1);
    expect(JSON.parse(stdin.out)).toMatchObject({ code: "sync_passphrase" });
  }, 90_000);

  it("a pasted invite email maps to job status + event with link through `offeru tool`", async () => {
    const dir = dataDir();
    const run = async (name: string, args: unknown) => JSON.parse((await cli(dir, ["tool", name, JSON.stringify(args)])).out);
    await run("save", { type: "job", data: { company: "美团", title: "数据分析实习", status: "applied" } });
    const hit = (await run("search", { query: "美团" })).items.find((item: { type: string }) => item.type === "job");
    await run("save", { type: "job", id: hit.id, data: { status: "test" } });
    await run("save", { type: "event", data: { title: "美团笔试", kind: "test", at: "2026-12-05T19:00", job_id: hit.id, url: "https://exam.example.com/mt" } });
    const got = await run("get", { type: "job", id: hit.id });
    expect(got.record.status).toBe("test");
    expect(got.events).toEqual([expect.objectContaining({ kind: "test", at: "2026-12-05T19:00", url: "https://exam.example.com/mt" })]);
  }, 60_000);
});
