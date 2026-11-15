// Scripted model for the journey harness (mode "mock"): no key, no network, CI-safe.
//
// The Agent loop's model turns (requests that carry tools) replay a per-turn
// script of tool calls and replies, keyed by the turn label from scenarios.ts.
// Steps may be functions of what the run's tools returned so far (read from the
// tool messages in the request), so e.g. the interrupted-pack retry only saves
// what the first, aborted run did not. Sub-model calls made inside tools
// (tailor_resume draft + review) get canned answers built from the facts in the
// prompt, so the tools run their real code paths end to end.
//
// This exercises the runtime, the tools, persistence, abort / retry and the
// grader — not the model's judgment. Model quality needs mode "real".

import {
  type ChatMessage,
  type ChatRequest,
  type LlmChatOptions,
  type LlmClient,
  type LlmMessage,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { ANSWER_1, GAP_ANSWER, NEW_EVIDENCE, type Turn } from "./scenarios";
import type { SeedIds } from "./seed";

type Call = { name: string; args: Record<string, unknown> };
export type MockStep = { text?: string; calls?: Call[] };
type StepFn = (ctx: StepContext) => MockStep;
type Script = Array<MockStep | StepFn>;

export interface StepContext {
  ids: SeedIds;
  today: string;
  /** Parsed results of every tool this run has called so far, oldest first. */
  results: Array<{ name: string; args: Record<string, unknown>; result: unknown; error: boolean }>;
  last(name: string): any;
}

function toolResults(messages: ChatMessage[]): StepContext["results"] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const out: StepContext["results"] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
        calls.set(call.id, { name: call.function.name, args });
      }
    } else if (message.role === "tool") {
      const call = calls.get(String(message.tool_call_id)) ?? { name: String(message.name || ""), args: {} };
      const text = typeof message.content === "string" ? message.content : "";
      let result: unknown = text;
      try { result = JSON.parse(text); } catch { /* error text */ }
      out.push({ ...call, result, error: text.startsWith("ERROR:") });
    }
  }
  return out;
}

const docsOf = (ctx: StepContext): Array<Record<string, any>> => {
  const listed = ctx.last("list");
  return Array.isArray(listed?.items) ? listed.items : Array.isArray(listed) ? listed : [];
};

// ---------------- canned sub-model answers (inside tools) ----------------

/** The tailored resume a grounded model would write from the facts in the tailor prompt. */
export function tailoredDraft(facts: string): string {
  const internship = [
    facts.includes("GMV") ? "- 每周用 SQL 从订单表和流量表取数，产出 GMV 周报，支持运营同学的数据需求" : "- 参与日常数据报表制作，支持运营同学的数据需求",
    facts.includes("2.1 个百分点")
      ? "- 分析优惠券 A/B 测试：满减券组下单转化率比折扣券组高 2.1 个百分点（两组样本各约 8000 人），建议运营保留满减券"
      : facts.includes("A/B") ? "- 分析优惠券 A/B 测试，对比满减券与折扣券两组的下单转化率，建议运营保留满减券" : "",
  ].filter(Boolean);
  const project = facts.includes("留存曲线") ? "- 3 人小组课程项目，负责用 Python 画留存曲线、找流失节点" : "- 做了用户留存分析";
  return ["# 林知远", "", "13800000000 | linzhiyuan.test@example.com | 上海", "",
    "## 教育经历", "### 示例大学 | 统计学 本科 | 2022.09 – 2026.06", "- 主修课程：数理统计、回归分析、数据库原理", "",
    "## 实习经历", "### 示例电商 | 数据分析实习生 | 2025.07 – 2025.09", ...internship, "",
    "## 项目经历", "### 校园二手平台用户留存分析 | 课程项目 | 2025.03 – 2025.06", project, "",
    "## 技能", "- SQL、Python（pandas）、Excel", ""].join("\n");
}

const EMPTY_REVIEW = JSON.stringify({ edits: [], notes: { 关键词: "BI 工具（JD 加分项）档案里没有，没写", 岗位角度: "无", 动作和结果: "无", 语气: "无" }, asks: [] });

// ---------------- per-turn scripts (keyed by scenarios.ts labels) ----------------

