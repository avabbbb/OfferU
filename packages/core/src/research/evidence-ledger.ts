// Job Evidence Ledger: the data contract between a job's requirements, the
// user's career evidence and the claims in a tailored resume. Built on demand
// from what OfferU already stores (job + job.posting, the evaluate_jobs
// evaluation doc's 「逐条匹配」, memories, the job's resume doc) — nothing new
// is persisted, so there is no schema change.
//
// validateTailoredResume turns docs/DOGFOOD.md 2026-11-09 into checks: a
// tailored resume must not add claims without confirmed evidence, must not
// drop what the user confirmed, must not present a model's own scores as the
// user's achievements, and must notice when the JD changed since the ledger
// was built. It reuses resume/verify.ts number tracing (no second matcher).

import { canonicalJsonDigest } from "../agent/run-state";
import { knownNumbers, omittedMemories, plainNumbers, retainedFacts } from "../resume/verify";
import type { CoreStore, StoredRecord } from "../types";
import { sourceFact } from "./job-eval";

export type RequirementSource = "jd_official" | "jd_community" | "evaluation";

export interface LedgerRequirement {
  requirementId: string;
  text: string;
  sourceUrl?: string;
  sourceType: RequirementSource;
  /** memory ids that back this requirement. */
  evidenceIds: number[];
  /** 「弱 / 无」 from the evaluation, or no evidence found. */
  gap?: string;
}

export interface LedgerClaim {
  claim: string;
  evidenceIds: number[];
  /** Every backing memory is confirmed by the user. */
  confirmed: boolean;
}

export interface JobEvidenceLedger {
  jobId: number;
  /** sha256 of the JD text the ledger was built from (JD-change detection). */
  jdDigest: string;
  /** The JD was edited after the evaluation these requirements come from. */
  evaluationStale: boolean;
  requirements: LedgerRequirement[];
  resumeClaims: LedgerClaim[];
  pendingQuestions: string[];
}

export type LedgerIssueCode = "unconfirmed_claim" | "confirmed_dropped" | "self_score_as_achievement" | "jd_changed";

export interface LedgerIssue {
  code: LedgerIssueCode;
  detail: string;
  line?: string;
  memoryId?: number;
}

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const LEVEL = /→\s*(强|中|弱|无)/u;
const LIST = /^\s*(?:[-*•]|\d+[.、)])\s*/u;

function bullets(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.replace(/^#+\s*/u, "").trim() === heading && /^#{2,}\s/u.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    if (LIST.test(line)) out.push(line.replace(LIST, "").trim());
  }
  return out;
}

