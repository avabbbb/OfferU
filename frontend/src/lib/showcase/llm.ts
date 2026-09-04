// =============================================
// Showcase LLM 层 — 纯前端 Agent 的模型直连
// =============================================
// VITE_SHOWCASE 构建下，Agent 对话不依赖 Python 后端：
// 1) 访客在 localStorage 配置了 LLM key → 浏览器直连 OpenAI 兼容端点
//    （DeepSeek / SiliconFlow 已确认允许浏览器 CORS 直连）
// 2) 未配置 → 返回内置演示回答（本地模板，无需任何外部服务）

import { safeClientErrorMessage } from "../safe-error";

const KEY = "offeru_showcase_llm_key";
const BASE = "offeru_showcase_llm_base";
const MODEL = "offeru_showcase_llm_model";

export function hasShowcaseLlmConfig(): boolean {
  try {
    return Boolean(localStorage.getItem(KEY));
  } catch {
    return false;
  }
}

export function showcaseLlmConfig(): {
  key: string;
  base: string;
  model: string;
} {
  return {
    key: (typeof localStorage !== "undefined" && localStorage.getItem(KEY)) || "",
    base:
      (typeof localStorage !== "undefined" && localStorage.getItem(BASE)) ||
      "https://api.deepseek.com/v1",
    model:
      (typeof localStorage !== "undefined" && localStorage.getItem(MODEL)) ||
      "deepseek-chat",
  };
}

// 演示回答模板：按对话主题给出结构化求职建议，模拟 Agent 的产出节奏。
function demoReplies(topic: string, message: string): string {
  const t = topic.toLowerCase();
  const has = (...words: string[]) => words.some((w) => message.toLowerCase().includes(w));

  if (t.includes("education")) {
    return (
      "好的，我来帮你把教育经历组织成简历表达。\n\n" +
      "基于你说的内容，我建议这样展开：\n" +
      "1. **主线**：先写学校、专业、时间，再补一个与目标岗位相关的亮点（课程/论文/项目）。\n" +
      "2. **量化优先**：GPA、排名、奖学金这类硬指标放最前，有数字就用数字。\n" +
      "3. **岗位关联**：把和目标岗位最相关的一门课或研究拎出来单独说。\n\n" +
      "示例：\n" +
      "「华南理工大学 · 软件工程（2019-2023）\n" +
      "GPA 3.7/4.0（前 10%），校 ACM 集训队成员；毕业设计《低代码页面搭建引擎》获院级优秀论文，被 2 个校内系统采用。」\n\n" +
      (has("没有", "没什么", "没得")
        ? "如果暂时没有亮眼数字也没关系——可以把课程大作业、实验项目里你独立负责的部分挑出来写。\n"
        : "") +
      "你可以把这条建议直接「加入档案」，或继续补充更多细节，我再帮你调整。"
    );
  }
  if (t.includes("internship") || t.includes("work")) {
    return (
      "这段经历按 STAR 结构来写效果最好：\n\n" +
      "1. **背景（Situation）**：公司/团队在做什么、你所在的位置。\n" +
      "2. **任务（Task）**：你负责的目标，一句话说清。\n" +
      "3. **动作（Action）**：你具体做了什么——这是简历的主体，写 2-4 条。\n" +
      "4. **结果（Result）**：可量化的结果优先（人数、时长、百分比、覆盖范围）。\n\n" +
      "示例：\n" +
      "「云帆数据 · 前端工程师（2023.07 - 至今）\n" +
      "· 主导数据平台前端架构升级，组件库覆盖 12 个业务模块；\n" +
      "· 通过路由级代码分割与缓存策略，页面首屏耗时下降 40%。」\n\n" +
      "注意：没有数字时不要编造，保留「负责/参与」的真实边界即可。继续补充细节，我可以帮你逐条打磨。"
    );
  }
  if (t.includes("project")) {
    return (
      "项目经历是简历里最灵活的加分项，建议这样组织：\n\n" +
      "1. **一句话定位**：项目名 + 你的角色 + 服务对象。\n" +
      "2. **技术栈一句话**：选 3-5 个关键技能，和岗位 JD 对齐。\n" +
      "3. **难点与解法**：挑一个最有说服力的技术难点展开（1-2 句）。\n" +
      "4. **可验证结果**：上线情况、用户数、性能指标。\n\n" +
      "示例：\n" +
      "「低代码搭建平台 · 核心开发者（2024.03 - 2024.10）\n" +
      "基于 React + Vite 自研页面渲染引擎，支持 30+ 组件的拖拽配置；服务 20+ 业务线，搭建效率提升约 5 倍。」\n\n" +
      "如果项目还没上线，可以写「已进入 XX 阶段」或附上仓库链接。"
    );
  }
  if (t.includes("skill")) {
    return (
      "技能清单建议按「岗位匹配度」排序，而不是罗列全部：\n\n" +
      "1. **核心技能置顶**：目标岗位 JD 里出现的关键词优先。\n" +
      "2. **分组清晰**：语言/框架/工具分三组，每组 3-6 项。\n" +
      "3. **能力分级**：可以用「熟练/掌握/了解」，但别全部写熟练。\n" +
      "4. **AI 工具加分**：有实际使用经验的 AI 工具（如 Copilot、Cursor、Agent 框架）可以单独列出。\n\n" +
      "示例：\n" +
      "「前端：React、TypeScript、Vite、Tailwind\n" +
      "工程化：Webpack、CI/CD、性能优化\n" +
      "AI：RAG 应用开发、LangChain、Prompt 工程」\n\n" +
      "告诉我目标岗位方向，我可以帮你把技能列表重新排序。"
    );
  }
  return (
    "收到！我理解你的求职场景了。\n\n" +
    "我可以帮你：\n" +
    "1. **组织经历表达**：把零散经历改写成简历语言（STAR 结构 + 量化）。\n" +
    "2. **对齐岗位**：根据目标 JD 调整描述重点与关键词。\n" +
    "3. **查漏补缺**：指出档案里缺少的、面试官会追问的信息。\n\n" +
    "请告诉我：你目前想完善的是教育、实习/工作、项目还是技能？或者直接发一段原始描述，我帮你改写。"
  );
}

