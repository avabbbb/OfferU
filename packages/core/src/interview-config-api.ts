// Request → core dispatch for the interview / config / consent / connections
// endpoints. Pure TS (no Hono, no node:*): the companion's Hono routes and the
// browser transport (static web app, no backend) both call `handleInterviewConfigApi`,
// so paths, validation and response shapes are defined once and match Python.

import { CoreError, type CoreStore } from "./types";
import type { LlmClient } from "./llm";
import {
  checkAudioUpload,
  collectExperience,
  createInterview,
  deleteInterview,
  deleteReview,
  extractExperienceQuestions,
  extractReviewQuestions,
  generateBankAnswer,
  getInterview,
  getReview,
  getScoringSkill,
  getWeakSpots,
  groupWeakSpots,
  ingestBehaviorEvents,
  interviewRuntime,
  listBankQuestions,
  listExperiences,
  listInterviews,
  listReviews,
  listScoringSkills,
  markReviewJobRejected,
  restartInterview,
  saveReview,
  submitAnswer,
  transcribeReviewAudio,
} from "./interview";
import {
  agreePlatformConsent,
  fetchModelsForConfig,
  getConfigView,
  importProviderKey,
  platformConsentStatus,
  revokePlatformConsent,
  testActiveLlm,
  updateConfig,
  type SettingsHost,
} from "./settings";

export type ApiRequest = {
  method: string;
  /** Path without query, e.g. /api/interviews/3/messages */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body ({} when empty). */
  body: unknown;
  /** Multipart upload (POST /api/interviews/reviews/transcribe). */
  file?: { blob: Blob; name: string } | null;
};

export type ApiDeps = {
  store: CoreStore;
  /** Model built from the saved config per call; null = none configured. */
  llm: () => LlmClient | null;
  settings: SettingsHost | null;
  actor: string;
};

/** Path prefixes this module owns (for hosts that mount it). */
export const INTERVIEW_CONFIG_PREFIXES = ["/api/interviews", "/api/interview", "/api/config", "/api/consent", "/api/connections"] as const;

export const NOT_MIGRATED_DEBRIEF = "面试复盘问答依赖旧的自动化任务链（Career Director），新后端不再提供；请用「面试复盘」记录";
export const NOT_MIGRATED_FOCUS_PLAN = "岗位面试重点依赖旧的岗位情报（Role Intelligence），新后端不再提供";
export const NOT_MIGRATED_SKILLS = "自定义评分规则暂不支持，当前只有内置的证据评分规则";

const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoreError("请求体要是 JSON 对象");
  return value as Record<string, unknown>;
};

