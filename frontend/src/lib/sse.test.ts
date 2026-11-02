import { expect, it } from "vitest";

import { readSse } from "./sse";

const response = (...chunks: Uint8Array[]) =>
  new Response(new ReadableStream({ start(c) { chunks.forEach((chunk) => c.enqueue(chunk)); c.close(); } }));

it("events split across chunks and inside a UTF-8 character", async () => {
  const bytes = new TextEncoder().encode('data: {"type":"start","job":"美团 · 后端"}\n\ndata: {"type":"delta","text":"# 张三"}\n\ndata: {"type":"done"}');
  const cut = bytes.indexOf(0xe5, 30) + 1; // 切在「张」或之前某个多字节字符中间
  const got: unknown[] = [];
  await readSse(response(bytes.slice(0, cut), bytes.slice(cut)), (event) => got.push(event));
  expect(got).toEqual([{ type: "start", job: "美团 · 后端" }, { type: "delta", text: "# 张三" }, { type: "done" }]);
});
