// Progressive Skill loading for the built-in Agent (pattern from Flovart
// services/agentSkills.ts: a short skill index in the system prompt, the full
// text read on demand with a skill tool). Skills are methodology only: how to
// do a kind of task with the existing tools. They add no business logic.
//
// The mock-interview and role-research rules are the evaluated v4 prompt text
// (docs/DOGFOOD.md 2026-11-07), moved verbatim. A skill whose triggers match
// the user's message (or the recent conversation) is loaded into the system
// prompt up front, so tuned rules never depend on the model remembering to
// read them; the rest are listed in the index and read with skill_read.

export interface AgentSkill {
  id: string;
  title: string;
  /** One line in the index: when to read it. */
  when: string;
  /** Auto-load when the user's message or recent conversation matches. */
  triggers: RegExp;
  body: string;
  /** Skill Hub 里「试一下」填进输入框的示例说法（会命中 triggers，自动加载这个技能）。 */
  example?: string;
}

/** Rules that hold for every task (always in the system prompt). */
export const CORE_RULES = "规则：\n- 只用工具查到的记录和用户说的话，不编造经历、数字、公司、技能。\n- 对外的事（发邮件、回复 HR、提交网申）只写草稿存成 doc，不替用户发出。\n- 用 add_job 存了岗位就接着用 evaluate_jobs 评估它；用户问值不值得投、怎么准备时，先 get 岗位看评估文档（doc kind=evaluation）。\n- save / delete 直接生效，用户能在「最近改动」里撤销；做完告诉用户改了什么。\n- 你 save 的记忆（memory）会自动记成 source=agent、待确认，待确认的不会写进定制简历。不要自己设 confirmed，也不要把 source 改成 user；存完告诉用户去档案页点「确认」。评估分数、自评这类你自己的产出不是用户的经历，不存成记忆。\n- 要某条记忆的细节（正文、数字、用户原话）就 get(type=memory, id=…) 或 search，不要凭标题猜内容。\n- 用户说了长期的写法要求（「以后不要突出X」「口径统一写Y」），就 save 一条 memory：kind=preference，title 写规则要点，body 写清规则，quote 记用户原话。\n- 用新补充的证据（新经历、新数字）写了简历或材料时，回复里点名用了哪几条新证据、写进了哪里，关键数字原样写出来。\n- 用户一条消息里要了几步（如先更新档案、再写定制简历、最后说明），就在本轮把每一步做完再回复；不要只说「接下来做 X」就结束。做不完（工具报错、缺只有用户能定的信息、步数用完）就说清哪步没做、为什么。\n";

