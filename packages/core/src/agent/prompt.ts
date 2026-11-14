// Built-in Agent system prompt — port of backend/app/core/agent.py
// (system_prompt / memory_index / memory_full), core/tailor.py rules(), plus
// the host suffix from services/embedded_agent_host.py _system_prompt.
// The rule text is copied verbatim from Python.

import { MEMORY_KIND } from "../labels";
import { overview } from "../operations";
import type { CoreContext, CoreStore, MemoryKind, StoredRecord } from "../types";

export const AGENT_ACTOR = "助手";
export const MAX_STEPS = 6;
const INDEX_LINES = 60;
const INDEX_CHARS = 3000;
export type MemoryArm = "none" | "index" | "full";

const RULES = "规则：\n- 只用工具查到的记录和用户说的话，不编造经历、数字、公司、技能。\n- 对外的事（发邮件、回复 HR、提交网申）只写草稿存成 doc，不替用户发出。\n- 用 add_job 存了岗位就接着用 evaluate_jobs 评估它；用户问值不值得投、怎么准备时，先 get 岗位看评估文档（doc kind=evaluation）。\n- save / delete 直接生效，用户能在「最近改动」里撤销；做完告诉用户改了什么。\n- 你 save 的记忆（memory）会自动记成 source=agent、待确认，待确认的不会写进定制简历。不要自己设 confirmed，也不要把 source 改成 user；存完告诉用户去档案页点「确认」。评估分数、自评这类你自己的产出不是用户的经历，不存成记忆。\n- 要某条记忆的细节（正文、数字、用户原话）就 get(type=memory, id=…) 或 search，不要凭标题猜内容。\n- 用户说了长期的写法要求（「以后不要突出X」「口径统一写Y」），就 save 一条 memory：kind=preference，title 写规则要点，body 写清规则，quote 记用户原话。\n- 模拟面试时像真面试官，一次只问一个问题，每道新题用「第 N 题：」开头。用户回答含糊（没说具体做了什么、怎么做、结果如何）时，这条回复只用一个问题追问他具体做了什么或结果，然后停下；不点评、不给框架或示范、不出下一题。追问后仍答不清，可以简短点评、给答题框架，结尾让他按框架重答同一题，同一条里不出下一题。每道题最多一次追问加一次重答：重答后只要讲具体了一部分、说记不清或跳过、或者答到了别的话题，就把这题没答上的点记为缺口留到复盘，接住用户已经说的内容，进下一题；不要第三次拉回同一题。用户答到的是你还没问的话题时，把它当作新一题的回答来处理。面试回合里不插入关于档案、存储的说明。完整点评和示范放到复盘里。\n- 模拟面试里的回答是练习，不直接写进档案或简历；用户明确说这是真实经历、要记下来时才 save，并标明来源是用户口述。\n- 模拟面试出题前先 get 这个岗位的调研（doc kind=research）：有调研就先从 ## 面试方案 里的题和 Gap 质疑题里挑，再补别的；没有调研就按 JD 和评估出题。\n- 用新补充的证据（新经历、新数字）写了简历或材料时，回复里点名用了哪几条新证据、写进了哪里，关键数字原样写出来。\n- 用户一条消息里要了几步（如先更新档案、再写定制简历、最后说明），就在本轮把每一步做完再回复；不要只说「接下来做 X」就结束。做不完（工具报错、缺只有用户能定的信息、步数用完）就说清哪步没做、为什么。\n- 岗位调研（用户要准备面试、了解岗位或公司）：先 get 岗位，再用 web_search / fetch_page 查公司官网、招聘官网、官方文档、权威媒体、牛客等；调研存成 doc kind=research、带 job_id，body 用这个 Markdown 结构（岗位页按它分层展示）：\n  # 结论 下面第一段一句话说清岗位本质；一行「> 风险：…」；再 3–4 条「- 关键观察」。\n  然后依次 ## 产品与业务、## 团队与组织、## 竞品、## 同类 JD 对比、## 日常工作与指标、## 面经、## 经历包装、## 面试方案、## 反问、## 准备清单；每个板块第一段是一句摘要，下面每条要点一行「- …」，并落到「对你意味着什么」。\n  每条要点末尾标口径和来源：[official S1] / [media S2] / [third_party_estimate S3] / [community S4] / [inference] / [gap]；最后 ## 来源 每行「- S1 标题 · 发布方 · 日期 · 链接」。\n  没有可靠来源就写 [gap]，不编数字，不把估算写成事实，不把相近岗位、镜像站、招聘转载当成这个岗位；经历包装只用档案里的事实。\n  面经：同一考点有 2 个以上独立来源才写「高频」，只有一个来源就标「单一来源」；只用近 18 个月的面经；不写薪资、八卦和面试官个人信息。\n  ## 面试方案 先定面试类型：业务面（一面、二面）重专业题和简历深挖，HR 面重动机、稳定性、求职选择和离职原因；邮件或事项显示是 HR 面就按 HR 面，判断不了就两种都给并写明各自侧重。\n  ## 面试方案 里加「Gap 质疑题」：从评估的差距里挑面试官最可能问的，最多 3 道；每道答法分四步：承认差距、可迁移的能力和档案里的证据、已经做了哪些补足、落回这个岗位的价值。没有差距就不出。\n  ## 经历包装 里给 1 分钟和 3 分钟两版自我介绍，只用档案里的事实。\n  业务题、简历深挖、行为题、Gap 质疑题之间，同一个考点只出一次。\n";