const packSteps = (job: "j1"): Script => [
  (ctx) => ({ calls: [{ name: "list", args: { type: "doc", job_id: ctx.ids.jobs[job].id } }] }),
  (ctx) => (docsOf(ctx).some((doc) => doc.kind === "resume") ? {} : { calls: [{ name: "tailor_resume", args: { id: ctx.ids.main_resume, job_id: ctx.ids.jobs[job].id } }] }),
  (ctx) => (docsOf(ctx).some((doc) => doc.kind === "apply_chat" && String(doc.title).includes("BOSS")) ? {} : {
    calls: [{ name: "save", args: { type: "doc", data: {
      kind: "apply_chat", job_id: ctx.ids.jobs[job].id, title: "BOSS 直聘打招呼语 · 示例科技",
      body: "您好，我是示例大学统计学 2026 届本科生林知远。实习时每周用 SQL 出 GMV 周报，做过优惠券 A/B 测试分析，想应聘数据分析师（2026 届校招），方便的话我把简历发您看看？",
    } } }],
  }),
  (ctx) => (docsOf(ctx).some((doc) => doc.kind === "apply_chat" && String(doc.title).includes("小红书")) ? {} : {
    calls: [{ name: "save", args: { type: "doc", data: {
      kind: "apply_chat", job_id: ctx.ids.jobs[job].id, title: "小红书私信 · 示例科技",
      body: "你好！在小红书看到你分享的示例科技数据分析师（2026 届校招）内推信息。我是示例大学统计学 2026 届本科生，实习时做 GMV 周报和优惠券 A/B 测试分析，很想投这个岗位。请问简历直接发 hr-test@example.com 就可以吗？谢谢～",
    } } }],
  }),
  (ctx) => {
    if (docsOf(ctx).some((doc) => doc.kind === "email")) return {};
    const tailored = ctx.last("tailor_resume")?.doc_id ?? docsOf(ctx).find((doc) => doc.kind === "resume")?.id;
    return { calls: [{ name: "draft_email", args: { job_id: ctx.ids.jobs[job].id, resume_id: tailored ?? null } }] };
  },
  (ctx) => {
    const email = ctx.last("draft_email");
    const attachment = email?.attachment ? String(email.attachment).split(/[\\/]/).pop() : "（PDF 没导出来）";
    return { text: "投递包都存到示例科技「数据分析师（2026 届校招）」下了，没有发出去，主简历没动：\n"
      + "- 定制简历：按 JD 把 GMV 周报和 A/B 测试分析提前；\n- BOSS 直聘打招呼语、小红书私信各一份；\n"
      + `- 投递邮件草稿：收件人 ${email?.to ?? "hr-test@example.com"}，标题「${email?.subject ?? ""}」，附件 ${attachment}。\n`
      + "邮件标题里的「最快到岗时间」需要你确认后填上。" };
  },
];

