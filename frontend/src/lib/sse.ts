/** 读 text/event-stream：每个事件的 data 行拼起来按 JSON 交给 onEvent。只认 data，够 /api/resume/{id}/tailor 用。 */
export async function readSse<T>(res: Response, onEvent: (event: T) => void): Promise<void> {
  if (!res.body) throw new Error("没有响应内容");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (chunk: string) => {
    const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) onEvent(JSON.parse(data) as T);
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
      emit(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
    if (done) break;
  }
  emit(buffer);
}
