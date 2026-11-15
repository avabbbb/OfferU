// Evaluate jobs one by one with progress events: start → job_start / job … → done.
// Port of Python app/core/tools.py evaluate_stream / evaluate_jobs / _targets.
// Each job's evaluation doc + job score are written in one transaction.

import type { LlmClient } from "../llm";
import { label } from "../labels";
import { saveRecord } from "../operations";
import type { CoreContext, CoreStore, StoredRecord } from "../types";
import { CoreError } from "../types";
import { candidateText, evaluateJob, type JobEvaluation } from "./job-eval";
import { truthy } from "./py";

export type EvaluateItem = { id: number; label: string; score: number; reasons: string[]; greeting: string; doc_id: number };

export type EvaluateEvent =
  | { type: "start"; total: number }
  | { type: "job_start"; id: number; label: string; index: number; total: number }
  | ({ type: "job"; index: number; total: number } & EvaluateItem)
  | { type: "done"; count: number; change_ids: number[]; items: EvaluateItem[]; failed: string[]; remaining: number };

export type EvaluateOptions = {
  ids?: unknown;
  redo?: boolean;
  /** Max jobs this call; undefined = all (the web stream). */
  limit?: number;
  signal?: AbortSignal;
  /**
   * Optional pre-step: split job.posting for jobs that have none (Python enrich_jobs,
   * owned by job intake). Best effort: failures are ignored. Returns change ids.
   */
  enrich?: (ids: number[], signal?: AbortSignal) => Promise<Array<number | null>>;
  /** Fresh context per write (a stream can run for minutes). */
  context: () => CoreContext;
};

export const NO_MODEL_MESSAGE = "没配模型，没法自动评估。你自己评就用 save 给 job 写 score（0–100）和 reasons（三句）";

const hasJd = (job: StoredRecord): boolean => String(job.jd ?? "").trim() !== "";

/** Pick the jobs to evaluate and validate them up front (ids exist, JD present). */
export async function evaluationTargets(store: CoreStore, ids: unknown, redo: boolean): Promise<StoredRecord[]> {
  if (Array.isArray(ids) && ids.length) {
    const jobs: StoredRecord[] = [];
    for (const raw of ids) {
      const id = typeof raw === "number" ? Math.trunc(raw) : typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(id)) throw new CoreError("ids 要是岗位 id 的数组");
      const job = await store.get("job", id);
      if (!job) throw new CoreError(`岗位 #${id} 不存在`, "not_found");
      if (!hasJd(job)) throw new CoreError(`「${label(job)}」还没有 JD，先贴 JD 再评估`);
      jobs.push(job);
    }
    return jobs;
  }
  if (ids !== undefined && ids !== null && !Array.isArray(ids)) throw new CoreError("ids 要是岗位 id 的数组");
  return (await store.all("job")).filter((job) =>
    job.status !== "rejected" && job.status !== "closed" && hasJd(job) && (redo || job.score === undefined || job.score === null));
}

export type PreparedEvaluation = { jobs: StoredRecord[]; remaining: number };

/**
 * Everything that can fail before the first event: model configured, targets valid.
 * Transports call this first so a bad request is a plain 4xx instead of a broken stream.
 */
export async function prepareEvaluation(store: CoreStore, llm: LlmClient | null | undefined, options: Pick<EvaluateOptions, "ids" | "redo" | "limit">): Promise<PreparedEvaluation> {
  if (!llm) throw new CoreError(NO_MODEL_MESSAGE);
  const eligible = await evaluationTargets(store, options.ids, Boolean(options.redo));
  const limit = options.limit;
  return {
    remaining: limit ? Math.max(0, eligible.length - limit) : 0,
    jobs: limit ? eligible.slice(0, limit) : eligible,
  };
}

async function existingEvaluationDoc(store: CoreStore, jobId: number): Promise<StoredRecord | undefined> {
  return (await store.all("doc", jobId)).find((doc) => doc.kind === "evaluation");
}