export const AGENT_SKILLS: AgentSkill[] = [
  {
    id: "interview-practice",
    example: "按我投的岗位给我来一场模拟面试",
    title: "模拟面试与面试准备",
    when: "模拟面试、押题、自我介绍、面试复盘",
    triggers: /模拟面试|面试练习|练(一下|练)?面试|mock ?interview|押题|自我介绍|第\s*\d+\s*题|面试官/i,
    body: "- 模拟面试时像真面试官，一次只问一个问题，每道新题用「第 N 题：」开头。用户回答含糊（没说具体做了什么、怎么做、结果如何）时，这条回复只用一个问题追问他具体做了什么或结果，然后停下；不点评、不给框架或示范、不出下一题。追问后仍答不清，可以简短点评、给答题框架，结尾让他按框架重答同一题，同一条里不出下一题。每道题最多一次追问加一次重答：重答后只要讲具体了一部分、说记不清或跳过、或者答到了别的话题，就把这题没答上的点记为缺口留到复盘，接住用户已经说的内容，进下一题；不要第三次拉回同一题。用户答到的是你还没问的话题时，把它当作新一题的回答来处理。面试回合里不插入关于档案、存储的说明。完整点评和示范放到复盘里。\n- 模拟面试里的回答是练习，不直接写进档案或简历；用户明确说这是真实经历、要记下来时才 save，并标明来源是用户口述。\n- 模拟面试出题前先 get 这个岗位的调研（doc kind=research）：有调研就先从 ## 面试方案 里的题和 Gap 质疑题里挑，再补别的；没有调研就按 JD 和评估出题。\n- 自我介绍：先审材料，标出哪些有事实支撑、哪些只是评价、缺背景 / 行动 / 结果 / 本人贡献的地方；一次只问一个最关键的问题，问够了再写。口语化，只挑最相关的经历；缺的标【待补：…】，附事实核对清单。存 doc kind=note。\n- 押题：每题写由哪条材料触发、在考什么，不写「必问」。复盘存 doc kind=review，挂到岗位。\n- 工具步骤：tool_manual(capability=\"interview.prepare\")。\n",
  },
  {
    id: "role-research",
    example: "帮我调研一下这家公司和岗位，准备面试",
    title: "岗位 / 公司调研",
    when: "准备面试前了解岗位或公司、写调研文档、查面经",
    triggers: /调研|准备.{0,8}面试|了解(一下)?(这家|这个)?(公司|岗位|团队)|公司背景|面经|竞品|业务线|research/i,
    body: "- 岗位调研（用户要准备面试、了解岗位或公司）：先 get 岗位，再用 web_search / fetch_page 查公司官网、招聘官网、官方文档、权威媒体、牛客等；调研存成 doc kind=research、带 job_id，body 用这个 Markdown 结构（岗位页按它分层展示）：\n  # 结论 下面第一段一句话说清岗位本质；一行「> 风险：…」；再 3–4 条「- 关键观察」。\n  然后依次 ## 产品与业务、## 团队与组织、## 竞品、## 同类 JD 对比、## 日常工作与指标、## 面经、## 经历包装、## 面试方案、## 反问、## 准备清单；每个板块第一段是一句摘要，下面每条要点一行「- …」，并落到「对你意味着什么」。\n  每条要点末尾标口径和来源：[official S1] / [media S2] / [third_party_estimate S3] / [community S4] / [inference] / [gap]；最后 ## 来源 每行「- S1 标题 · 发布方 · 日期 · 链接」。\n  没有可靠来源就写 [gap]，不编数字，不把估算写成事实，不把相近岗位、镜像站、招聘转载当成这个岗位；经历包装只用档案里的事实。\n  面经：同一考点有 2 个以上独立来源才写「高频」，只有一个来源就标「单一来源」；只用近 18 个月的面经；不写薪资、八卦和面试官个人信息。\n  ## 面试方案 先定面试类型：业务面（一面、二面）重专业题和简历深挖，HR 面重动机、稳定性、求职选择和离职原因；邮件或事项显示是 HR 面就按 HR 面，判断不了就两种都给并写明各自侧重。\n  ## 面试方案 里加「Gap 质疑题」：从评估的差距里挑面试官最可能问的，最多 3 道；每道答法分四步：承认差距、可迁移的能力和档案里的证据、已经做了哪些补足、落回这个岗位的价值。没有差距就不出。\n  ## 经历包装 里给 1 分钟和 3 分钟两版自我介绍，只用档案里的事实。\n  业务题、简历深挖、行为题、Gap 质疑题之间，同一个考点只出一次。\n- 工具步骤：tool_manual(capability=\"role.research\")。\n",
  },
  {
    id: "resume-tailoring",
    example: "针对这个岗位帮我改一版简历",
    title: "按岗位定制简历",
    when: "针对某个岗位改简历、补经历、导出投递版 PDF",
    triggers: /简历|resume|\bcv\b|定制|改写|导出.{0,4}pdf/i,
    body: "- 先 get 岗位确认 JD 和评估，再 tailor_resume；返回的 asks 逐句问用户，一次一句。\n"
      + "- 用户确认的回答整理成记忆给用户看，确认后 save(memory)（带原话 quote 和日期 said_at，不加原话里没有的数字），再 review_only=true 改一次。\n"
      + "- 用户确认过的内容不能删；不加用户没做的事；数字要能追到用户原话、文件或公开数据；不把参与写成主导。\n"
      + "- 评估分数、模型自评、匹配度不是用户的成果，不写进简历或记忆。\n"
      + "- 改完回复里点名用了哪几条新证据、写进了哪里；拿不准的措辞给推荐写法并说明。\n"
      + "- 工具步骤：tool_manual(capability=\"resume.tailor\")。\n",
  },
  {
    id: "job-evaluation",
    example: "这个岗位值不值得投？和我的匹配度怎么样",
    title: "岗位评估与证据对照",
    when: "值不值得投、匹配度、差距、打招呼语",
    triggers: /值不值得|该不该投|适合我|匹配|评估|差距|打招呼|greeting/i,
    body: "- 先 get 岗位看评估文档（doc kind=evaluation）；没有就 evaluate_jobs(ids=[id])，返回 remaining>0 再调。\n"
      + "- 结论要落到 JD 原文的逐条要求：有证据 / 证据弱 / 缺失 / 硬性条件，各引 JD 原文和档案里的记录 #id。\n"
      + "- 只把已确认的记忆当事实；待确认的标出来；缺证据的要求列为差距，问用户一句，不编。\n"
      + "- 打招呼语里每个事实都要在档案里找得到。\n"
      + "- 工具步骤：tool_manual(capability=\"evidence.map\")。\n",
  },
  {
    id: "email-writing",
    example: "帮我写一封投递邮件发给 HR",
    title: "投递邮件与网申回答",
    when: "写投递邮件、回复 HR、回答网申问题",
    triggers: /邮件|邮箱投递|发给\s*HR|回复\s*HR|网申|申请表|求职信|cover ?letter/i,
    body: "- 邮件用 draft_email，网申问题用 apply_answer；都只写草稿，不替用户发送或提交，写完把草稿给用户看。\n"
      + "- 标题、附件名按 JD 要求的格式（如「姓名-岗位」）；和 JD 要求不一致时提醒用户改。\n"
      + "- 正文只用档案里的事实，不编数字；用了新补充的证据要点名。\n",
  },
];

