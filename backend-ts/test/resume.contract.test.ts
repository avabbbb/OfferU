// Contract tests for the resume domain: TS output must equal the Python golden outputs
// (test/fixtures/resume/golden.json, regenerate with `cd backend && python ../backend-ts/test/fixtures/resume/gen_golden.py`).
// Covers CSS, markdown ⇄ structure, normalize errors, style checks, inline markup (incl. ++underline++), render /
// doc_html byte-for-byte, verify / retained / omitted, impact (fake model), tailor pure parts + full run (fake model),
// school-logo search, logo cut-out, and the HTTP layer (SSE, 400s, files, pdf without a browser = 501).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEdits,
  captureImpact,
  checkResumeFacts,
  checkStyle,
  cleanDraft,
  figuresFor,
  impactFlags,
  impactNumbers,
  inlineHtml,
  memoryFileStore,
  normalizeResume,
  omittedMemories,
  parseReview,
  pickAsks,
  renderResumeHtml,
  resolveStyle,
  resumeDocHtml,
  resumeFileName,
  resumeFromMarkdown,
  resumeToMarkdown,
  retainedFacts,
  runTailor,
  safeStem,
  searchSchoolLogos,
  templateCss,
  type LlmClient,
  type LlmMessage,
  type PageRenderer,
} from "@offeru/core";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppDeps } from "../src/app";
import { transparentLogo } from "../src/routes/resume/image";
import { SqliteCoreStore } from "../src/store";
import { callTool } from "../src/tools";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G: any = JSON.parse(readFileSync(join(here, "fixtures/resume/golden.json"), "utf8"));

const b64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const errOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripIds(resume: any): any {
  const copy = structuredClone(resume);
  for (const sec of copy.sections) {
    delete sec.id;
    for (const item of sec.items) delete item.id;
  }
  return copy;
}

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});
function openMemoryStore(): SqliteCoreStore {
  const s = new SqliteCoreStore(":memory:");
  stores.push(s);
  return s;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const save = async (store: SqliteCoreStore, type: string, data: unknown): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((await callTool("save", { type, data }, store, "你")) as any).record;

const goldenFiles = () => memoryFileStore(Object.fromEntries(Object.entries(G.files as Record<string, string>).map(([k, v]) => [k, b64(v)])));

/** Fake model: hands out the given replies in order (the last one repeats) and records every call. */
function fakeLlm(replies: string[]): LlmClient & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      return replies[Math.min(calls.length - 1, replies.length - 1)];
    },
  };
}

describe("resume contract: templates, markdown, normalize, style", () => {
  it("template CSS matches Python byte-for-byte", () => {
    for (const [name, css] of Object.entries(G.css)) expect(templateCss(name), name).toBe(css);
  });

  it("markdown → structure → markdown", () => {
    for (const c of G.markdown) {
      const parsed = resumeFromMarkdown(c.in);
      expect(stripIds(parsed), c.in).toEqual(c.resume);
      expect(resumeToMarkdown(parsed), c.in).toBe(c.md);
    }
  });

  it("normalize and its errors", () => {
    expect(stripIds(normalizeResume(G.normalize.in))).toEqual(G.normalize.resume);
    expect(resumeToMarkdown(G.normalize.in)).toBe(G.normalize.md);
    for (const c of G.normalize_errors) expect(errOf(() => normalizeResume(c.in)), JSON.stringify(c.in)).toBe(c.error);
  });

  it("style checks and resolution", () => {
    for (const c of [...G.style_errors, ...G.style_ok]) expect(errOf(() => checkStyle(c.in)), JSON.stringify(c.in)).toBe(c.error);
    for (const c of G.resolve_style) expect(resolveStyle(c.style, c.legacy), JSON.stringify(c)).toEqual(c.out);
  });

  it("inline markup: bold, italic, ++underline++ (C++ untouched), links", () => {
    for (const [input, html] of Object.entries(G.inline)) expect(inlineHtml(input), input).toBe(html);
  });
});

describe("resume contract: render / doc_html", () => {
  it("render_html is byte-identical", async () => {
    const files = goldenFiles();
    for (const c of G.render) {
      const figures = await figuresFor(resolveStyle(c.style), c.photo, files);
      expect(renderResumeHtml(normalizeResume(c.resume), c.style, figures, c.title), JSON.stringify(c.style)).toBe(c.html);
    }
  });

  it("doc_html and file names are byte-identical", async () => {
    const store = openMemoryStore();
    await save(store, "profile", { name: "张三/ 李", photo: "photo.jpg" });
    const profile = await store.first("profile");
    const files = goldenFiles();
    for (const c of G.doc_html) {
      expect(await resumeDocHtml(store, c.doc, files), JSON.stringify(c.doc).slice(0, 60)).toBe(c.html);
      expect(resumeFileName(c.doc, profile)).toBe(c.file_name);
    }
    for (const [input, stem] of Object.entries(G.safe_stem)) expect(safeStem(input), input).toBe(stem);
  });
});

