// Progressive tool disclosure for the built-in Agent (pattern from Flovart
// workflow.node.tool.list + nodeToolCatalog: a short catalog every turn, the
// full manual on demand). The registry (specs.ts) stays the one source of
// names, full descriptions and JSON schemas; HTTP keeps listing it (the CLI on --help)
// unchanged. The Agent sees, per turn, a one-line brief and a slim schema
// (same types / enums / required / bounds, no titles or prose) and reads the
// full manual with `tool_manual`.
//
// Capabilities are recipes over existing tools only: an ordered list of tool
// calls and the rules that hold while doing them. They add no business logic.

import type { JsonSchema, ToolSpec } from "./schema";

/** One line the model reads every turn. Keep the guardrails that change what it does next. */
export const TOOL_BRIEFS: Record<string, string> = {
  overview: "先调这个：求职阶段、下一步、待办、各状态岗位数、最近改动。",
  search: "按关键词搜全部记录，返回 type、id、摘要。找用户的经历和原话先用它。",
  list: "列出一类记录（长文本截断，全文用 get）。字段见 tool_manual。",
  get: "读一条完整记录；岗位连带它的事项和文档。",
  save: "新建或更新一条记录（不传 id 就新建），直接生效、可撤销。常用字段：memory{kind,title,body,mode,start,end,quote,said_at,tags} job{company,title,status,url,city,jd,notes,tags} event{title,kind,at,job_id,done} doc{kind,title,body,job_id}；完整字段和规则见 tool_manual(names=[\"save\"])。",
  delete: "删除一条记录（可撤销）。",
  undo: "撤销一条改动（change_id）。",
  changes: "最近改动，最新在前。",
  read_file: "读本机 PDF / Word / txt / md 文件的文字（如旧简历）。",
  find_files: "找本机文件：列目录或按文件名 / 正文筛；用户说的位置自己拼成绝对路径。",
  web_search: "搜公开网页（标题、链接、摘要）；正文用 fetch_page。没配搜索服务会报错，照实说。",
  fetch_page: "抓一个公开网页的文字；要登录或 JS 的页面可能拿不到。",
  export_resume_pdf: "把一份简历（doc kind=resume）导出成 PDF，返回文件路径。",
  email_sync: "邮箱同步：action=status 看状态，sync 立刻拉新邮件并更新岗位状态和事项（可撤销）。",
  tailor_resume: "按岗位 JD 改写简历（只用档案事实，可撤销，要一两分钟）。返回的 asks 逐句问用户，确认后存 memory，再 review_only=true 改一次。",
  split_resume: "把旧简历（text 或 path）拆成一条条 memory 存进档案（可撤销，会调模型）。",
  add_job: "用户贴岗位链接或 JD 时用：抓正文、拆字段、截止日期存成事项（可撤销）。抓不到就让用户贴 JD；存完接着 evaluate_jobs。",
  evaluate_jobs: "评估岗位值不值得投，评估报告存成 evaluation 文档，分数和理由写回岗位（可撤销，会调模型）。返回 remaining>0 就再调一次。",
  apply_answer: "回答招聘官网的网申问题，问答追加到岗位的 apply_chat 文档（可撤销）。",
  draft_email: "写投递邮件草稿并导出简历 PDF，存成岗位的 email 文档。不会发送，给用户看后用户自己发。",
  reconcile_memory: "只读核对职业记忆的前后矛盾、重复和久未补全；不要自己拿 proposed 去 save，让用户在档案页采纳。",
  export_data: "导出全部数据为一个 JSON 备份。",
};

/** Capability index groups, in the order the system prompt lists them. */
export const TOOL_GROUPS: Array<{ id: string; title: string; tools: string[] }> = [
  { id: "records", title: "记录读写", tools: ["overview", "search", "list", "get", "save", "delete", "undo", "changes"] },
  { id: "jobs", title: "岗位", tools: ["add_job", "evaluate_jobs"] },
  { id: "resume", title: "简历与材料", tools: ["find_files", "read_file", "split_resume", "tailor_resume", "export_resume_pdf"] },
  { id: "research", title: "联网调研", tools: ["web_search", "fetch_page"] },
  { id: "apply", title: "投递与邮件", tools: ["apply_answer", "draft_email", "email_sync"] },
  { id: "memory", title: "记忆核对与备份", tools: ["reconcile_memory", "export_data"] },
];

