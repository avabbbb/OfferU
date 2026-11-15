import { demoTool } from "./tools";

export type AgentConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  remember?: boolean;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; summary: string }
  | { type: "tool_end"; name: string; ok: boolean; summary: string }
  | { type: "done"; text: string };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type Completion = { text: string; toolCalls: ToolCall[] };

const SYSTEM_PROMPT = `你是 OfferU 的网页演示 Agent。你只能操作当前浏览器里的虚构 demo 数据。
规则：
- 用提供的工具读写数据；不要编造工具结果，失败时直接说失败原因。
- 修改前先用 list/get 确认记录；一次只做必要的 1-3 个调用。
- 岗位状态只能前进：saved < applied < test < interview < offer；rejected / closed 是冻结状态，不要自己回退。要回退请让用户在页面上点。
- 不要声称能发邮件、导出 PDF、读取本机文件、连接外置 Agent 或访问互联网；这些在静态演示里不可用。
- 回答用中文，简短，说明你改了哪条记录、下一步是什么。
- 你可以用 undo 撤销自己刚做的改动；不要建议用户删除数据。`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "overview",
      description: "看今天：阶段、下一步、待办分桶、岗位数量、最近改动。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list",
      description: "列记录。看岗位、待办、文档、记忆。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
          status: { type: "string", enum: ["saved", "applied", "test", "interview", "offer", "rejected", "closed"] },
          kind: { type: "string" },
          job_id: { type: "number" },
          done: { type: "boolean" },
          tag: { type: "string" },
          full: { type: "boolean" },
          limit: { type: "number", minimum: 1, maximum: 500 },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get",
      description: "按 id 取一条记录；岗位会附带事项和文档。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
          id: { type: "number" },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save",
      description: "新建或更新记录。更新时只传要改的字段，传 null 删除字段。返回 record、change_id。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] },
          id: { type: "number" },
          data: { type: "object", additionalProperties: true },
        },
        required: ["type", "data"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "跨记录搜索关键词，空格分开。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          types: { type: "array", items: { type: "string", enum: ["profile", "memory", "job", "event", "doc"] } },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo",
      description: "撤销一条改动。只能撤销最新且之后没有被改过的记录。",
      parameters: {
        type: "object",
        properties: { change_id: { type: "number" } },
        required: ["change_id"],
        additionalProperties: false,
      },
    },
  },
] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> // JSON/provider boundary; callers validate each field
    : null;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "list") return `列 ${String(args.type ?? "记录")}`;
  if (name === "get") return `读 ${String(args.type ?? "记录")} #${String(args.id ?? "")}`;
  if (name === "save") return `写 ${String(args.type ?? "记录")}`;
  if (name === "search") return `搜「${String(args.query ?? "")}」`;
  if (name === "undo") return `撤销 #${String(args.change_id ?? "")}`;
  return "看今天";
}

function resultSummary(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return "完成";
  const object = result as Record<string, unknown>;
  if (name === "overview") {
    const next = object.next_step as Record<string, unknown> | undefined;
    return typeof next?.title === "string" ? next.title : "已读取今天";
  }
  if (name === "list") return `${String(object.total ?? 0)} 条`;
  if (name === "search") return `${Array.isArray(object.items) ? object.items.length : 0} 条命中`;
  if (name === "save") {
    const record = object.record as Record<string, unknown> | undefined;
    const label = record && typeof record.label === "string"
      ? record.label
      : record && typeof record.company === "string"
        ? [record.company, typeof record.title === "string" ? record.title : ""].filter(Boolean).join(" · ")
        : "";
    return object.change_id ? `已保存${label ? `「${label}」` : ""}` : "没有变化";
  }
  if (name === "undo") return "已撤销";
  return "完成";
}

async function readSseCompletion(
  response: Response,
  onText: (text: string) => void,
): Promise<Completion> {
  if (!response.body) throw new Error("模型没有返回响应体。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  const handleBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const payload = recordOf(parsed);
    if (!payload) return;
    const choice = recordOf(listOf(payload.choices)[0]);
    const delta = recordOf(choice?.delta);
    const content = delta?.content;
    if (typeof content === "string" && content) {
      text += content;
      onText(content);
    }
    for (const rawValue of listOf(delta?.tool_calls)) {
      const raw = recordOf(rawValue);
      if (!raw) continue;
      const fn = recordOf(raw.function);
      const index = typeof raw.index === "number" ? raw.index : calls.size;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof raw.id === "string" && raw.id) current.id = raw.id;
      if (typeof fn?.name === "string") current.name += fn.name;
      if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
      calls.set(index, current);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n");
    for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
      handleBlock(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
    if (done) break;
  }
  if (buffer.trim()) handleBlock(buffer);

  return {
    text,
    toolCalls: [...calls.values()]
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      })),
  };
}

async function completion(
  config: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<Completion> {
  let response: Response;
  try {
    response = await fetch(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
        stream: true,
      }),
      signal,
      redirect: "error",
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new Error("浏览器直连模型失败。请检查 Base URL、网络，以及 provider 是否允许 CORS；演示站不经过 OfferU 服务器。");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`模型请求失败（HTTP ${response.status}）${body ? `：${body.slice(0, 240)}` : ""}`);
  }
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const payload = recordOf(await response.json().catch(() => null));
    const message = recordOf(recordOf(listOf(payload?.choices)[0])?.message);
    const text = typeof message?.content === "string" ? message.content : "";
    if (text) onText(text);
    const toolCalls: ToolCall[] = [];
    for (const [index, value] of listOf(message?.tool_calls).entries()) {
      const call = recordOf(value);
      const fn = recordOf(call?.function);
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      toolCalls.push({
        id: typeof call?.id === "string" && call.id ? call.id : `call_${Date.now()}_${index}`,
        type: "function",
        function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" },
      });
    }
    return { text, toolCalls };
  }
  return readSseCompletion(response, onText);
}

/**
 * A tiny OpenAI-compatible function-calling loop. It runs entirely in the
 * browser and only reaches the provider endpoint the user configured.
 */
export async function runDemoAgent(options: {
  config: AgentConfig;
  history: ChatTurn[];
  input: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<string> {
  const { config, history, input, signal, onEvent } = options;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-24).map((turn) => ({ role: turn.role, content: turn.content }) as ChatMessage),
    { role: "user", content: input },
  ];
  let answer = "";

  for (let step = 0; step < 6; step += 1) {
    const result = await completion(config, messages, signal, (text) => {
      answer += text;
      onEvent({ type: "text", text });
    });
    if (!result.toolCalls.length) {
      if (!answer.trim()) throw new Error("模型没有返回文字，也没有调用工具。");
      return answer;
    }
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        // The model gets the parse error back as a tool result and can retry.
      }
      const summary = toolSummary(call.function.name, args);
      onEvent({ type: "tool_start", name: call.function.name, summary });
      let content: string;
      let ok = true;
      try {
        const resultValue = await demoTool(call.function.name, args, "Agent");
        content = JSON.stringify(resultValue).slice(0, 8000);
        onEvent({ type: "tool_end", name: call.function.name, ok: true, summary: resultSummary(call.function.name, resultValue) });
      } catch (cause) {
        ok = false;
        const message = cause instanceof Error ? cause.message : "工具调用失败";
        content = JSON.stringify({ error: message });
        onEvent({ type: "tool_end", name: call.function.name, ok: false, summary: message });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
      if (!ok && !answer) answer = "";
    }
  }
  throw new Error("Agent 超过 6 步，已停下。请把问题拆小一点。");
}