describe("resume contract: verify / impact", () => {
  it("fact checks", () => {
    for (const c of G.verify) expect(checkResumeFacts(c.body, c.sources), c.body).toEqual(c.out);
    expect(retainedFacts(G.retained.body, G.retained.memories)).toEqual(G.retained.retained);
    expect(omittedMemories(G.retained.body, G.retained.memories)).toEqual(G.retained.omitted);
  });

  it("impact flags and numbers", () => {
    for (const c of G.impact_flags) {
      expect(impactFlags(c.add, c.said), c.add).toEqual(c.flags);
      expect(impactNumbers(c.add), c.add).toEqual(c.numbers);
    }
  });

  it("impact capture with a fake model: same prompt, same drafts", async () => {
    const store = openMemoryStore();
    await save(store, "profile", { name: "张三/ 李", photo: "photo.jpg" });
    const [m1, m2] = G.impact_capture.memories;
    const s1 = await save(store, "memory", { kind: m1.kind, title: m1.title, body: m1.body, quote: m1.quote });
    const s2 = await save(store, "memory", { kind: m2.kind, title: m2.title, body: m2.body });
    expect([s1.id, s2.id]).toEqual([m1.id, m2.id]);
    const llm = fakeLlm([G.impact_capture.reply]);
    const out = await captureImpact(store, llm, G.impact_capture.answers, "百度 · 产品", "2026-11-04");
    expect(llm.calls[0]).toEqual(G.impact_capture.messages);
    expect(out).toEqual(G.impact_capture.out);
    await expect(captureImpact(store, llm, [{ old: "a", question: "", answer: " " }], "", "x")).rejects.toThrow(G.impact_errors.empty);
    await expect(captureImpact(store, fakeLlm(["no json"]), G.impact_capture.answers, "", "x")).rejects.toThrow(G.impact_errors.bad_reply);
  });
});

