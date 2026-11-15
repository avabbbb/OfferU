// Agent composer attachments: core/attachments vs Python agent_attachments.py golden
// (fixtures/attachments/gen_attachments.py), then the HTTP surface on the companion and on a stateless Worker.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemoryAgentRunStore,
  classifyAttachment,
  displayName,
  memoryFileStore,
  pptxText,
  prepareAttachmentMessage,
  saveAttachment,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
} from "@offeru/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { popplerPdfText } from "../src/routes/companion/attachments";
import { SqliteCoreStore } from "../src/store";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures/attachments/attachments.json"), "utf8"));
const deck = new Uint8Array(readFileSync(join(here, "fixtures/attachments/deck.pptx")));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]);
const enc = new TextEncoder();

describe("attachments match Python agent_attachments.py", () => {
  it("reads PPTX like python-pptx _pptx_text", async () => {
    expect(await pptxText(deck)).toBe(golden.pptx_text);
  });

  it("rejects uploads with the same messages", async () => {
    const bytes: Record<string, [string, Uint8Array]> = {
      bad_ext: ["a.txt", enc.encode("hi")],
      empty: ["a.png", new Uint8Array()],
      mismatch: ["a.png", enc.encode("GIF89a.....")],
      not_pptx: ["a.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(30).fill(0)])],
      big_image: ["a.png", new Uint8Array(PNG.length + 8 * 1024 * 1024).fill(0).map((b, i) => (i < PNG.length ? PNG[i] : 0))],
    };
    for (const [key, [name, data]] of Object.entries(bytes)) {
      const error = await saveAttachment({ files: memoryFileStore() }, name, data).then(() => null, (e: Error) => e.message);
      expect(error, key).toBe(golden.errors[key]);
    }
    for (const [raw, want] of Object.entries(golden.display_name)) expect(displayName(raw)).toBe(want);
  });

  it("prepares the model message like prepare_message (inline docs, 30k/60k clipping, images)", async () => {
    const deps = { files: memoryFileStore() };
    const d = await saveAttachment(deps, "deck.pptx", deck);
    const p = await saveAttachment(deps, "shot.png", PNG);
    const l = await saveAttachment(deps, "long.pptx", deck);
    await deps.files.write(`${l.id}.txt`, enc.encode("长".repeat(35000)));
    const prepared = await prepareAttachmentMessage(deps, "  看看这个  ", [d.id, p.id, l.id, d.id]);
    expect(prepared.modelMessage).toBe(golden.prepare.model_message);
    expect(prepared.historyMessage).toBe(golden.prepare.history_message);
    const alias: Record<string, string> = { [d.id]: "deck", [p.id]: "png", [l.id]: "long" };
    expect(prepared.attachments.map((a) => ({ ...a, id: alias[a.id] }))).toEqual(golden.prepare.attachments);
    expect(prepared.images).toHaveLength(golden.prepare.images);
    expect(prepared.images[0]).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it("classifies PDFs by %PDF- after leading whitespace", () => {
    expect(classifyAttachment("x.pdf", enc.encode("\n %PDF-1.4")).kind).toBe("document");
  });
});

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function upload(name: string, bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as ArrayBuffer]), name);
  return form;
}

describe("/api/agent/runtime/attachments", () => {
  it("uploads, previews images only, and inlines documents into the next run", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const seen: ChatRequest[] = [];
    const llm: LlmClient = {
      provider: "fake", model: "vision",
      async chat() { return null; },
      async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
        seen.push(request);
        yield { type: "done", result: { provider: "fake", model: "vision", content: "看过了", reasoning: "", toolCalls: [], finishReason: "stop", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false } } };
      },
    };
    const app = createApp({ store, runtime: "node", storage: "sqlite", agentRuns: new MemoryAgentRunStore(), attachmentFiles: memoryFileStore(), llm: () => llm });
    const doc = await (await app.request("/api/agent/runtime/attachments", { method: "POST", body: upload("deck.pptx", deck) })).json() as any;
    expect(doc).toMatchObject({ name: "deck.pptx", kind: "document", size: deck.length });
    const img = await (await app.request("/api/agent/runtime/attachments", { method: "POST", body: upload("shot.png", PNG) })).json() as any;
    const preview = await app.request(`/api/agent/runtime/attachments/${img.id}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect((await app.request(`/api/agent/runtime/attachments/${doc.id}`)).status).toBe(404);
    expect((await app.request("/api/agent/runtime/attachments/nope")).status).toBe(404);
    const bad = await app.request("/api/agent/runtime/attachments", { method: "POST", body: upload("a.txt", enc.encode("x")) });
    expect(bad.status).toBe(400);

    const run = await app.request("/api/agent/runtime/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "看看", attachments: [doc.id, img.id] }) });
    expect(run.status).toBe(200);
    const user = seen[0].messages.find((m) => m.role === "user")!;
    const text = typeof user.content === "string" ? user.content : (user.content ?? []).map((part: any) => part.text ?? "").join("");
    expect(text).toContain("以下是用户随消息附上的文件内容");
    expect(text).toContain("指标 | 结果");
    expect(JSON.stringify(user.content)).toContain("data:image/png;base64,");
  });

  it("is 501 on the stateless Worker, and PDFs are 501 without a PDF reader", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const worker = createApp({ store, runtime: "worker", storage: "none" });
    expect((await worker.request("/api/agent/runtime/attachments", { method: "POST", body: upload("shot.png", PNG) })).status).toBe(501);
    const web = createApp({ store, runtime: "worker", storage: "none", attachmentFiles: memoryFileStore() });
    expect((await web.request("/api/agent/runtime/attachments", { method: "POST", body: upload("cv.pdf", enc.encode("%PDF-1.4\n")) })).status).toBe(501);
    expect((await web.request("/api/agent/runtime/attachments", { method: "POST", body: upload("deck.pptx", deck) })).status).toBe(200);
  });

  const hasPoppler = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!hasPoppler)("reads PDFs on the companion through poppler", async () => {
    // A one-page PDF with "Hello OfferU" (built by hand: catalog, page, Helvetica, content stream).
    const content = "BT /F1 12 Tf 72 720 Td (Hello OfferU) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const deps = { files: memoryFileStore(), pdfText: popplerPdfText() };
    const saved = await saveAttachment(deps, "cv.pdf", enc.encode(pdf));
    const prepared = await prepareAttachmentMessage(deps, "看", [saved.id]);
    expect(prepared.modelMessage).toContain("Hello OfferU");
  });
});
