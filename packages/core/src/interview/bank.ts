// 面经 & 题库 (port of routes/interview.py + legacy_operations + agents/interview_prep).
// An experience is a doc kind=note with topic=interview_experience; its
// extracted questions live in doc.bank_questions (doc.questions is reserved
// for review questions by the core save check). A question id is derived:
// experience_id * 1000 + position (1-based), so /generate-answer can find it.

import { saveRecord } from "../operations";
import type { CoreStore, StoredRecord } from "../types";
import { CoreError } from "../types";
import { extractJson, requireLlm, type LlmClient } from "../llm";
import { NO_MODEL_HINT } from "../llm-endpoint";
import { desensitize, restore } from "./desensitize";
import { isObject, optionalPositiveInt, stringField, topicDocs, userContext, type Args } from "./common";

export const EXPERIENCE_TOPIC = "interview_experience";
const QUESTION_ID_STRIDE = 1000;

type BankQuestion = {
  question_text: string;
  round_type: string;
  category: string;
  difficulty: number;
  frequency: number;
  suggested_answer: string | null;
  created_at: string;
};

const EXTRACT_PROMPT = (company: string, role: string, rawText: string): string => `你是一位资深的校招面试辅导专家。
请从以下面经原文中提炼出所有面试问题，并结构化输出。

要求：
1. 每个问题独立一条
2. 判断所属面试轮次：hr（HR面）、department（业务/技术面）、final（终面）
3. 判断问题类型：behavioral（行为类）、technical（技术/专业类）、case（情景/案例类）、motivation（动机类）
4. 评估难度 1-5（1=简单常规，5=极难刁钻）
5. 如果面经提到了面试官的关注点，也请提取

以 JSON 格式返回：
{
  "rounds": ["提到的面试轮次，如 HR面、二面、终面"],
  "questions": [
    {
      "question_text": "面试官问的原始问题",
      "round_type": "hr / department / final",
      "category": "behavioral / technical / case / motivation",
      "difficulty": 3
    }
  ]
}

--- 面经原文 ---
公司：${company}
岗位：${role}

${rawText}
`;

const ANSWER_PROMPT = (question: string, category: string, difficulty: number, bullets: string): string => `你是一位校招面试辅导教练。
请根据求职者的个人经历，为以下面试问题生成推荐回答思路。

要求：
1. 使用 STAR 法则（Situation-Task-Action-Result）组织回答
2. 尽量引用求职者自身的真实经历（来自下方 Profile）
3. 如果 Profile 中没有直接相关经历，给出通用回答框架 + 提示求职者可以用什么经历
4. 控制在 300 字以内
5. 用中文回答

面试问题：${question}
问题类型：${category}
难度：${difficulty}/5

--- 求职者 Profile 要点 ---
${bullets}
`;

const questionsOf = (doc: StoredRecord): BankQuestion[] => (Array.isArray(doc.bank_questions) ? doc.bank_questions as BankQuestion[] : []);
export const questionId = (experienceId: number, index: number): number => experienceId * QUESTION_ID_STRIDE + index + 1;

async function experienceDoc(store: CoreStore, id: number): Promise<StoredRecord> {
  const doc = await store.get("doc", id);
  if (!doc || doc.kind !== "note" || doc.topic !== EXPERIENCE_TOPIC) throw new CoreError("面经记录不存在", "not_found");
  return doc;
}

export async function collectExperience(store: CoreStore, args: Args, actor?: string): Promise<Record<string, unknown>> {
  const company = stringField(args, "company", { min: 1, max: 300, required: true });
  const role = stringField(args, "role", { min: 1, max: 300, required: true });
  const rawText = stringField(args, "raw_text", { min: 10, required: true });
  const sourceUrl = args.source_url === undefined || args.source_url === null ? null : stringField(args, "source_url");
  const platform = stringField(args, "source_platform", { fallback: "manual" });
  const jobId = args.job_id === undefined || args.job_id === null ? null : optionalPositiveInt(args, "job_id");
  const ctx = userContext(actor);
  const { record } = await saveRecord(store, {
    type: "doc",
    data: {
      kind: "note",
      topic: EXPERIENCE_TOPIC,
      title: `面经 · ${company.trim()} · ${role.trim()}`,
      company: company.trim(),
      role: role.trim(),
      body: rawText,
      source_url: sourceUrl,
      source_platform: platform,
      job_id: jobId,
      collected_at: ctx.now,
      bank_questions: [],
    },
  }, ctx);
  return { id: record.id, company: record.company, role: record.role, source_platform: record.source_platform, collected_at: record.collected_at ?? record.created_at };
}

export async function listExperiences(store: CoreStore, args: Args): Promise<Array<Record<string, unknown>>> {
  let docs = await topicDocs(store, "note", EXPERIENCE_TOPIC);
  const company = typeof args.company === "string" ? args.company : "";
  if (company) docs = docs.filter((doc) => String(doc.company ?? "").includes(company));
  docs.sort((a, b) => String(b.collected_at ?? b.created_at).localeCompare(String(a.collected_at ?? a.created_at)) || b.id - a.id);
  return docs.map((doc) => ({
    id: doc.id,
    company: doc.company ?? "",
    role: doc.role ?? "",
    source_platform: doc.source_platform ?? "manual",
    source_url: doc.source_url ?? null,
    collected_at: doc.collected_at ?? doc.created_at ?? null,
    questions_count: questionsOf(doc).length,
  }));
}

