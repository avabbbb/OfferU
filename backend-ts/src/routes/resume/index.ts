import type { Context, Hono } from "hono";
import {
  captureImpact,
  checkStyle,
  CoreError,
  figuresFor,
  nowIso,
  normalizeResume,
  renderResumeHtml,
  resolveStyle,
  resumeFromMarkdown,
  runTailor,
  searchSchoolLogos,
  templateCss,
  todayIso,
  type FileStore,
  type Json,
  type TailorEvent,
} from "@offeru/core";

import { jsonBody, type AppEnv } from "../../app";
import { transparentLogo } from "./image";

/**
 * Resume routes that run anywhere (Node companion and Worker): everything they need comes from deps.
 *   GET  /api/resume/templates/{template}.css
 *   POST /api/resume/render
 *   POST /api/resume/{doc_id}/tailor      (SSE)
 *   POST /api/resume/impact
 *   GET  /api/resume/assets/school-logos?q=
 *   POST /api/resume/logo                 (needs deps.files)
 *   POST /api/files, GET /api/files/{name} (needs deps.files)
 * PDF/PNG and the bundled school-logo PNGs need the disk/Chromium: routes/companion/resume.ts.
 */

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const truthy = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value);

export function needFiles(c: Context<AppEnv>): FileStore {
  const files = c.get("deps").files;
  if (!files) throw new CoreError("这个运行环境不保存文件：请连本机 OfferU", "unsupported");
  return files;
}

/** Path(name).name */
export const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? "";

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, chars);
}

const suffix = (name: string): string => {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot).toLowerCase() : "";
};

async function uploadedFile(c: Context<AppEnv>): Promise<File> {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new CoreError("要用 multipart/form-data 传 file");
  return file;
}

const sse = (event: TailorEvent): string => `data: ${JSON.stringify(event)}\n\n`;

function impactBody(raw: unknown): { answers: Array<{ old: string; question: string; answer: string }>; job_id: number | null } {
  if (!isObject(raw)) throw new CoreError("请求体要是对象：{answers, job_id?}");
  const extra = Object.keys(raw).filter((k) => k !== "answers" && k !== "job_id");
  if (extra.length) throw new CoreError(`不认识的字段：${extra.join(", ")}`);
  if (!Array.isArray(raw.answers)) throw new CoreError("answers 要是数组：[{old, question, answer}]");
  const answers = raw.answers.map((item, i) => {
    if (!isObject(item)) throw new CoreError(`answers[${i}] 要是对象`);
    const unknown = Object.keys(item).filter((k) => !["old", "question", "answer"].includes(k));
    if (unknown.length) throw new CoreError(`answers[${i}] 不认识的字段：${unknown.join(", ")}`);
    for (const key of ["old", "question", "answer"]) {
      if (item[key] !== undefined && typeof item[key] !== "string") throw new CoreError(`answers[${i}].${key} 要是文字`);
    }
    if (typeof item.old !== "string") throw new CoreError(`answers[${i}].old 必填`);
    return { old: item.old, question: (item.question as string | undefined) ?? "", answer: (item.answer as string | undefined) ?? "" };
  });
  const jobId = raw.job_id;
  if (jobId !== undefined && jobId !== null && !(typeof jobId === "number" && Number.isInteger(jobId))) throw new CoreError("job_id 要是整数");
  return { answers, job_id: (jobId as number | null | undefined) ?? null };
}

