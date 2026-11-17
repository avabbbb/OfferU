// Release smoke for the TS companion (replaces backend/scripts/e2e/test_public_release_*.py).
//
// Starts the companion from source on an isolated data dir and port, then walks the main
// new-user journeys over HTTP the way the workbench does, and (when a Chromium is available
// to playwright-core and OFFERU_E2E_BASE_URL is set) opens the workbench and checks it reaches
// the backend. Writes server.log / responses into OFFERU_E2E_ARTIFACT_DIR for the secret audit.
//
//   node scripts/e2e/smoke.mjs                 API journeys only
//   OFFERU_E2E_BASE_URL=http://127.0.0.1:7410 node scripts/e2e/smoke.mjs   + browser check
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.OFFERU_E2E_PORT || 8766);
const api = `http://127.0.0.1:${port}`;
const artifacts = resolve(process.env.OFFERU_E2E_ARTIFACT_DIR || mkdtempSync(join(tmpdir(), "offeru-e2e-")));
const dataDir = mkdtempSync(join(tmpdir(), "offeru-e2e-data-"));
const version = JSON.parse(readFileSync(join(root, "frontend/package.json"), "utf8")).version;
// A canary that must never show up in diagnostics, exports or logs.
const CANARY_KEY = "sk-OFFERU_SMOKE_SECRET_canary0123456789";
mkdirSync(artifacts, { recursive: true });

