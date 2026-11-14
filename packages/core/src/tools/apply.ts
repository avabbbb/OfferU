// apply_answer / draft_email / reconcile_memory / split_resume, ported from backend/app/core/tools.py.

import { label } from "../labels";
import { saveRecord } from "../operations";
import { CoreError, type Json, type StoredRecord } from "../types";
import type { ToolDeps } from "./deps";
import { candidateText as candidate, jobText } from "../research/job-eval";
import { pyStr } from "../research/py";
import { reconcileScan, type Finding } from "./reconcile";
import { extractResumeItems } from "./resume-split";

const truthy = (value: unknown) => value !== null && value !== undefined && value !== "" && value !== false && value !== 0
  && !(Array.isArray(value) && !value.length);
const text = (value: unknown) => (truthy(value) ? pyStr(value) : "");

// ---------- apply_answer ----------

export const APPLY_PROMPT = `你在帮候选人填招聘官网的网申问题。只用给出的档案、职业记忆、岗位 JD 和这个岗位的定制简历里的事实作答，不编造经历和数字。
要求：直接给能粘贴进表单的回答，第一人称；题目有字数限制就遵守，没有就控制在 300 字内；资料里没有的信息写「（待补充：…）」提醒候选人。
之前答过的题要和这次口径一致，不重复同一个例子。`;

/** 按 JD 和这个岗位的定制简历回答官网网申问题，问答追加到岗位下的 apply_chat 文档。 */
export async function applyAnswer(deps: ToolDeps, jobId: number, rawQuestion: string): Promise<Json> {
  const { store, ctx } = deps;
  const job = await store.get("job", jobId);
  if (!job) throw new CoreError(`岗位 #${jobId} 不存在`, "not_found");
  const question = rawQuestion.trim();
  if (!question) throw new CoreError("问题是空的");
  if (!deps.llm) throw new CoreError("没配模型，没法自动回答。你自己写好就用 save 存成 kind=apply_chat 的文档", "unsupported");
  const docs = await store.all("doc", job.id);
  const resume = [...docs].sort((a, b) => b.id - a.id).find((doc) => doc.kind === "resume");
  const chat = docs.find((doc) => doc.kind === "apply_chat");
  let resumeText = "";
  if (resume) resumeText = text(resume.body) || JSON.stringify(resume.resume ?? {});
  const context = candidate(await store.first("profile"), await store.all("memory"))
    + "\n\n岗位：\n" + jobText(job)
    + "\n\n定制简历：\n" + (resumeText.slice(0, 6000) || "（这个岗位还没有定制简历）");
  const history = text(chat?.body);
  const user = context + (history ? "\n\n之前答过的题：\n" + history.slice(-4000) : "") + "\n\n现在要回答：\n" + question;
  const reply = String(await deps.llm.chat([{ role: "system", content: APPLY_PROMPT }, { role: "user", content: user }], { temperature: 0.4, maxTokens: 1500 }) ?? "").trim();
  if (!reply) throw new CoreError("模型没返回回答，什么都没存");
  const entry = `### 问：${question}\n\n${reply}\n`;
  const body = history.trim() ? `${history.trimEnd()}\n\n${entry}` : entry;
  const saved = await saveRecord(store, {
    type: "doc",
    id: chat?.id,
    data: { kind: "apply_chat", job_id: job.id, title: `官网投递对话 · ${label(job)}`, body },
  }, ctx);
  return { answer: reply, doc_id: saved.record.id, change_id: saved.change_id, used_resume: resume ? resume.id : null };
}