describe("resume contract: tailor", () => {
  it("parse_review / apply_edits / pick_asks / clean", () => {
    for (const c of G.parse_review) {
      let out = null;
      let error = null;
      try {
        out = parseReview(c.raw);
      } catch (e) {
        const msg = (e as Error).message;
        // Python reports json.JSONDecodeError text; only "it was a JSON error" is comparable.
        error = c.error === "json" && !msg.includes("审稿") ? "json" : msg;
      }
      expect({ out, error }, c.raw).toEqual({ out: c.out, error: c.error });
    }
    expect(applyEdits(G.apply_edits.body, G.apply_edits.edits)).toEqual(G.apply_edits.out);
    expect(pickAsks(G.pick_asks.asks, G.pick_asks.body)).toEqual(G.pick_asks.out);
    for (const c of G.clean) {
      let out = null;
      let error = null;
      try {
        out = cleanDraft(c.in);
      } catch (e) {
        error = (e as Error).message;
      }
      expect({ out, error }, c.in).toEqual({ out: c.out, error: c.error });
    }
  });

  async function tailorStore(): Promise<{ store: SqliteCoreStore; docId: number; jobId: number }> {
    const store = openMemoryStore();
    const ids: Record<string, number> = {};
    for (const [type, data] of G.tailor_run.setup) {
      const rec = await save(store, type, data);
      ids[type] ??= rec.id;
    }
    await save(store, "doc", {
      kind: "evaluation", job_id: ids.job, title: "评估",
      body: "# 结论\n可以\n\n## 逐条匹配\n- Go → 有\n\n## 简历怎么改\n- 实习放前\n\n## 面试\n- x\n",
    });
    return { store, docId: ids.doc, jobId: ids.job };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comparable = (events: any[]): any[] => events.map((e) => {
    const copy = structuredClone(e);
    delete copy.timings;
    for (const r of copy.rounds ?? []) delete r.seconds;
    if (copy.resume) copy.resume = stripIds(copy.resume);
    return copy;
  });

  it("full run with a fake model: same prompts, events, saved copy", async () => {
    const { store, docId, jobId } = await tailorStore();
    const drafts: LlmMessage[][] = [];
    const llm = fakeLlm(G.tailor_run.review_replies);
    const deps = {
      store,
      llm,
      stream: async function* (messages: LlmMessage[]) {
        drafts.push(messages);
        yield* G.tailor_run.new_chunks as string[];
      },
      measure: async () => 1.0,
      deadlineMs: 5000,
      actor: "Agent",
    };
    const events = [];
    for await (const e of runTailor(deps, docId, jobId)) events.push(e);
    expect(drafts[0]).toEqual(G.tailor_run.draft_messages);
    expect(llm.calls).toEqual(G.tailor_run.review_messages);
    expect(comparable(events)).toEqual(comparable(G.tailor_run.events));
    const done = events.at(-1) as { doc_id: number };
    const target = await store.get("doc", done.doc_id);
    const picked = Object.fromEntries(["kind", "title", "job_id", "body", "style", "pending_asks"].map((k) => [k, target?.[k] ?? null]));
    expect(picked).toEqual(G.tailor_run.target);
    expect((await store.changes(1))[0].actor).toBe(G.tailor_run.change_actor);

    const again = fakeLlm(G.tailor_run.review_replies);
    const events2 = [];
    for await (const e of runTailor({ ...deps, llm: again, stream: null }, docId, jobId, { reviewOnly: true })) events2.push(e);
    expect(again.calls).toEqual(G.tailor_run.review_only_messages);
    expect(comparable(events2)).toEqual(comparable(G.tailor_run.review_only_events));
  });

  it("no JD → error event, nothing written", async () => {
    const store = openMemoryStore();
    const job = await save(store, "job", { company: "美团", title: "后端" });
    const doc = await save(store, "doc", { kind: "resume", title: "主简历", body: "# 张三\n\n## 教育\n" });
    const events = [];
    for await (const e of runTailor({ store, llm: fakeLlm(["{}"]) }, doc.id, job.id)) events.push(e);
    expect(events.at(-1)).toEqual({ type: "error", message: G.tailor_errors.no_jd_message });
    expect((await store.all("doc")).length).toBe(1);
  });
});

describe("resume contract: school logos", () => {
  it("search ranks like Python", () => {
    for (const [q, hits] of Object.entries(G.school_logos)) expect(searchSchoolLogos(q), q).toEqual(hits);
  });

  it("transparent cut-out is pixel-identical", () => {
    for (const [name, c] of Object.entries(G.logos as Record<string, { png: string; width: number; height: number; rgba: string }>)) {
      const png = decodePng(transparentLogo(b64(c.png)));
      expect([png.width, png.height, png.channels], name).toEqual([c.width, c.height, 4]);
      expect(Buffer.from(png.data as Uint8Array).equals(Buffer.from(b64(c.rgba))), name).toBe(true);
    }
    const big = decodePng(transparentLogo(bigWhitePng()));
    expect([big.width, big.height]).toEqual(G.logo_big_size);
    expect(errOf(() => transparentLogo(new TextEncoder().encode("not an image")))).toBe("不是能识别的图片");
  });
});

function bigWhitePng(): Uint8Array {
  return encodePng({ width: 1000, height: 300, data: new Uint8Array(1000 * 300 * 3).fill(255), channels: 3, depth: 8 });
}

// ---------- HTTP layer ----------

function app(overrides: Partial<AppDeps> = {}) {
  const store = openMemoryStore();
  const files = goldenFiles();
  const deps: AppDeps = { store, runtime: "node", storage: "sqlite", files, ...overrides };
  return { app: createApp(deps), store, files };
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("resume HTTP layer", () => {
  it("templates css, render, render errors", async () => {
    const { app: a } = app();
    const css = await a.request("/api/resume/templates/kami.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe(G.css.kami);
    const res = await a.request("/api/resume/render", json({ resume: G.render[0].resume, style: G.render[0].style }));
    expect(await res.text()).toBe(G.render[0].html);
    // underline end to end (Python test_render_underline_end_to_end)
    const resume = { basics: { name: "林同学" }, sections: [{ type: "skills", title: "专业技能", items: [{ text: "熟悉 ++Python++ 和 C++、C++11" }] }] };
    const saved = (await (await a.request("/api/tools/save", json({ type: "doc", data: { kind: "resume", title: "主简历", resume } }))).json()) as { record: { resume: unknown } };
    const page = await (await a.request("/api/resume/render", json({ resume: saved.record.resume, style: {} }))).text();
    expect(page).toContain("熟悉 <u>Python</u> 和 C++、C++11");
    const bad = await a.request("/api/resume/render", json({ resume: {}, style: { template: "nope" } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toBe(G.style_errors[2].error);
    expect((await a.request("/api/resume/render", { method: "POST", body: "{" })).status).toBe(400);
  });

  it("tailor streams SSE events; no model → error event", async () => {
    const { app: a, store } = app({ llm: () => null });
    const job = await save(store, "job", { company: "美团", title: "后端", jd: "Go" });
    const doc = await save(store, "doc", { kind: "resume", title: "主简历", body: "# 张三\n\n## 教育\n" });
    const res = await a.request(`/api/resume/${doc.id}/tailor`, json({ job_id: job.id }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.replace(/^data: /, "")));
    expect(events.at(-1)).toEqual({ type: "error", message: "还没有配置模型服务，请先在设置里添加一个。" });
  });

  it("impact: 400 on bad body, 400 with no answers, 501 with no model, drafts with a model", async () => {
    const { app: a, store } = app();
    expect((await a.request("/api/resume/impact", json({ answers: "x" }))).status).toBe(400);
    expect((await a.request("/api/resume/impact", json({ answers: [], extra: 1 }))).status).toBe(400);
    expect((await a.request("/api/resume/impact", json({ answers: [{ old: "a", answer: " " }] }))).status).toBe(400);
    const none = await a.request("/api/resume/impact", json({ answers: [{ old: "a", answer: "涨了一倍" }] }));
    expect(none.status).toBe(501);
    await save(store, "memory", { kind: "experience", title: "运营", body: "- a" });
    const { app: b } = app({ store, llm: () => fakeLlm(['{"drafts": [{"index": 0, "memory_id": null, "title": "a", "add": "涨了一倍"}]}']) });
    const ok = await b.request("/api/resume/impact", json({ answers: [{ old: "a", question: "q", answer: "涨了一倍" }] }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { drafts: unknown[] }).drafts).toHaveLength(1);
  });

  it("files upload/get, logo cut-out upload, school logos search/serve/use", async () => {
    const logos = new Map([["0528.png", b64(G.logos.white.png)]]);
    const { app: a, files } = app({ schoolLogos: async (file) => logos.get(file) ?? null });
    const form = new FormData();
    form.append("file", new File([b64(G.files["photo.jpg"])], "证件照.JPG"));
    const up = (await (await a.request("/api/files", { method: "POST", body: form })).json()) as { name: string; original: string };
    expect(up.name).toMatch(/^[0-9a-f]{10}\.jpg$/);
    expect(up.original).toBe("证件照.JPG");
    const got = await a.request(`/api/files/${up.name}`);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect((await a.request("/api/files/nope.png")).status).toBe(404);

    const logoForm = new FormData();
    logoForm.append("file", new File([b64(G.logos.white.png)], "x.png"));
    const logo = (await (await a.request("/api/resume/logo", { method: "POST", body: logoForm })).json()) as { name: string };
    expect(logo.name).toMatch(/^logo-[0-9a-f]{12}\.png$/);
    expect(files.files.has(logo.name)).toBe(true);
    const badForm = new FormData();
    badForm.append("file", new File([new TextEncoder().encode("nope")], "x.png"));
    expect((await a.request("/api/resume/logo", { method: "POST", body: badForm })).status).toBe(400);

    const search = (await (await a.request("/api/resume/assets/school-logos?q=" + encodeURIComponent("浙大"))).json()) as { items: unknown[] };
    expect(search.items).toEqual(searchSchoolLogos("浙大"));
    const png = await a.request("/api/resume/assets/school-logos/0528.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await a.request("/api/resume/assets/school-logos/0001.png")).status).toBe(404);
    expect((await a.request("/api/resume/assets/school-logos/..%2Fx.png")).status).toBe(404);
    const used = (await (await a.request("/api/resume/assets/school-logos/0528.png/use", { method: "POST" })).json()) as { name: string };
    expect(used).toEqual({ name: "logo-0528.png" });
    const cut = decodePng(files.files.get("logo-0528.png")!);
    expect(Buffer.from(cut.data as Uint8Array).equals(Buffer.from(b64(G.logos.white.rgba)))).toBe(true);
  });

  it("pdf/png: 501 without a browser, file with one", async () => {
    const { app: a, store } = app();
    await save(store, "profile", { name: "张三" });
    const doc = await save(store, "doc", { kind: "resume", title: "主简历", body: "# 张三\n\n## 教育\n" });
    const res = await a.request(`/api/resume/${doc.id}/pdf`);
    expect(res.status).toBe(501);
    expect((await a.request("/api/resume/999/pdf")).status).toBe(404);
    const printed: string[] = [];
    const renderer: PageRenderer = {
      pdf: async (html) => { printed.push(html); return new TextEncoder().encode("%PDF"); },
      png: async () => new Uint8Array([137, 80]),
      pageCount: async () => 1,
    };
    const { app: b } = app({ store, renderer });
    const pdf = await b.request(`/api/resume/${doc.id}/pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(`attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent("张三-主简历.pdf")}`);
    expect(printed[0]).toBe(await resumeDocHtml(store, (await store.get("doc", doc.id))!, null));
    const png = await b.request(`/api/resume/${doc.id}/png`);
    expect(png.headers.get("content-disposition")).toContain(encodeURIComponent("张三-主简历.png"));
  });
});