async function persist(store: CoreStore, job: StoredRecord, result: JobEvaluation, ctx: CoreContext): Promise<{ docId: number; changeIds: number[] }> {
  return store.transaction(async () => {
    const old = await existingEvaluationDoc(store, job.id);
    const doc = await saveRecord(store, {
      type: "doc",
      id: old?.id,
      data: { kind: "evaluation", job_id: job.id, title: `岗位评估 · ${label(job)}`, body: result.markdown },
    }, ctx);
    const scored = await saveRecord(store, {
      type: "job",
      id: job.id,
      data: { score: result.score, reasons: result.reasons, ...(result.greeting ? { greeting: result.greeting } : {}) },
    }, ctx);
    return { docId: doc.record.id, changeIds: [doc.change_id, scored.change_id].filter((id): id is number => id !== null) };
  });
}

/** Run a prepared evaluation. Throws CoreError when no job got a usable evaluation (nothing written). */
export async function* runEvaluation(
  store: CoreStore,
  llm: LlmClient,
  prepared: PreparedEvaluation,
  options: Pick<EvaluateOptions, "signal" | "enrich" | "context">,
): AsyncGenerator<EvaluateEvent> {
  let jobs = prepared.jobs;
  const { remaining } = prepared;
  if (!jobs.length) {
    yield { type: "done", count: 0, change_ids: [], items: [], failed: [], remaining };
    return;
  }
  const profileText = candidateText(await store.first("profile"), await store.all("memory"));
  const total = jobs.length;
  const changeIds: number[] = [];
  const items: EvaluateItem[] = [];
  const failed: string[] = [];
  yield { type: "start", total };

  const bare = jobs.filter((job) => !truthy(job.posting)).map((job) => job.id);
  if (bare.length && options.enrich) {
    try {
      changeIds.push(...(await options.enrich(bare, options.signal)).filter((id): id is number => typeof id === "number" && id > 0));
      jobs = await Promise.all(jobs.map(async (job) => (await store.get("job", job.id)) ?? job));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Splitting the posting is best effort; evaluation runs anyway.
    }
  }

  for (const [offset, job] of jobs.entries()) {
    const index = offset + 1;
    options.signal?.throwIfAborted();
    yield { type: "job_start", id: job.id, label: label(job), index, total };
    const result = await evaluateJob(llm, profileText, job, options.signal);
    if (!result) {
      failed.push(label(job));
      continue;
    }
    const { docId, changeIds: written } = await persist(store, job, result, options.context());
    changeIds.push(...written);
    const item: EvaluateItem = {
      id: job.id, label: label(job), score: result.score, reasons: result.reasons, greeting: result.greeting || "", doc_id: docId,
    };
    items.push(item);
    yield { type: "job", index, total, ...item };
  }
  if (!items.length) throw new CoreError(`模型没返回可用的评估，岗位没动：${failed.join("、")}`);
  items.sort((a, b) => b.score - a.score);
  yield { type: "done", count: items.length, change_ids: changeIds, items, failed, remaining };
}

/** prepareEvaluation + runEvaluation. */
export async function* evaluateStream(store: CoreStore, llm: LlmClient | null | undefined, options: EvaluateOptions): AsyncGenerator<EvaluateEvent> {
  const prepared = await prepareEvaluation(store, llm, options);
  yield* runEvaluation(store, llm!, prepared, options);
}

/**
 * Tool form (evaluate_jobs): at most `limit` jobs per call (default 3, 1–20);
 * call again while `remaining` > 0.
 */
export async function evaluateJobs(
  store: CoreStore,
  llm: LlmClient | null | undefined,
  args: Record<string, unknown>,
  options: Pick<EvaluateOptions, "signal" | "enrich" | "context">,
): Promise<Omit<Extract<EvaluateEvent, { type: "done" }>, "type">> {
  const limit = args.limit === undefined || args.limit === null ? 3 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new CoreError("limit 要是 1–20 的整数");
  for await (const event of evaluateStream(store, llm, { ...options, ids: args.ids, redo: args.redo === true, limit })) {
    if (event.type === "done") {
      const { type: _type, ...rest } = event;
      return rest;
    }
  }
  throw new CoreError("评估没完成");
}