// ---------- draft_email ----------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MAIL_RULE_RE = /邮件|主题|标题|附件|命名|PDF|pdf/;
const SUBJECT_FORMAT_RE = /(?:邮件)?(?:标题|主题)(?:格式)?(?:请)?(?:注明|命名为|写成|统一为|为|是|按)?\s*[：:]?\s*[「“"'【]?([^，,。；;\n」”"'】]+)/g;
const SUBJECT_SEP_RE = /(\s*[-_—–+＋|｜]\s*)/;
const ATTACH_FORMAT_RE = /(?:附件|简历)[^。；;\n]{0,12}?命名(?:为|格式为?)?\s*[：:]?\s*[「“"'【]([^」”"'】\n]+)/g;

type Getter = (profile: Json, job: Json) => unknown;
const SUBJECT_FIELDS: Array<[string[], Getter]> = [
  [["姓名", "名字"], (p) => p.name],
  [["学校", "院校", "毕业院校"], (p) => p.school],
  [["专业"], (p) => p.major],
  [["学历"], (p) => p.degree],
  [["岗位", "职位", "应聘岗位", "应聘职位", "岗位名称", "意向岗位"], (_, j) => j.title],
  [["届别", "年级", "毕业年份", "毕业时间", "届"], (p) => (truthy(p.grad_year) ? `${pyStr(p.grad_year)}届` : null)],
  [["电话", "手机", "手机号", "联系方式"], (p) => p.phone],
  [["城市", "实习城市", "意向城市", "工作城市"], (_, j) => j.city],
];

/** 把「姓名-学校-岗位」这类分段格式按档案和岗位逐段填；没有的段留 [段名] 占位。不是分段格式返回 null。 */
function fillFormat(format: string, profile: Json, job: Json): [string, string[]] | null {
  const pieces = format.trim().split(SUBJECT_SEP_RE);
  if (pieces.length < 3) return null;
  const out: string[] = [];
  const todo: string[] = [];
  pieces.forEach((piece, index) => {
    if (index % 2) {
      out.push(piece.trim());
      return;
    }
    const token = piece.trim();
    const hit = SUBJECT_FIELDS.find(([names]) => names.includes(token));
    let value = hit ? hit[1](profile, job) : null;
    if (!truthy(value)) value = profile[token];
    if (truthy(value)) out.push(pyStr(value));
    else if (token) {
      out.push(`[${token}]`);
      todo.push(token);
    }
  });
  return [out.join(""), todo];
}

/** 按 JD 写的标题格式逐段填；JD 没给格式就用「姓名-学校-岗位」。返回 [标题, 待补字段]。 */
export function mailSubject(source: string, profile: Json, job: Json): [string, string[]] {
  const title = text(job.title) || "岗位";
  const parts = [profile.name, profile.school, title].filter(truthy).map(pyStr);
  const fallback = parts.join("-") || `应聘${title}`;
  for (const match of source.matchAll(SUBJECT_FORMAT_RE)) {
    const filled = fillFormat(match[1], profile, job);
    if (filled) return filled;
  }
  return [fallback, []];
}

/** JD 要求的附件文件名（不含扩展名）；JD 没写返回 ["", []]。 */
export function attachmentName(source: string, profile: Json, job: Json): [string, string[]] {
  for (const match of source.matchAll(ATTACH_FORMAT_RE)) {
    const filled = fillFormat(match[1], profile, job);
    if (filled) return filled;
  }
  return ["", []];
}

/** 从 JD 拆出投递邮箱和邮件要求，写好标题正文、导出简历 PDF（有导出能力时），存成岗位下的 email 文档。不发送。 */
export async function draftEmail(deps: ToolDeps, jobId: number, resumeId?: number | null): Promise<Json> {
  const { store, ctx } = deps;
  const job = await store.get("job", jobId);
  if (!job) throw new CoreError(`岗位 #${jobId} 不存在`, "not_found");
  const source = ["jd", "notes"].map((key) => text(job[key])).join("\n");
  const emails = [...new Set(source.match(EMAIL_RE) ?? [])];
  if (!emails.length) throw new CoreError("JD 和备注里没找到投递邮箱，先把邮箱贴进备注");
  const rules = source.split(/[\n。；;]/).map((line) => line.trim()).filter((line) => line && MAIL_RULE_RE.test(line)).slice(0, 5);
  const profile: Json = (await store.first("profile")) ?? {};
  const name = text(profile.name);
  const title = text(job.title) || "岗位";
  const [subject, subjectTodo] = mailSubject(source, profile, job);
  const docs = [...await store.all("doc")].sort((a, b) => b.id - a.id);
  let resume: StoredRecord | undefined;
  if (resumeId !== undefined && resumeId !== null) {
    const picked = await store.get("doc", resumeId);
    if (!picked || picked.kind !== "resume") throw new CoreError(`简历 #${resumeId} 不存在`, "not_found");
    resume = picked;
  } else {
    resume = docs.find((doc) => doc.kind === "resume" && doc.job_id === job.id)
      ?? [...docs].reverse().find((doc) => doc.kind === "resume" && !doc.job_id);
  }
  let attachment: string | null = null;
  let attachError: string | null = null;
  const [attachStem, attachTodo] = attachmentName(source, profile, job);
  if (resume) {
    try {
      if (!deps.exportResumePdf) throw new Error("这个运行环境不能导出 PDF");
      // JD 指定了命名就按它；有占位段就用默认名并列进待补。
      attachment = (await deps.exportResumePdf(resume.id, attachTodo.length ? "" : attachStem)).path;
    } catch (cause) {
      attachError = `简历 PDF 没导出来：${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  const intro = ["school", "major", "degree"].map((key) => text(profile[key])).join("");
  const sign = [name, profile.phone, profile.email].filter(truthy).map(pyStr).join("\n");
  const body = (`您好：\n\n我是${name || "（姓名）"}${intro ? "，" + intro : ""}，想应聘贵司「${title}」岗位，简历见附件。\n\n`
    + `期待您的回复，谢谢！\n\n${sign}`).trimEnd();
  const existing = docs.find((doc) => doc.kind === "email" && doc.job_id === job.id);
  const saved = await saveRecord(store, {
    type: "doc",
    id: existing?.id,
    data: {
      kind: "email", job_id: job.id, title: `投递邮件 · ${label(job)}`, to: emails[0],
      subject, body, attachment, rules: rules.length ? rules : null,
    },
  }, ctx);
  return {
    to: emails[0], cc: emails.slice(1), subject, body, attachment, attach_error: attachError,
    subject_todo: subjectTodo.length ? subjectTodo : null, attach_todo: attachTodo.length ? attachTodo : null,
    rules, doc_id: saved.record.id, change_id: saved.change_id,
  };
}

// ---------- reconcile_memory ----------

/** 只出建议不写库。 */
export async function reconcileMemory(deps: ToolDeps): Promise<{ items: Finding[] }> {
  return { items: await reconcileScan(deps.store, deps.ctx.today) };
}

// ---------- split_resume ----------

/** 把旧简历原文（或本机文件）拆成一条条 memory 直接存进档案，每条一条可撤销的改动。 */
export async function splitResume(deps: ToolDeps, rawText?: string | null, path?: string | null): Promise<Json> {
  let source = rawText ?? "";
  if (!source.trim() && path) {
    if (!deps.readFile) throw new CoreError("这个运行环境读不了本机文件：把简历原文贴进来（text）", "unsupported");
    source = (await deps.readFile(path)).text;
  }
  if (!source.trim()) throw new CoreError("要给简历原文 text 或文件 path");
  if (!deps.llm) throw new CoreError("没配模型，也没开「没配模型时交给本机 Agent」，没法自动拆", "unsupported");
  const items = await extractResumeItems(deps.llm, source);
  if (!items.length) throw new CoreError("没从原文里拆出经历，档案没动");
  const saved = [];
  for (const item of items) saved.push(await saveRecord(deps.store, { type: "memory", data: item }, deps.ctx, { fromResume: true }));
  return {
    count: saved.length,
    change_ids: saved.map((s) => s.change_id),
    items: saved.map((s) => ({ id: s.record.id, kind: s.record.kind ?? null, title: s.record.title ?? null })),
  };
}
