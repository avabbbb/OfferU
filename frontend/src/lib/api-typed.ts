// =============================================
// Typed API client — generated OpenAPI types + thin request wrapper
// =============================================
// Generated from backend OpenAPI schema. Regenerate with:
//   npm run api:types
// Do not edit api-types.generated.ts manually.

import type { components, operations } from "./api-types.generated";

type Schemas = components["schemas"];
type Ops = operations;

// ── Request types wired into api.ts / agentConnection.tsx ──
export type AgentContextRequest = Schemas["AgentContextRequest"];
export type JobPatchRequest = Schemas["JobPatchRequest"];
export type JobBatchPatchRequest = Schemas["JobBatchPatchRequest"];
export type PoolCreateRequest = Schemas["PoolCreateRequest"];
export type PoolUpdateRequest = Schemas["PoolUpdateRequest"];
export type RoleBenchmarkBuildRequest = Schemas["RoleBenchmarkRequest"];
export type PreApplicationDecisionReviewRequest = Schemas["PreApplicationDecisionReviewRequest"];
export type CareerTaskStartRequest = Schemas["CareerTaskStartRequest"];
export type ResumeProposalReviewRequest = Schemas["ResumeProposalReviewRequest"];
export type ResumeProposalItemReviewRequest = Schemas["ResumeProposalItemReviewRequest"];

// ── Query param types wired into api.ts ──
export type JobsListQuery = Ops["list_jobs_api_jobs__get"]["parameters"]["query"];

// ── Domain re-exports for consumers that prefer generated types ──
export { agentRuntimeApi, jobsApi, poolsApi, resumeApi, preApplicationApi, memoryApi } from "./api";