export const HOST_PROMPT_SUFFIX = "\n缺少只有用户能定的偏好或取舍时，用 request_user_input 问一句。";

/** json.dumps(value, ensure_ascii=False) with Python's default ", " / ": " separators. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(", ")}}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function head(memory: StoredRecord): string {
  const title = String(memory.title ?? "").split(/\s+/).filter(Boolean).join(" ") || "（无标题）";
  const line = `#${memory.id} [${MEMORY_KIND[memory.kind as MemoryKind] ?? "其他"}] ${title}`;
  return memory.confirmed === false ? `${line} · 待确认` : line;
}

export async function memoryIndex(store: CoreStore): Promise<string> {
  const memories = [...await store.all("memory")].sort((a, b) => b.id - a.id);
  const lines: string[] = [];
  let size = 0;
  for (const memory of memories) {
    const line = head(memory);
    if (lines.length >= INDEX_LINES || size + line.length + 1 > INDEX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (memories.length > lines.length) lines.push(`……还有 ${memories.length - lines.length} 条更早的没列出，要找就 search`);
  return lines.join("\n") || "（还没有记忆）";
}

export async function memoryFull(store: CoreStore): Promise<string> {
  const blocks = [...await store.all("memory")].sort((a, b) => b.id - a.id).map((memory) => {
    const quote = memory.quote ? `（用户原话：${String(memory.quote)}）` : "";
    return [head(memory), String(memory.body ?? "").trim(), quote].filter(Boolean).join("\n");
  });
  return blocks.join("\n\n") || "（还没有记忆）";
}

/** core/tailor.py rules(): confirmed kind=preference memories, one "- title：body" line each. */
export async function preferenceRules(store: CoreStore): Promise<string> {
  const usable = [...await store.all("memory")].sort((a, b) => a.id - b.id).filter((memory) => memory.confirmed !== false);
  return usable
    .filter((memory) => memory.kind === "preference")
    .map((memory) => [String(memory.title ?? "").trim(), String(memory.body ?? "").trim()].filter(Boolean).join("："))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

export interface PromptOptions {
  maxSteps?: number;
  memoryArm?: MemoryArm;
}

export async function agentSystemPrompt(store: CoreStore, ctx: CoreContext, options: PromptOptions = {}): Promise<string> {
  const view = await overview(store, ctx);
  const summary: Record<string, unknown> = {
    stage: view.stage,
    next_step: view.next_step,
    jobs: Object.fromEntries(Object.entries(view.jobs).filter(([, count]) => count)),
    todos: Object.fromEntries(Object.entries(view.todos).filter(([, items]) => items.length).map(([key, items]) => [key, items.length])),
  };
  if (view.mail) summary.mail = view.mail;
  const arm = options.memoryArm ?? "index";
  let memory = "";
  if (arm === "index") {
    const ruled = await preferenceRules(store);
    memory = `用户的记忆索引（只有标题，新的在前）：\n${await memoryIndex(store)}\n`
      + (ruled ? `用户的口径和偏好（必须遵守，不当作事实）：\n${ruled}\n` : "");
  } else if (arm === "full") {
    memory = `用户的记忆（全文，新的在前；标「待确认」的还不能当事实）：\n${await memoryFull(store)}\n`;
  }
  return `你是 OfferU 里的求职助手。今天是 ${view.today}。\n`
    + `用户现在的情况（overview 摘要）：${pyJson(summary)}\n`
    + memory
    + RULES
    + `- 最多调用 ${options.maxSteps || MAX_STEPS} 轮工具，先用 overview / search / get 查清楚再写。`;
}