function intQuery(query: URLSearchParams, name: string, options: { min?: number; max?: number; fallback?: number | null } = {}): number | null {
  const raw = query.get(name);
  if (raw === null || raw === "") return options.fallback ?? null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CoreError(`${name} 要是整数`);
  if (options.min !== undefined && value < options.min) throw new CoreError(`${name} 不能小于 ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new CoreError(`${name} 不能大于 ${options.max}`);
  return value;
}

function strQuery(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  return raw === null ? undefined : raw;
}

/** Python routes/connections.py: the registered job sources (manual + web, both DB-backed). */
export function listConnections(): Record<string, unknown> {
  const source = (source_id: string, label: string, description: string) => ({
    source_id,
    label,
    description,
    experimental: false,
    status: "READY",
    connected: true,
    capabilities: ["job_discovery", "job_details"],
    last_sync: null,
  });
  return {
    ok: true,
    connections: [
      source("manual", "Manual", "Jobs you add by hand / URL"),
      source("web", "Web", "Existing captured & scraped jobs"),
    ],
  };
}

type Handler = (match: RegExpExecArray, request: ApiRequest, deps: ApiDeps) => Promise<unknown> | unknown;
type Route = [method: string, pattern: RegExp, handler: Handler];

const id = (match: RegExpExecArray, index = 1): number => Number(match[index]);

const ROUTES: Route[] = [
  // ---- /api/config (routes/config.py) ----
  ["GET", /^\/api\/config\/?$/, (_m, _r, d) => getConfigView(d.settings)],
  ["PUT", /^\/api\/config\/?$/, (_m, r, d) => updateConfig(d.settings, r.body)],
  ["POST", /^\/api\/config\/test-llm$/, (_m, _r, d) => testActiveLlm(d.settings)],
  ["POST", /^\/api\/config\/llm-providers\/import$/, (_m, r, d) => importProviderKey(d.settings, r.body)],
  ["POST", /^\/api\/config\/fetch-models$/, (_m, r, d) => fetchModelsForConfig(d.settings, r.body)],

  // ---- /api/consent (routes/consent.py) ----
  ["GET", /^\/api\/consent\/platform-collect$/, (_m, _r, d) => platformConsentStatus(d.settings)],
  ["POST", /^\/api\/consent\/platform-collect$/, (_m, r, d) => agreePlatformConsent(d.settings, r.body)],
  ["DELETE", /^\/api\/consent\/platform-collect$/, (_m, _r, d) => revokePlatformConsent(d.settings)],

  // ---- /api/connections (routes/connections.py) ----
  ["GET", /^\/api\/connections\/?$/, () => listConnections()],

  // ---- /api/interviews (routes/interviews.py) ----
  ["GET", /^\/api\/interviews\/runtime$/, (_m, _r, d) => interviewRuntime(d.llm())],
  ["GET", /^\/api\/interviews\/scoring-skills$/, (_m, r) => listScoringSkills({
    status: strQuery(r.query, "status") ?? "active",
    limit: intQuery(r.query, "limit", { min: 1, max: 200, fallback: 50 }),
  })],
  ["POST", /^\/api\/interviews\/scoring-skills$/, () => { throw new CoreError(NOT_MIGRATED_SKILLS, "unsupported"); }],
  ["GET", /^\/api\/interviews\/scoring-skills\/([^/]+)$/, (m, r) =>
    getScoringSkill(decodeURIComponent(m[1]), intQuery(r.query, "version", { min: 1 }))],
  ["GET", /^\/api\/interviews\/?$/, async (_m, r, d) => (await listInterviews(d.store, {
    status: strQuery(r.query, "status"),
    limit: intQuery(r.query, "limit", { min: 1, max: 300, fallback: 100 }),
  })).items],
  ["POST", /^\/api\/interviews\/?$/, (_m, r, d) => createInterview(d.store, obj(r.body), d.llm(), d.actor)],
  ["POST", /^\/api\/interviews\/debriefs$/, () => { throw new CoreError(NOT_MIGRATED_DEBRIEF, "unsupported"); }],
  ["GET", /^\/api\/interviews\/reviews$/, (_m, _r, d) => listReviews(d.store)],
  ["POST", /^\/api\/interviews\/reviews$/, (_m, r, d) => {
    const { review_id: _drop, ...body } = obj(r.body);
    return saveReview(d.store, body, d.actor);
  }],
  ["POST", /^\/api\/interviews\/reviews\/extract$/, (_m, r, d) => extractReviewQuestions(obj(r.body), d.llm())],
  ["GET", /^\/api\/interviews\/reviews\/weak-spots$/, (_m, _r, d) => getWeakSpots(d.store)],
  ["POST", /^\/api\/interviews\/reviews\/weak-spots$/, (_m, _r, d) => groupWeakSpots(d.store, d.llm(), d.actor)],
  ["POST", /^\/api\/interviews\/reviews\/transcribe$/, (_m, r, d) => {
    if (!r.file) throw new CoreError("缺少录音文件 file");
    checkAudioUpload(r.file.name || "audio.webm", r.file.blob.size);
    return transcribeReviewAudio(r.file.blob, r.file.name || "audio.webm", d.llm());
  }],
  ["GET", /^\/api\/interviews\/reviews\/(\d+)$/, (m, _r, d) => getReview(d.store, id(m))],
  ["PUT", /^\/api\/interviews\/reviews\/(\d+)$/, (m, r, d) => saveReview(d.store, { ...obj(r.body), review_id: id(m) }, d.actor)],
  ["POST", /^\/api\/interviews\/reviews\/(\d+)\/mark-rejected$/, (m, _r, d) => markReviewJobRejected(d.store, id(m), d.actor)],
  ["DELETE", /^\/api\/interviews\/reviews\/(\d+)$/, (m, _r, d) => deleteReview(d.store, id(m), d.actor)],
  ["GET", /^\/api\/interviews\/focus-plan$/, () => { throw new CoreError(NOT_MIGRATED_FOCUS_PLAN, "unsupported"); }],
  ["GET", /^\/api\/interviews\/(\d+)$/, (m, r, d) => getInterview(d.store, id(m), strQuery(r.query, "detail") ?? "full")],
  ["POST", /^\/api\/interviews\/(\d+)\/messages$/, (m, r, d) => submitAnswer(d.store, id(m), obj(r.body), d.llm(), d.actor)],
  ["POST", /^\/api\/interviews\/(\d+)\/behavior-events$/, (m, r, d) => ingestBehaviorEvents(d.store, id(m), obj(r.body), d.actor)],
  ["POST", /^\/api\/interviews\/(\d+)\/restart$/, (m, _r, d) => restartInterview(d.store, id(m), d.actor)],
  ["DELETE", /^\/api\/interviews\/(\d+)$/, (m, r, d) => deleteInterview(d.store, id(m), obj(r.body), d.actor)],

  // ---- /api/interview (routes/interview.py, question bank) ----
  ["GET", /^\/api\/interview\/questions$/, (_m, r, d) => listBankQuestions(d.store, {
    company: strQuery(r.query, "company"),
    role: strQuery(r.query, "role"),
    category: strQuery(r.query, "category"),
    job_id: intQuery(r.query, "job_id") ?? undefined,
  })],
  ["POST", /^\/api\/interview\/collect$/, (_m, r, d) => collectExperience(d.store, obj(r.body), d.actor)],
  ["POST", /^\/api\/interview\/extract$/, (_m, r, d) => extractExperienceQuestions(d.store, obj(r.body), d.llm(), d.actor)],
  ["POST", /^\/api\/interview\/generate-answer$/, (_m, r, d) => generateBankAnswer(d.store, obj(r.body), d.llm(), d.actor)],
  ["GET", /^\/api\/interview\/experiences$/, (_m, r, d) => listExperiences(d.store, { company: strQuery(r.query, "company") })],
];

/** True when some route of this module serves the path (any method). */
export function ownsInterviewConfigPath(path: string): boolean {
  return ROUTES.some(([, pattern]) => pattern.test(path));
}

/**
 * Run one request. Returns `undefined` when no route matches (caller falls
 * through to 404 / another handler). Throws CoreError for expected failures;
 * hosts map `code` to an HTTP status like app.onError does.
 */
export async function handleInterviewConfigApi(request: ApiRequest, deps: ApiDeps): Promise<{ body: unknown } | undefined> {
  const method = request.method.toUpperCase();
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(request.path);
    if (match) return { body: await handler(match, request, deps) };
  }
  return undefined;
}