let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function call(method, path, body, headers = {}) {
  const response = await fetch(api + path, {
    method,
    redirect: "error",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Origin: "http://127.0.0.1:7410", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body: json, text };
}

const log = createWriteStream(join(artifacts, "server.log"));
const server = spawn(process.execPath, ["--import", "tsx", "src/server-main.ts"], {
  cwd: join(root, "backend-ts"),
  env: { ...process.env, OFFERU_DATA_DIR: dataDir, OFFERU_PORT: String(port), OFFERU_VERSION: version, OFFERU_RUNTIME_MODE: "local", NODE_NO_WARNINGS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
let exited = false;
server.once("exit", () => { exited = true; });

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error("companion exited before it became healthy (see server.log)");
    if (Date.now() > deadline) throw new Error("companion did not become healthy within 60 s");
    try {
      const health = await call("GET", "/api/health");
      if (health.status === 200) break;
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 500));
  }

  await step("health identifies the TS companion", async () => {
    const { body } = await call("GET", "/api/health");
    assert(body.status === "ok" && body.service === "OfferU" && body.runtime === "node", "unexpected health payload");
    assert(body.version === version, `version ${body.version} != ${version}`);
    assert(body.build_mode === "local-development" && body.build_identity?.build_source === "source", "build identity missing");
  });

  await step("new user: empty overview and empty states", async () => {
    const overview = await call("POST", "/api/tools/overview", {});
    assert(overview.status === 200 && overview.body.jobs, "overview failed");
    for (const path of ["/api/interviews/reviews", "/api/interview/experiences", "/api/agent/runtime/career-tasks", "/api/agent/runtime/hosted-sessions", "/api/agent/conversations"]) {
      const response = await call("GET", path);
      assert(response.status === 200, `${path} → ${response.status}`);
    }
    const config = await call("GET", "/api/config/");
    assert(config.status === 200 && Array.isArray(config.body.llm_api_configs), "config failed");
  });

  await step("model key is stored and never echoed", async () => {
    const saved = await call("PUT", "/api/config/", { llm_api_configs: [{ provider_id: "deepseek", service_name: "DeepSeek", base_url: "https://api.deepseek.com", api_key: CANARY_KEY, model: "deepseek-chat", is_active: true }] });
    assert(saved.status === 200, `config save → ${saved.status}`);
    assert(!saved.text.includes(CANARY_KEY), "config response echoed the key");
  });

  let jobId = 0;
  await step("jobs: save, list, move status, undo", async () => {
    const saved = await call("POST", "/api/tools/save", { type: "job", data: { company: "冒烟公司", title: "产品实习", status: "saved" } });
    assert(saved.status === 200, `save → ${saved.status} ${saved.text}`);
    jobId = saved.body.record.id;
    const moved = await call("POST", "/api/tools/save", { type: "job", id: jobId, data: { status: "applied" } });
    assert(moved.status === 200 && moved.body.record.status === "applied", "status change failed");
    const listed = await call("POST", "/api/tools/list", { type: "job" });
    assert(listed.body.total === 1, "list did not return the job");
    const undone = await call("POST", "/api/tools/undo", { change_id: moved.body.change_id });
    assert(undone.status === 200, `undo → ${undone.status} ${undone.text}`);
    assert((await call("POST", "/api/tools/get", { type: "job", id: jobId })).body.record.status === "saved", "undo did not restore the status");
  });

  await step("interview review: create, update, weak spots, delete", async () => {
    const created = await call("POST", "/api/interviews/reviews", { company: "冒烟公司", role: "产品", round_label: "一面", questions: [{ question: "自我介绍", answer: "", reflection: "卡住了", reaction: "" }] });
    assert(created.status === 200, `create → ${created.status} ${created.text}`);
    const id = created.body.id;
    assert((await call("PUT", `/api/interviews/reviews/${id}`, { company: "冒烟公司", role: "产品", outcome: "passed" })).body.outcome === "passed", "update failed");
    assert((await call("GET", "/api/interviews/reviews/weak-spots")).status === 200, "weak spots failed");
    assert((await call("DELETE", `/api/interviews/reviews/${id}`)).body.deleted === id, "delete failed");
  });

  await step("model-dependent features say no model instead of failing", async () => {
    const runtime = await call("GET", "/api/interviews/runtime");
    assert([200, 501].includes(runtime.status), `interviews runtime → ${runtime.status}`);
  });

  await step("data safety: backup, integrity, export/import round trip", async () => {
    const backup = await call("POST", "/api/agent/data/backups");
    assert(backup.status === 200 && backup.body.backup_id, "backup failed");
    const integrity = await call("GET", "/api/agent/data/safety/integrity");
    assert(integrity.body.status === "ok", "integrity not ok");
    const exported = await call("GET", "/api/data/export");
    assert(exported.status === 200 && exported.body.format === "offeru-data", "export failed");
    writeFileSync(join(artifacts, "export.json"), exported.text);
    const imported = await call("POST", "/api/data/import", exported.body);
    assert(imported.status === 200, `import → ${imported.status} ${imported.text}`);
  });

  await step("diagnostics carry no user content or key", async () => {
    const bundle = await call("GET", "/api/agent/diagnostics/bundle");
    assert(bundle.status === 200, "bundle failed");
    writeFileSync(join(artifacts, "diagnostics.json"), bundle.text);
    assert(!bundle.text.includes("冒烟公司") && !bundle.text.includes(CANARY_KEY), "diagnostics leak content");
    const identity = await call("GET", "/api/diagnostics/runtime-identity");
    assert(identity.status === 200 && identity.body.runtime_type === "local", "runtime identity failed");
  });

  await step("showcase origin needs the pairing token", async () => {
    const denied = await call("GET", "/api/tools", undefined, { Origin: "https://offeru.avabbbb.com" });
    assert(denied.status === 403, `bridge origin without token → ${denied.status}`);
  });

  await step("fresh reset backs up, then empties the workspace", async () => {
    const reset = await call("POST", "/api/agent/data/fresh-reset");
    assert(reset.status === 200 && reset.body.backup?.backup_id, `reset → ${reset.status}`);
    assert((await call("POST", "/api/tools/list", { type: "job" })).body.total === 0, "jobs left after reset");
  });

  if (process.env.OFFERU_E2E_BASE_URL) {
    await step("workbench opens and reaches the companion", async () => {
      const { chromium } = await import(join(root, "backend-ts/node_modules/playwright-core/index.mjs"));
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let healthOk = false;
        page.on("response", (response) => {
          if (response.url().endsWith("/api/health") && response.status() === 200) healthOk = true;
        });
        await page.goto(process.env.OFFERU_E2E_BASE_URL, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: join(artifacts, "workbench.png"), fullPage: true });
        assert(healthOk, "the page never got a healthy /api/health");
        assert(!errors.length, `page errors: ${errors.join(" | ")}`);
        assert((await page.content()).includes("OfferU"), "page does not look like OfferU");
      } finally {
        await browser.close();
      }
    });
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  server.kill("SIGTERM");
  log.end();
}

console.log(failures ? `${failures} smoke step(s) failed; artifacts in ${artifacts}` : `companion smoke passed; artifacts in ${artifacts}`);
process.exitCode = failures ? 1 : 0;