export async function showcaseChatText(
  topic: string,
  message: string,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {  const config = showcaseLlmConfig();

  if (!config.key) {
    // 无 key：演示回答，按块输出模拟流式
    const reply = demoReplies(topic, message);
    const chunks = reply.match(/.{1,12}(\s|$)/g) || [reply];
    for (const chunk of chunks) {
      if (signal?.aborted) break;
      onText(chunk);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 8);
      await promise;
    }
    return reply;
  }

  // 直连 OpenAI 兼容端点（DeepSeek / SiliconFlow 已确认 CORS 可用）
  const response = await fetch(`${config.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "你是 OfferU 求职助手，帮助使用者完善职业档案。回答使用中文，结构清晰，给出可直接采用的表述。",
        },
        { role: "user", content: `主题：${topic}\n${message}` },
      ],
    }),
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`LLM 请求失败: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          onText(delta);
        }
      } catch {
        // 忽略无法解析的 SSE 块
      }
    }
  }
  return full;
}

// 把 showcaseChatText 包装成 SSE Response，供直连 fetch 的页面
// （ChatPanel 等）无改动复用：事件协议对齐后端 /api/profile/chat。
export function showcaseChatResponse(topic: string, message: string): Response {
  const encoder = new TextEncoder();
  let full = "";
  let pending = "";
  let settled = false;

  const emit = (event: string, payload: unknown) => {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const flushPending = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!pending) return;
    controller.enqueue(emit("ai_message", { content: pending }));
    pending = "";
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(emit("ai_message", { session_id: 1 }));

      showcaseChatText(topic, message, (delta) => {
        if (settled) return;
        full += delta;
        pending += delta;
        const boundary = /[。！？!?\n]/.exec(pending);
        if (boundary || pending.length >= 40) {
          flushPending(controller);
        }
      })
        .then(() => {
          settled = true;
          flushPending(controller);
          if (full.trim()) {
            controller.enqueue(emit("ai_message", { content: "", done: true }));
          }
          controller.close();
        })
        .catch((error: unknown) => {
          settled = true;
          controller.enqueue(
            emit("error", {
              message: safeClientErrorMessage(error, "模型请求失败，请稍后重试"),
            }),
          );
          controller.close();
        });
    },
    cancel() {
      settled = true;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