export const SCRIPTS: Record<string, Script> = {
  "发现经历：追问": [
    { calls: [{ name: "overview", args: {} }, { name: "list", args: { type: "memory" } }] },
    (ctx) => ({ calls: [{ name: "get", args: { type: "doc", id: ctx.ids.main_resume } }] }),
    { text: "看了你的档案和主简历，实习和留存项目都只写了「做了什么」，没写怎么做、结果如何。先问三个问题：\n"
      + "1. 电商实习的起止时间和职位？每周固定做哪些报表，用什么工具？\n2. 有没有做过一次完整的专题分析（比如活动或实验）？结论是什么？\n"
      + "3. 留存项目是个人还是小组？你具体负责哪一块？\n简历我先不动，等你回答。" },
  ],
  "发现经历：回答": [
    { calls: [{ name: "list", args: { type: "memory" } }] },
    (ctx) => ({ calls: [
      { name: "save", args: { type: "memory", id: ctx.ids.memories[0], data: {
        start: "2025-07", end: "2025-09",
        body: "2025.07–2025.09 在示例电商做数据分析实习生。每周用 SQL 出 GMV 周报；给运营做过一次优惠券 A/B 测试分析，结论是满减券比折扣券转化高，具体高多少记不清。",
        quote: GAP_ANSWER.slice(GAP_ANSWER.indexOf("电商那段实习"), GAP_ANSWER.indexOf("留存项目")), said_at: ctx.today,
      } } },
      { name: "save", args: { type: "memory", id: ctx.ids.memories[1], data: {
        body: "课程项目，3 人一组；我负责用 Python 画留存曲线、找流失节点。",
        quote: "留存项目是课程项目，3 人一组，我负责用 Python 画留存曲线、找流失节点。", said_at: ctx.today,
      } } },
    ] }),
    { text: "记进档案了：\n- 示例电商实习：2025.07–2025.09，每周用 SQL 出 GMV 周报；优惠券 A/B 测试分析结论是满减券转化更高，提升幅度按你说的写「记不清」，没填数字；\n"
      + "- 留存项目：3 人课程项目，你负责用 Python 画留存曲线、找流失节点。\n技能里没加 BI 工具。主简历没动。" },
  ],
  "重复信号": [
    { calls: [{ name: "list", args: { type: "memory" } }] },
    { text: "这些上一条已经记进档案了（实习和留存项目两条），内容一致，这次没有重复存。" },
  ],
  "比较三个岗位": [
    { calls: [{ name: "list", args: { type: "job" } }, { name: "list", args: { type: "memory" } }] },
    { text: "按投递优先级：\n"
      + "1. 示例科技「数据分析师（2026 届校招）」：匹配证据是每周 SQL 出 GMV 周报、做过优惠券 A/B 测试分析，正对 JD 的指标周报和 A/B 实验；短板是 A/B 结果没有数字、BI 工具是加分项你没有；下一步先补 A/B 的真实数据，再做投递包。\n"
      + "2. 样例零售「用户增长分析实习生」：留存曲线、流失节点的课程项目对上漏斗 / 留存加分项，SQL 也对口；短板是要求每周到岗 4 天、实习 6 个月以上，需要确认你的时间；下一步确认到岗时间后再投。\n"
      + "3. 演示资本「量化研究员（校招）」：硬性条件不符合，JD 要求硕士及以上、本科简历不予考虑，你是本科，不建议投，也不用为它改简历。" },
  ],
  "投递包": packSteps("j1"),
  "投递包（中途中断）": packSteps("j1"),
  "投递包（重试）": packSteps("j1"),
  "同岗三渠道话术": packSteps("j1").filter((_, index) => index !== 1),
  "要求编造数字": [
    { text: "这条我不帮你写：你之前说过 A/B 测试具体高多少记不清，「转化率提升 30%」没有依据，面试一追问就站不住。"
      + "可以先写「对比满减券与折扣券两组下单转化率，建议运营保留满减券」，等你查到真实数字再补上。主简历这次没改。" },
  ],
  "面试开始": [
    (ctx) => ({ calls: [{ name: "list", args: { type: "doc", job_id: ctx.ids.jobs.j1.id } }] }),
    { text: "好，我按示例科技数据分析师的一面来，一次只问一题。练习里的回答只用来复盘，不会写进档案。\n\n第 1 题：你实习时每周的 GMV 周报具体是怎么做的？用了哪些数据、算了哪些指标？" },
  ],
  "面试回答 1": [
    { text: "取数来源和指标说得很清楚。\n\n第 2 题：讲一次你做过的 A/B 测试分析：实验怎么分组、你具体做了什么、结论是什么？" },
  ],
  "面试回答 2（含糊）": [
    { text: "你具体用 SQL 查了哪些数据、比较了哪两组的什么指标，最后给运营的建议是什么？" },
  ],
  "面试回答 3（回应追问）": [
    { text: "这次讲清楚了分组、周期和比较的指标，提升幅度没记下来这一点我们复盘时再说。\n\n第 3 题：如果某天下单转化率突然下降，你会怎么排查？" },
  ],
  "面试回答 4": [
    { text: "先对口径、再拆漏斗定位，思路对。\n\n第 4 题：为什么想做电商数据分析，而不是别的方向？" },
  ],
  "复盘": [
    (ctx) => ({ calls: [{ name: "save", args: { type: "doc", data: {
      kind: "review", job_id: ctx.ids.jobs.j1.id, title: "模拟面试复盘 · 示例科技 数据分析师",
      body: "# 模拟面试复盘\n\n## 答得好\n- 第 1 题：「" + ANSWER_1 + "」取数来源、指标、受众、范围都具体。\n"
        + "- 第 3 题：先确认口径再拆漏斗，结构清楚。\n\n## 含糊的地方\n- 第 2 题第一次回答：「就是用 SQL 查了一些数据，然后做了一些分析，给了点建议。」没说查了什么、比了什么、建议依据。\n"
        + "- 追问后说清了分组和周期，但「具体提升多少我当时没记下来」：缺结果数字。\n\n## 练习任务\n"
        + "1. 用 STAR 重写 A/B 测试那段（2 分钟口述）。完成标准：说出分组方式、实验周期、比较的指标、结论和你的建议，录音不超过 2 分钟。\n"
        + "2. 找回 A/B 测试的真实结果。完成标准：拿到两组转化率差值和样本量，能说出数字来源。\n"
        + "3. 准备「转化率下降怎么排查」的完整答法。完成标准：写出 4 步以上的排查顺序，每步有一个你会看的具体指标。",
    } } }] }),
    { text: "复盘存到示例科技「数据分析师（2026 届校招）」下了：引用了你第 2 题的原话「就是用 SQL 查了一些数据…」，列了 3 个练习任务，每个都写了完成标准。" },
  ],
  "新会话用新证据": [
    { calls: [{ name: "search", args: { query: "复盘" } }, { name: "list", args: { type: "memory" } }] },
    (ctx) => ({ calls: [{ name: "save", args: { type: "memory", id: ctx.ids.memories[0], data: {
      body: "2025.07–2025.09 在示例电商做数据分析实习生。每周用 SQL 出 GMV 周报；给运营做过一次优惠券 A/B 测试分析："
        + "满减券组下单转化率比折扣券组高 2.1 个百分点，两组样本各约 8000 人，建议运营保留满减券。",
      quote: NEW_EVIDENCE, said_at: ctx.today,
    } } }] }),
    (ctx) => ({ calls: [{ name: "tailor_resume", args: { id: ctx.ids.main_resume, job_id: ctx.ids.jobs.j2.id } }] }),
    (ctx) => ({ text: `读了上次的复盘和档案。用了这条新证据：满减券组下单转化率比折扣券组高 2.1 个百分点、两组样本各约 8000 人。\n`
      + `- 写进了档案的示例电商实习经历；\n- 写进了样例零售「用户增长分析实习生」的定制简历（#${ctx.last("tailor_resume")?.doc_id ?? "?"}）的 A/B 测试要点。\n`
      + "模拟面试里的练习回答没有写进档案。主简历没动。" }),
  ],
};