export function registerResume(app: Hono<AppEnv>): void {
  // The live editor styles the page with the same CSS the PDF is printed with. Unknown names fall back to classic.
  app.get("/api/resume/templates/:file{.+\\.css}", (c) => {
    const template = c.req.param("file").slice(0, -4);
    return c.body(templateCss(template), 200, { "Content-Type": "text/css; charset=utf-8" });
  });

  // Live preview: the exact HTML the PDF is printed from. Body: {resume, style}; old clients send {body, style}.
  app.post("/api/resume/render", async (c) => {
    const payload = await jsonBody(c);
    if (!isObject(payload)) throw new CoreError("请求体要是对象：{resume, style}");
    const style = truthy(payload.style) ? payload.style : {};
    checkStyle(style);
    const { store, files } = c.get("deps");
    const profile = await store.first("profile");
    const resume = payload.resume !== undefined && payload.resume !== null
      ? normalizeResume(payload.resume)
      : resumeFromMarkdown(truthy(payload.body) ? String(payload.body) : "");
    const figures = await figuresFor(resolveStyle(style), profile?.photo, files);
    return c.html(renderResumeHtml(resume, style, figures));
  });

  // 按岗位 JD 改写简历，SSE 推进度（start / delta / review / done / error）。断开连接就是取消；没跑完不写库。Body: {job_id?, review_only?}.
  app.post("/api/resume/:doc_id{[0-9]+}/tailor", async (c) => {
    const payload = await jsonBody(c);
    const body = isObject(payload) ? payload : {};
    const deps = c.get("deps");
    const abort = new AbortController();
    c.req.raw.signal?.addEventListener("abort", () => abort.abort());
    const events = runTailor({
      store: deps.store,
      llm: deps.llm,
      files: deps.files,
      measure: deps.renderer ? (html) => deps.renderer!.pageCount(html) : null,
      actor: "Agent",
      signal: abort.signal,
      context: () => ({ actor: "Agent", now: nowIso(), today: todayIso() }),
    }, Number(c.req.param("doc_id")), truthy(body.job_id) ? Number(body.job_id) : null, { reviewOnly: truthy(body.review_only) });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(sse(next.value)));
        } catch (cause) {
          console.error(cause);
          controller.enqueue(encoder.encode(sse({ type: "error", message: "改写出错了，简历没动" })));
          controller.close();
        }
      },
      async cancel() {
        abort.abort();
        await events.return(undefined);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });
  });

  // 追问成果：用户回答 → 记忆草稿，只出草稿不写库。Body: {answers: [{old, question, answer}], job_id?}.
  app.post("/api/resume/impact", async (c) => {
    const body = impactBody(await jsonBody(c));
    const { store, llm } = c.get("deps");
    const job = body.job_id ? await store.get("job", body.job_id) : null;
    const title = job ? [job.company, job.title].filter(truthy).map(String).join(" · ") : "";
    if (!llm) {
      // Python asks the model only after it has answers; keep "no answers" ahead of "no model".
      if (!body.answers.slice(0, 3).some((a) => a.answer.trim())) throw new CoreError("没有要整理的回答，档案没动");
      throw new CoreError("还没有配置模型服务，请先在设置里添加一个。", "unsupported");
    }
    return c.json(await captureImpact(store, llm, body.answers, title, todayIso()));
  });

  // 校徽库搜索（随应用内置约 800 所学校）：返回候选，前端让用户挑一个。
  app.get("/api/resume/assets/school-logos", (c) => c.json({ items: searchSchoolLogos(c.req.query("q") ?? "") }));

  // 自己上传的校徽：抠成透明底的 PNG 存进 files/，返回文件名。
  app.post("/api/resume/logo", async (c) => {
    const files = needFiles(c);
    const file = await uploadedFile(c);
    if (file.size > 10_000_000) return c.json({ detail: "校徽图片不能超过 10MB", code: "invalid" }, 413);
    const png = transparentLogo(new Uint8Array(await file.arrayBuffer()));
    const name = `logo-${randomHex(12)}.png`;
    await files.write(name, png);
    return c.json({ name });
  });

  // Old resumes and ID photos land in <data>/files; tools refer to them by name.
  app.post("/api/files", async (c) => {
    const files = needFiles(c);
    const file = await uploadedFile(c);
    const name = `${randomHex(10)}${suffix(file.name || "")}`;
    await files.write(name, new Uint8Array(await file.arrayBuffer()));
    return c.json({ name, original: file.name });
  });

  app.get("/api/files/:name", async (c) => {
    const files = needFiles(c);
    const found = await files.read(baseName(c.req.param("name")));
    if (!found) throw new CoreError("文件不存在", "not_found");
    return c.body(found.bytes as Uint8Array<ArrayBuffer>, 200, { "Content-Type": found.type || "application/octet-stream" });
  });

}