export interface Capability {
  id: string;
  title: string;
  /** When to pick it. */
  when: string;
  /** Existing tools, in the order they are usually called. */
  steps: string[];
  /** Rules that hold while running it. */
  rules: string[];
}

/** High-level capabilities = compositions of existing tools (no new business logic). */
export const CAPABILITIES: Capability[] = [
  {
    id: "role.research",
    title: "岗位 / 公司调研",
    when: "用户要准备面试、了解岗位或公司。",
    steps: [
      "get(type=job, id) 读 JD 和已有文档；已有 research 就在它上面补",
      "web_search 查官网、招聘官网、官方文档、权威媒体、牛客面经",
      "fetch_page 读来源正文，记链接和日期",
      "save(type=doc, data={kind:\"research\", job_id, title, body}) 按系统提示的调研结构存",
    ],
    rules: [
      "每条要点标口径和来源（[official S1] / [media S2] / [community S4] / [inference] / [gap]），没有可靠来源写 [gap]",
      "不把相近岗位、镜像站、转载当成这个岗位；面经只用近 18 个月",
    ],
  },
  {
    id: "evidence.map",
    title: "JD 要求 ↔ 档案证据对照",
    when: "用户问值不值得投、哪里不够、简历该突出什么。",
    steps: [
      "get(type=job, id) 读 JD 和 evaluation 文档；没有评估就 evaluate_jobs(ids=[id])",
      "search 用 JD 里的关键词找档案里的经历和用户原话",
      "get(type=memory, id) 读证据全文，引用原文和数字",
    ],
    rules: [
      "只把 confirmed 的记忆当用户的事实；待确认的标出来",
      "评估分数、自评是你的产出，不是用户的经历，不存成记忆",
      "缺证据的要求列为差距，问用户一句，不编",
    ],
  },
  {
    id: "resume.tailor",
    title: "按岗位定制简历",
    when: "用户要针对某个岗位改简历或导出投递版。",
    steps: [
      "get(type=job, id) 确认 JD 和评估",
      "tailor_resume(job_id 或 id)",
      "asks 逐句问用户（request_user_input 或直接问）",
      "用户确认的回答 save(type=memory, data={…, quote, said_at})",
      "tailor_resume(id=返回的 doc_id, review_only=true)",
      "要投递：draft_email(job_id, resume_id=doc_id)，它导出 PDF 当附件；只要 PDF 就 export_resume_pdf(id)",
      "看 draft_email 的 ready / missing，缺什么照实告诉用户",
    ],
    rules: [
      "不加原话里没有的数字，不把参与写成主导",
      "attachment 为 null 时不说附件已带上",
      "回复里点名用了哪几条新证据、写进了哪里",
    ],
  },
  {
    id: "interview.prepare",
    title: "面试准备与模拟",
    when: "用户要押题、自我介绍或模拟面试。",
    steps: [
      "get(type=job, id) 读 JD、evaluation 和 research",
      "没有 research 先走 role.research",
      "search / get(type=memory) 找能支撑回答的经历",
      "出题 / 模拟：一次一问；复盘存 save(type=doc, data={kind:\"review\", job_id, …})",
    ],
    rules: [
      "模拟时回答含糊只追问一个问题；每题最多一次追问加一次重答",
      "模拟面试里的回答是练习，用户明确说是真实经历才 save",
    ],
  },
];

const SCHEMA_PROSE_KEYS = new Set(["title", "description", "examples"]);

/**
 * Same validation shape, without prose: drops title / description / examples
 * and `default: null`, keeps types, enums, required, bounds, $defs / $ref.
 * Property descriptions up to `keepDescription` chars stay (they carry units
 * and formats the model needs, e.g. "YYYY-MM-DD").
 */
export function slimSchema(schema: JsonSchema, keepDescription = 24): JsonSchema {
  const walk = (node: unknown, isProperty: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, false));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "description" && isProperty && typeof value === "string" && [...value].length <= keepDescription) {
        out[key] = value;
        continue;
      }
      if (SCHEMA_PROSE_KEYS.has(key)) continue;
      if (key === "default" && value === null) continue;
      if (key === "properties" && value && typeof value === "object") {
        out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, walk(sub, true)]));
      } else if (key === "$defs" && value && typeof value === "object") {
        out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, walk(sub, false)]));
      } else {
        out[key] = walk(value, false);
      }
    }
    return out;
  };
  return walk(schema, false) as JsonSchema;
}