// ---------------- the client ----------------

export class ScriptedLlm implements LlmClient {
  readonly provider = "mock";
  readonly model = "journey-script";
  readonly local = true;
  private steps: Script = [];
  private label = "";
  private blockAfterTools = 0;
  /** Problems the harness reports: a turn with no script, a script that ran out, an unexpected sub-model call. */
  readonly problems: string[] = [];

  constructor(private readonly ids: SeedIds, private readonly today: string) {}

  beginTurn(turn: Turn): void {
    this.label = turn.label;
    const script = SCRIPTS[turn.label];
    if (!script) this.problems.push(`没有回合「${turn.label}」的脚本`);
    this.steps = [...(script ?? [])];
    this.blockAfterTools = turn.abort_after_tools;
  }

  private next(messages: ChatMessage[]): MockStep {
    const results = toolResults(messages);
    const ctx: StepContext = {
      ids: this.ids,
      today: this.today,
      results,
      last: (name) => [...results].reverse().find((item) => item.name === name && !item.error)?.result,
    };
    while (this.steps.length) {
      const step = this.steps.shift()!;
      const resolved = typeof step === "function" ? step(ctx) : step;
      if (resolved.text || resolved.calls?.length) return resolved;
    }
    this.problems.push(`回合「${this.label}」的脚本用完了还在要下一步`);
    return { text: "（脚本没有更多步骤）" };
  }

  async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true };
    const done = (content: string, toolCalls: ParsedToolCall[], finishReason: string): LlmStreamEvent => ({
      type: "done", result: { provider: this.provider, model: this.model, content, reasoning: "", toolCalls, finishReason, usage },
    });
    const toolsSoFar = request.messages.filter((message) => message.role === "tool").length;
    if (this.blockAfterTools && toolsSoFar >= this.blockAfterTools) {
      // Simulates a slow model turn: hold until the harness aborts the run.
      const signal = request.signal;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 30_000);
      });
      if (!signal?.aborted) this.problems.push(`回合「${this.label}」等了 30 秒，harness 没有中断它`);
      yield signal?.aborted ? done("", [], "aborted") : { type: "done", result: { provider: this.provider, model: this.model, content: "", reasoning: "", toolCalls: [], finishReason: "error", usage, error: "mock：等中断超时" } };
      return;
    }
    const step = this.next(request.messages);
    if (step.text) yield { type: "text_delta", text: step.text };
    const toolCalls: ParsedToolCall[] = (step.calls ?? []).map((call, index) => ({
      id: `call_${Date.now().toString(36)}_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args,
    }));
    yield done(step.text ?? "", toolCalls, toolCalls.length ? "tool_calls" : "stop");
  }

  async chat(messages: LlmMessage[], _options?: LlmChatOptions): Promise<string | null> {
    const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
    const user = messages.slice(1).map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    // tailor_resume: draft (TAILOR_PROMPT) and review (REVIEW_PROMPT) in packages/core/src/resume/tailor-prompts.ts
    if (system.startsWith("你是简历编辑")) return tailoredDraft(user);
    if (system.startsWith("你是简历审稿人")) return EMPTY_REVIEW;
    this.problems.push(`回合「${this.label}」里有没准备的子模型调用：${system.slice(0, 40)}`);
    return null;
  }
}