/** Memories a line points at: `#12` references or a memory title (≥ 2 chars) written in it. */
function evidenceIn(line: string, memories: StoredRecord[]): number[] {
  const ids = new Set<number>();
  for (const match of line.matchAll(/#(\d+)/gu)) {
    const id = Number(match[1]);
    if (memories.some((memory) => memory.id === id)) ids.add(id);
  }
  for (const memory of memories) {
    const title = str(memory.title).trim();
    if ([...title].length >= 2 && line.includes(title)) ids.add(memory.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** A resume line is backed by a memory when it names it or carries one of its numbers. */
function claimEvidence(line: string, memories: StoredRecord[]): number[] {
  const ids = new Set(evidenceIn(line, memories));
  const numbers = [...(plainNumbers(line).match(/\p{Nd}+(?:\.\p{Nd}+)?/gu) ?? [])].filter((value) => value.length >= 2 || value.includes("."));
  if (numbers.length) {
    for (const memory of memories) {
      const known = knownNumbers([str(memory.body), str(memory.quote), str(memory.title)].join("\n"));
      if (numbers.some((value) => known.has(value))) ids.add(memory.id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function resumeLines(body: string): string[] {
  return body.split(/\r?\n/u).filter((line) => LIST.test(line)).map((line) => line.replace(LIST, "").trim()).filter(Boolean);
}

/** Did a change to this job's JD land after `since` (change log; nothing new stored)? */
async function jdEditedAfter(store: CoreStore, jobId: number, since: string): Promise<boolean> {
  if (!since) return false;
  const rows = await store.changes(500);
  return rows.some((row) => row.type === "job" && row.record_id === jobId && !row.undone_at && row.at > since
    && row.before !== null && row.after !== null && str(row.before.jd) !== str(row.after.jd));
}

const confirmedMemory = (memory: StoredRecord) => memory.confirmed !== false && memory.kind !== "preference";

export async function jdDigest(job: StoredRecord): Promise<string> {
  return canonicalJsonDigest(str(job.jd).replace(/\s+/gu, " ").trim());
}

/** Build the ledger for one job from the stored job, its evaluation and resume docs, and memories. */
export async function buildJobEvidenceLedger(store: CoreStore, jobId: number): Promise<JobEvidenceLedger | null> {
  const job = await store.get("job", jobId);
  if (!job) return null;
  const memories = (await store.all("memory")).filter((memory) => memory.kind !== "preference");
  const docs = await store.all("doc", jobId);
  const evaluation = docs.filter((doc) => doc.kind === "evaluation").sort((a, b) => b.id - a.id)[0];
  const resume = docs.filter((doc) => doc.kind === "resume").sort((a, b) => b.id - a.id)[0];
  const [label] = sourceFact(job);
  const sourceUrl = str(job.url) || undefined;

  const requirements: LedgerRequirement[] = [];
  const matched = evaluation ? bullets(str(evaluation.body), "逐条匹配") : [];
  if (matched.length) {
    matched.forEach((line, index) => {
      const level = LEVEL.exec(line)?.[1];
      const text = line.split("→")[0].replace(/\[[^\]]*\]/gu, "").trim();
      const evidenceIds = evidenceIn(line, memories);
      requirements.push({
        requirementId: `r${index + 1}`,
        text,
        ...(sourceUrl ? { sourceUrl } : {}),
        sourceType: "evaluation",
        evidenceIds,
        ...(level === "弱" || level === "无" ? { gap: level } : !evidenceIds.length && level !== "强" && level !== "中" ? { gap: "无证据" } : {}),
      });
    });
  } else {
    const posting = (job.posting && typeof job.posting === "object" ? job.posting : {}) as Record<string, unknown>;
    const items = ["hard_reqs", "soft_reqs", "responsibilities"].flatMap((key) => (Array.isArray(posting[key]) ? (posting[key] as unknown[]).map(str) : []));
    items.filter((item) => item.trim()).forEach((text, index) => {
      const evidenceIds = evidenceIn(text, memories);
      requirements.push({
        requirementId: `r${index + 1}`,
        text,
        ...(sourceUrl ? { sourceUrl } : {}),
        sourceType: label === "official" ? "jd_official" : "jd_community",
        evidenceIds,
        ...(evidenceIds.length ? {} : { gap: "无证据" }),
      });
    });
  }

  const resumeClaims: LedgerClaim[] = resume ? resumeLines(str(resume.body)).map((claim) => {
    const evidenceIds = claimEvidence(claim, memories);
    const backing = memories.filter((memory) => evidenceIds.includes(memory.id));
    return { claim, evidenceIds, confirmed: backing.length > 0 && backing.every(confirmedMemory) };
  }) : [];

  const pendingQuestions = [
    ...requirements.filter((req) => req.gap === "无").map((req) => `JD 要求「${req.text}」：档案里没找到对应经历，你做过相关的事吗？`),
    ...resumeClaims.filter((claim) => !claim.evidenceIds.length && /\p{Nd}/u.test(claim.claim)).map((claim) => `简历里「${claim.claim.slice(0, 40)}」的数字找不到出处，是真实经历吗？`),
    ...memories.filter((memory) => memory.confirmed === false && resumeClaims.some((claim) => claim.evidenceIds.includes(memory.id)))
      .map((memory) => `记忆 #${memory.id}「${str(memory.title)}」还没确认，确认后才能写进简历。`),
  ];
  const evaluationStale = Boolean(evaluation) && await jdEditedAfter(store, jobId, str(evaluation.updated_at || evaluation.created_at));
  if (evaluationStale) pendingQuestions.unshift("JD 在评估之后改过：先重新 evaluate_jobs，再按新的要求对照证据。");
  return { jobId, jdDigest: await jdDigest(job), evaluationStale, requirements, resumeClaims, pendingQuestions };
}

/** Model-produced scores phrased as achievements (DOGFOOD 2026-11-09: 综合分 5.8→6.4 写成成果). */
const SELF_SCORE = /(评估|匹配|综合|自评|模型|面试官)\s*(分|得分|评分|分数)|匹配度|score\b|评分\s*(从|由)?\s*\p{Nd}/iu;

/**
 * Check a tailored resume (`after`) against the ledger built before tailoring
 * and the resume it replaced (`before`). Issues are advisory: the caller shows
 * them; nothing is blocked here.
 */
export async function validateTailoredResume(input: {
  ledger: JobEvidenceLedger;
  job: StoredRecord;
  before: string;
  after: string;
  memories: StoredRecord[];
}): Promise<LedgerIssue[]> {
  const issues: LedgerIssue[] = [];
  if (input.ledger.evaluationStale || await jdDigest(input.job) !== input.ledger.jdDigest) {
    issues.push({ code: "jd_changed", detail: "岗位 JD 在建账之后改过，证据对照可能过期：先重新 evaluate_jobs 再定制。" });
  }
  const evidence = input.memories.filter((memory) => memory.kind !== "preference");
  const confirmed = evidence.filter(confirmedMemory);
  const beforeLines = new Set(resumeLines(input.before));
  for (const line of resumeLines(input.after)) {
    if (SELF_SCORE.test(line)) {
      issues.push({ code: "self_score_as_achievement", detail: "评估分 / 匹配度是模型的产出，不是用户的成果，不要写进简历。", line });
      continue;
    }
    if (beforeLines.has(line)) continue;
    const backing = claimEvidence(line, evidence);
    const numbers = plainNumbers(line).match(/\p{Nd}+(?:\.\p{Nd}+)?/gu) ?? [];
    const unconfirmed = backing.filter((id) => !confirmed.some((memory) => memory.id === id));
    if (unconfirmed.length && !backing.some((id) => confirmed.some((memory) => memory.id === id))) {
      issues.push({ code: "unconfirmed_claim", detail: `新写的这句只能追到还没确认的记忆 ${unconfirmed.map((id) => `#${id}`).join(" ")}，先请用户确认。`, line, memoryId: unconfirmed[0] });
    } else if (!backing.length && numbers.some((value) => value.length >= 2 || value.includes("."))) {
      issues.push({ code: "unconfirmed_claim", detail: "新写的这句里的数字在档案和已确认记忆里找不到出处。", line });
    }
  }
  // Confirmed evidence the old resume carried and the new one lost (title or numbers).
  const named = confirmed.filter((memory) => !omittedMemories(input.before, [memory]).length);
  for (const title of omittedMemories(input.after, named)) {
    const memory = named.find((item) => str(item.title).trim() === title);
    issues.push({ code: "confirmed_dropped", detail: `用户确认过的「${title}」在新简历里整条没了。`, memoryId: memory?.id });
  }
  const droppedBefore = new Set(retainedFacts(input.before, named).flatMap((item) => item.missing.map((miss) => `${item.memory_id}:${miss}`)));
  for (const item of retainedFacts(input.after, named)) {
    const lost = item.missing.filter((miss) => !droppedBefore.has(`${item.memory_id}:${miss}`));
    if (lost.length) issues.push({ code: "confirmed_dropped", detail: `「${item.title}」丢了确认过的事实：${lost.join("、")}`, memoryId: Number(item.memory_id) || undefined });
  }
  return issues;
}