/** The brief the Agent sees each turn (falls back to the first sentence of the full description). */
export function toolBrief(spec: ToolSpec): string {
  const brief = TOOL_BRIEFS[spec.name];
  if (brief) return brief;
  const first = spec.description.split(/(?<=[。.!！?？])/)[0] ?? spec.description;
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** The capability index for the system prompt: groups of available tools + capability ids. */
export function capabilityIndex(available: readonly string[]): string {
  const have = new Set(available);
  const groups = TOOL_GROUPS
    .map((group) => ({ ...group, tools: group.tools.filter((name) => have.has(name)) }))
    .filter((group) => group.tools.length)
    .map((group) => `- ${group.title}：${group.tools.join(" / ")}`);
  const known = new Set(TOOL_GROUPS.flatMap((group) => group.tools));
  const rest = available.filter((name) => !known.has(name));
  if (rest.length) groups.push(`- 其他：${rest.join(" / ")}`);
  const caps = CAPABILITIES.filter((cap) => cap.steps.length).map((cap) => `${cap.id}（${cap.title}）`).join("、");
  return "工具索引（每轮只给了简短说明；参数不确定、要完整字段或规则时先调 tool_manual(names=[…])）：\n"
    + groups.join("\n")
    + `\n常用流程（tool_manual(capability=…) 看步骤）：${caps}\n`;
}

export interface ToolManualEntry {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolManualResult =
  | { ok: true; tools?: ToolManualEntry[]; capability?: Capability; index?: { groups: typeof TOOL_GROUPS; capabilities: Array<Pick<Capability, "id" | "title" | "when">> } }
  | { ok: false; error: { code: "not_found"; message: string; retryable: false; suggestedAction: string } };

/** tool_manual: the full registry manual for named tools, a capability recipe, or the index. */
export function toolManual(specs: readonly ToolSpec[], args: { names?: unknown; capability?: unknown }): ToolManualResult {
  const available = new Map(specs.map((spec) => [spec.name, spec]));
  const names = Array.isArray(args.names) ? args.names.map(String).filter(Boolean) : [];
  const capabilityId = typeof args.capability === "string" ? args.capability.trim() : "";
  if (capabilityId) {
    const capability = CAPABILITIES.find((cap) => cap.id === capabilityId);
    if (!capability) {
      return { ok: false, error: { code: "not_found", message: `没有流程 ${capabilityId}`, retryable: false, suggestedAction: `可用：${CAPABILITIES.map((cap) => cap.id).join(", ")}` } };
    }
    return { ok: true, capability: { ...capability, steps: capability.steps }, tools: names.flatMap((name) => (available.has(name) ? [manualEntry(available.get(name)!)] : [])) };
  }
  if (names.length) {
    const missing = names.filter((name) => !available.has(name));
    if (missing.length === names.length) {
      return { ok: false, error: { code: "not_found", message: `没有工具 ${missing.join(", ")}`, retryable: false, suggestedAction: `可用：${[...available.keys()].join(", ")}` } };
    }
    return { ok: true, tools: names.filter((name) => available.has(name)).map((name) => manualEntry(available.get(name)!)) };
  }
  return {
    ok: true,
    index: {
      groups: TOOL_GROUPS.map((group) => ({ ...group, tools: group.tools.filter((name) => available.has(name)) })).filter((group) => group.tools.length),
      capabilities: CAPABILITIES.map(({ id, title, when }) => ({ id, title, when })),
    },
  };
}

function manualEntry(spec: ToolSpec): ToolManualEntry {
  return { name: spec.name, description: spec.description, inputSchema: spec.inputSchema };
}

export const TOOL_MANUAL_NAME = "tool_manual";

export const TOOL_MANUAL_SPEC: ToolSpec = {
  name: TOOL_MANUAL_NAME,
  description: "查工具说明书：names 给完整说明和参数 JSON Schema；capability 给常用流程的步骤和规则；都不传给索引。只读。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      names: { type: "array", items: { type: "string" }, maxItems: 8 },
      capability: { type: "string", enum: CAPABILITIES.map((cap) => cap.id) },
    },
  },
};