/** Skills whose triggers match any of the texts, in index order. */
export function matchSkills(texts: readonly string[]): AgentSkill[] {
  const joined = texts.filter(Boolean).join("\n");
  if (!joined) return [];
  return AGENT_SKILLS.filter((skill) => skill.triggers.test(joined));
}

/** Index + the bodies of auto-loaded skills, for the system prompt. */
export function skillPrompt(loaded: readonly AgentSkill[]): string {
  const ids = new Set(loaded.map((skill) => skill.id));
  const index = AGENT_SKILLS.map((skill) => `- ${skill.id}（${skill.title}）：${skill.when}${ids.has(skill.id) ? " · 已加载" : ""}`).join("\n");
  const bodies = loaded.map((skill) => `## 技能 ${skill.id}：${skill.title}\n${skill.body}`).join("");
  return `技能索引（做这类任务前先 skill_read(id) 读方法；标「已加载」的在下面）：\n${index}\n${bodies}`;
}

export type SkillReadResult =
  | { ok: true; id: string; title: string; body: string }
  | { ok: false; error: { code: "not_found"; message: string; retryable: false; suggestedAction: string } };

export function readSkill(id: unknown): SkillReadResult {
  const skill = AGENT_SKILLS.find((item) => item.id === String(id ?? "").trim());
  if (!skill) {
    return { ok: false, error: { code: "not_found", message: `没有技能 ${String(id)}`, retryable: false, suggestedAction: `可用：${AGENT_SKILLS.map((item) => item.id).join(", ")}` } };
  }
  return { ok: true, id: skill.id, title: skill.title, body: skill.body };
}

export const SKILL_READ_SPEC = {
  name: "skill_read",
  description: "读一个技能的完整方法（做模拟面试、调研、改简历、评估、写邮件前读）。只读。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string", enum: AGENT_SKILLS.map((skill) => skill.id) } },
    required: ["id"],
  } as Record<string, unknown>,
};

// ---- Skill Hub（只读目录：界面展示技能列表，不改技能本身） ----

export interface SkillCatalogEntry {
  id: string;
  title: string;
  when: string;
  /** 自动加载的触发词（由 triggers 的正则拆出来给人看）。 */
  keywords: string[];
  body: string;
  example: string;
}

/** 把触发正则拆成人能读的关键词：按顶层 | 拆，去掉正则语法，过短的丢掉。 */
export function triggerKeywords(pattern: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of pattern.source) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  const cleaned = parts
    .map((part) => part
      .replace(/\\d\+?/g, "N")
      .replace(/\\b|\\s\*|\\s|\.\{\d+,\d+\}|\?:/g, "")
      .replace(/\(([^()|]*)\|[^()]*\)\??/g, "$1")
      .replace(/[()?*+^$[\]{}\\]/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((part) => part.length >= 2);
  return [...new Set(cleaned)];
}

export function skillCatalog(): SkillCatalogEntry[] {
  return AGENT_SKILLS.map((skill) => ({
    id: skill.id,
    title: skill.title,
    when: skill.when,
    keywords: triggerKeywords(skill.triggers),
    body: skill.body,
    example: skill.example ?? "",
  }));
}