export async function listBankQuestions(store: CoreStore, args: Args): Promise<Array<Record<string, unknown>>> {
  const company = typeof args.company === "string" ? args.company : "";
  const role = typeof args.role === "string" ? args.role : "";
  const category = typeof args.category === "string" ? args.category : "";
  const jobId = typeof args.job_id === "number" ? args.job_id : null;
  const rows: Array<Record<string, unknown> & { id: number; frequency: number }> = [];
  for (const doc of await topicDocs(store, "note", EXPERIENCE_TOPIC)) {
    if (company && !String(doc.company ?? "").includes(company)) continue;
    if (role && !String(doc.role ?? "").includes(role)) continue;
    questionsOf(doc).forEach((question, index) => {
      if (jobId !== null && doc.job_id !== jobId) return;
      if (category && question.category !== category) return;
      rows.push({
        id: questionId(doc.id, index),
        experience_id: doc.id,
        question_text: question.question_text,
        round_type: question.round_type,
        category: question.category,
        difficulty: question.difficulty,
        frequency: question.frequency ?? 1,
        suggested_answer: question.suggested_answer ?? null,
        job_id: doc.job_id ?? null,
        created_at: question.created_at ?? doc.created_at ?? null,
      });
    });
  }
  return rows.sort((a, b) => b.frequency - a.frequency || b.id - a.id);
}

const asInt = (value: unknown, fallback: number): number => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
};

export async function extractExperienceQuestions(store: CoreStore, args: Args, llm: LlmClient | null | undefined, actor?: string): Promise<Record<string, unknown>> {
  const id = args.experience_id;
  if (typeof id !== "number" || !Number.isInteger(id)) throw new CoreError("experience_id 要是整数");
  const doc = await experienceDoc(store, id);
  const client = requireLlm(llm, NO_MODEL_HINT);
  let rawText = [...String(doc.body ?? "")].slice(0, 6000).join("");
  let mapping: Record<string, string> = {};
  if (!client.local) [rawText, mapping] = desensitize(rawText);
  const raw = await client.chat([{ role: "user", content: EXTRACT_PROMPT(String(doc.company ?? ""), String(doc.role ?? ""), rawText) }], {
    json: true, tier: "standard", temperature: 0.2,
  });
  const result = raw ? extractJson(Object.keys(mapping).length ? restore(raw, mapping) : raw) : null;
  if (!result || !("questions" in result)) throw new CoreError("LLM 提炼失败，请稍后重试");
  const ctx = userContext(actor);
  const added: BankQuestion[] = (Array.isArray(result.questions) ? result.questions : []).filter(isObject).map((item) => ({
    question_text: String(item.question_text ?? ""),
    round_type: String(item.round_type ?? "department"),
    category: String(item.category ?? "behavioral"),
    difficulty: asInt(item.difficulty, 3),
    frequency: 1,
    suggested_answer: null,
    created_at: ctx.now,
  }));
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  const before = questionsOf(doc);
  const data: Record<string, unknown> = { bank_questions: [...before, ...added] };
  if (rounds.length) data.interview_rounds = JSON.stringify(rounds);
  await saveRecord(store, { type: "doc", id, data }, ctx);
  return {
    experience_id: id,
    rounds,
    questions_count: added.length,
    questions: added.map((question, offset) => ({
      id: questionId(id, before.length + offset),
      question_text: question.question_text,
      round_type: question.round_type,
      category: question.category,
      difficulty: question.difficulty,
    })),
  };
}

export async function generateBankAnswer(store: CoreStore, args: Args, llm: LlmClient | null | undefined, actor?: string): Promise<Record<string, unknown>> {
  const qid = args.question_id;
  if (typeof qid !== "number" || !Number.isInteger(qid) || qid <= QUESTION_ID_STRIDE) throw new CoreError("题目不存在", "not_found");
  const experienceId = Math.floor(qid / QUESTION_ID_STRIDE);
  const index = (qid % QUESTION_ID_STRIDE) - 1;
  const doc = await store.get("doc", experienceId);
  const questions = doc && doc.kind === "note" && doc.topic === EXPERIENCE_TOPIC ? questionsOf(doc) : [];
  const question = index >= 0 ? questions[index] : undefined;
  if (!doc || !question) throw new CoreError("题目不存在", "not_found");
  if (!(await store.first("profile"))) throw new CoreError("请先创建个人档案");
  const bullets = (await store.all("memory"))
    .map((memory) => ({ kind: String(memory.kind ?? "note"), text: String(memory.body || memory.title || "").trim() }))
    .filter((item) => item.text)
    .map((item) => `- [${item.kind}] ${item.text}`)
    .join("\n");
  if (!bullets) throw new CoreError("Profile 内容为空，请先填写个人经历");
  const answer = await requireLlm(llm, NO_MODEL_HINT).chat([{
    role: "user",
    content: ANSWER_PROMPT(question.question_text, question.category, question.difficulty, [...bullets].slice(0, 4000).join("")),
  }], { tier: "premium", temperature: 0.5, maxTokens: 1024 });
  if (!answer) throw new CoreError("LLM 生成失败，请稍后重试");
  const updated = questions.map((item, position) => (position === index ? { ...item, suggested_answer: answer } : item));
  await saveRecord(store, { type: "doc", id: experienceId, data: { bank_questions: updated } }, userContext(actor));
  return { question_id: qid, question_text: question.question_text, suggested_answer: answer };
}


