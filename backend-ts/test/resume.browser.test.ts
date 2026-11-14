// TO C web page = "browser transport": the same Hono app (src/app.ts) runs in the page with an in-memory /
// IndexedDB store, a browser FileStore, the user's own model key and no Chromium. These tests build exactly that
// (no SQLite, no disk, no node:* in the app's import graph) and run render / tailor / impact / logos / pdf through it.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  memoryFileStore,
  searchSchoolLogos,
  staticSchoolLogos,
  type ChangeRow,
  type CoreStore,
  type Json,
  type LlmClient,
  type PutOptions,
  type RecordType,
  type StoredRecord,
} from "@offeru/core";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal in-memory CoreStore, the shape the IndexedDB store has in the page. */
class MemoryStore implements CoreStore {
  records: StoredRecord[] = [];
  rows: ChangeRow[] = [];
  next = 1;
  nextChange = 1;
  async all(type: RecordType, jobId?: number | null) {
    return this.records.filter((r) => r.type === type && (jobId === undefined || r.job_id === jobId))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
  }
  async get(type: RecordType, id: number) {
    return this.records.find((r) => r.type === type && r.id === id) ?? null;
  }
  async first(type: RecordType) {
    return this.records.filter((r) => r.type === type).sort((a, b) => a.id - b.id)[0] ?? null;
  }
  async put(type: RecordType, data: Json, options: PutOptions) {
    const existing = options.id === undefined ? null : await this.get(type, options.id);
    if (existing) {
      const merged = { ...(options.replace ? {} : existing), ...data, id: existing.id, type, job_id: options.jobId === undefined ? existing.job_id : options.jobId, created_at: existing.created_at, updated_at: options.now } as StoredRecord;
      this.records = this.records.map((r) => (r === existing ? merged : r));
      return merged;
    }
    const record = { ...data, id: options.id ?? this.next++, type, job_id: options.jobId ?? null, created_at: options.createdAt ?? options.now, updated_at: options.now } as StoredRecord;
    this.records.push(record);
    return record;
  }
  async remove(type: RecordType, id: number) {
    this.records = this.records.filter((r) => !(r.type === type && r.id === id));
  }
  async changes(limit: number) {
    return [...this.rows].sort((a, b) => b.id - a.id).slice(0, limit);
  }
  async getChange(id: number) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async lastChange() {
    return (await this.changes(1))[0] ?? null;
  }
  async addChange(row: Omit<ChangeRow, "id" | "undone_at">) {
    const id = this.nextChange++;
    this.rows.push({ ...row, id, undone_at: null });
    return id;
  }
  async updateChange(id: number, patch: Partial<Pick<ChangeRow, "at" | "after" | "undone_at">>) {
    Object.assign(this.rows.find((r) => r.id === id)!, patch);
  }
  async transaction<T>(fn: () => Promise<T>) {
    const records = structuredClone(this.records);
    const rows = structuredClone(this.rows);
    try {
      return await fn();
    } catch (error) {
      this.records = records;
      this.rows = rows;
      throw error;
    }
  }
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
}

/** Every file reachable from src/app.ts through relative imports (and @offeru/core's src). */
function graph(entry: string, coreRoot: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const specs = importsOf(file);
    seen.set(file, specs);
    for (const spec of specs) {
      let target: string | null = null;
      if (spec.startsWith(".")) target = resolve(dirname(file), spec);
      else if (spec === "@offeru/core") target = join(coreRoot, "index");
      if (!target) continue;
      for (const candidate of [target + ".ts", join(target, "index.ts"), target]) {
        try {
          readFileSync(candidate);
          stack.push(candidate);
          break;
        } catch {
          // try next
        }
      }
    }
  }
  return seen;
}

const SSE_EVENTS = (text: string) => text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));

describe("resume on the web (browser transport)", () => {
  it("the app's import graph has no node:* or native modules", () => {
    const files = graph(resolve(here, "../src/app.ts"), resolve(here, "../../packages/core/src"));
    const offenders = [...files].flatMap(([file, specs]) => specs.filter((s) => s.startsWith("node:") || ["fs", "path", "child_process"].includes(s)).map((s) => `${file}: ${s}`));
    expect(offenders).toEqual([]);
    expect([...files.keys()].some((f) => f.includes("routes/resume"))).toBe(true);
    // school-logo PNGs are not bundled: only the search index is in the graph
    expect([...files.keys()].some((f) => f.includes("assets/school_logos"))).toBe(false);
  });

  it("render → tailor (SSE, user's key) → impact → logos → pdf falls back to window.print (501)", async () => {
    const store = new MemoryStore();
    const files = memoryFileStore();
    const replies = ['{"edits": [], "notes": {}, "asks": []}', '{"drafts": [{"index": 0, "memory_id": null, "title": "后端", "add": "QPS 提升一倍"}]}'];
    let call = 0;
    const llm: LlmClient = {
      async chat(_messages, options) {
        return options?.json ? replies[call++ === 0 ? 0 : 1] : "# 张三\n\n## 实习\n### 字节 | 后端\n- 接口 QPS 提升 30%\n";
      },
      async *chatStream() {
        yield "# 张三\n\n## 实习\n";
        yield "### 字节 | 后端\n- 接口 QPS 提升 30%\n";
      },
    };
    const fetched: string[] = [];
    const logoPng = new Uint8Array(readFileSync(resolve(here, "../assets/school_logos/0528.png")));
    const schoolLogos = staticSchoolLogos("https://offeru.example/school-logos/", async (url) => {
      fetched.push(url);
      return { ok: url.endsWith("/0528.png"), arrayBuffer: async () => logoPng.slice().buffer };
    });
    const app = createApp({ store, runtime: "worker", storage: "none", files, llm: () => llm, schoolLogos });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const html = await (await post("/api/resume/render", { resume: { basics: { name: "张三" }, sections: [] }, style: { template: "kami" } })).text();
    expect(html).toContain("<h1");

    await post("/api/tools/save", { type: "memory", data: { kind: "experience", title: "字节后端实习", body: "接口 QPS 提升 30%" } });
    const job = (await (await post("/api/tools/save", { type: "job", data: { company: "美团", title: "后端", jd: "Go 后端" } })).json()) as { record: { id: number } };
    const doc = (await (await post("/api/tools/save", { type: "doc", data: { kind: "resume", title: "主简历", body: "# 张三\n\n## 教育\n" } })).json()) as { record: { id: number } };
    const events = SSE_EVENTS(await (await post(`/api/resume/${doc.record.id}/tailor`, { job_id: job.record.id })).text());
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "review", "done"]);
    expect(events.at(-1).body).toContain("接口 QPS 提升 30%");

    const impact = await post("/api/resume/impact", { answers: [{ old: "- 接口 QPS 提升 30%", question: "?", answer: "QPS 提升一倍" }] });
    expect(impact.status).toBe(200);

    const search = (await (await app.request("/api/resume/assets/school-logos?q=" + encodeURIComponent("浙大"))).json()) as { items: Array<{ file: string }> };
    expect(search.items).toEqual(searchSchoolLogos("浙大"));
    const used = (await (await post(`/api/resume/assets/school-logos/${search.items[0].file}/use`, {})).json()) as { name: string };
    expect(used.name).toBe("logo-0528.png");
    expect(fetched).toEqual(["https://offeru.example/school-logos/0528.png"]);
    expect(files.files.has("logo-0528.png")).toBe(true);

    const pdf = await app.request(`/api/resume/${doc.record.id}/pdf`);
    expect(pdf.status).toBe(501);
  });
});
