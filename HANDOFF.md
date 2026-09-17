# Closure Pass Report — 2026-09-17

## Summary

Four half-finished items from the previous goal are now closed:

| Item | Before | After | Evidence |
| --- | --- | --- | --- |
| Backend test suite | "52/52 relevant" (subset) | **621 passed, 9 skipped, 0 failed** | `pytest tests/ -q` via `hub start name=pytest-full-verify`, 3m42s |
| OpenAPI codegen | Generated file existed, not wired | **8 endpoints wired** | `Schemas`/`Ops` for request bodies + query params in `api.ts` + `agentConnection.tsx` |
| Job-preparation progress | Static text in "Next preparation" card | **Dynamic checklist** | Driven by `CareerTask.progress.stage` + `preApplication.stage` + `resumeProposal` presence; retry button on failed tasks |
| Demo media | Placeholder static-frame GIF | **Real recorded WebM→GIF** | 13.5s, 6.4MB, real click-through on showcase workspace |

## OpenAPI wiring details

**8 endpoints** now use generated types for request bodies / query params:

| Endpoint | Type | Location |
| --- | --- | --- |
| `agentRuntimeApi.syncContext` | `Schemas["AgentContextRequest"]` | `api.ts` line ~965 |
| `jobsApi.patch` | `Schemas["JobPatchRequest"]` | `api.ts` line ~182 |
| `jobsApi.patchBatch` | `Schemas["JobBatchPatchRequest"]` | `api.ts` line ~185 |
| `jobsApi.list` | `Ops["list_jobs_api_jobs__get"]["parameters"]["query"]` | `api.ts` line ~172 |
| `poolsApi.create` | `Partial<Schemas["PoolCreateRequest"]> & {name: string}` | `api.ts` line ~196 |
| `poolsApi.update` | `Schemas["PoolUpdateRequest"]` | `api.ts` line ~199 |
| `roleBenchmarkApi.build` | `Partial<Omit<Schemas["RoleBenchmarkRequest"],"runtime_id">> & {runtime_id?: union}` | `api.ts` line ~809 |
| `preApplicationApi.review` | `Omit<Schemas["PreApplicationDecisionReviewRequest"],"final_decision"> & {final_decision: PreApplicationDecisionChoice}` | `api.ts` line ~1208 |

**Response types stay hand-written** — FastAPI emits `unknown` for most response bodies in OpenAPI, so generated types are only useful for request bodies + query params.

**New file**: `src/lib/api-typed.ts` — facade re-exporting all wired request types + `JobsListQuery` + the API objects.

## Progress projection details

**Location**: `frontend/src/app/jobs/[id]/page.tsx` — "Next preparation" card, after the header.

**Data sources**:
- `useCareerTasks(50)` — finds `task_type==="role_intelligence" && target_type==="job" && target_id===String(jobId)`
- `preApplication.stage` — `resume_proposal_ready` / `decision_ready` → decision done
- `resumeProposal` — presence → proposal done
- `research` — presence → benchmark done

**Stages rendered dynamically** (not a state machine — derived from real state):
1. `saved` — always done (we're on the page)
2. `task` — `queued`/`running`/`completed`/`failed`/`blocked` from `CareerTask.status`
3. `benchmark` — `hasBenchmark` or `benchmarkDone` → done; `running`/`queued` → active
4. `decision` — `preApplication.stage` mapped to human-readable label
5. `proposal` — `resumeProposal` presence → done

**Retry**: when `preparationTask.status === "failed" && preparationTask.retryable`, a "重试准备任务" button calls `controlCareerTask(task_id, "retry")` via dynamic import.

## Demo video details

**Source**: Real click-through on `http://127.0.0.1:7412` (showcase vite with `VITE_SHOWCASE=true`).

**Script**: `frontend/scripts/record-demo.mjs` — Playwright `recordVideo` on managed Chromium at `H:/tmp/offeru/pw-browsers/chromium-1243/chrome-win64/chrome.exe`.

**Flow**: Today → Jobs → Job Detail → Role Intelligence → Resume Proposal → Pipeline → Today (13.5s).

**Output**: `asset/demo/offeru-demo.gif` (6.4MB, 12fps, 1280px, palette-optimized). Original WebM kept at `H:/tmp/offeru/demo-video/page@*.webm`.

**Console errors**: 0.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 errors (excluding generated file) |
| `npx vitest run` | 16/16 pass |
| `npm run build` | ✓ built in 8.77s |
| Browser smoke (`#/jobs/1`, `#/jobs/353`) | Progress checklist renders; all cards present |
| `git diff --check` | Clean (CRLF warnings only) |

## Files changed

- `frontend/src/lib/api.ts` — 8 endpoints wired to `Schemas`/`Ops`
- `frontend/src/lib/api-typed.ts` — **new** facade for generated types
- `frontend/src/lib/agentConnection.tsx` — `AgentContextRequest` type alias + typed payload
- `frontend/src/lib/hooks.ts` — `JobFilters.pool_id` → `string` (generated schema says `string | null`)
- `frontend/src/app/jobs/page.tsx` — `scopedPoolFilter` → `String(selectedPoolFilter)`
- `frontend/src/app/optimize/components/OptimizeWorkspace.tsx` — `poolIdForQuery` → `String(poolFilter)`
- `frontend/src/app/jobs/[id]/page.tsx` — `useCareerTasks` + `preparationTask` + `preparationProgress` memo + checklist render + retry button
- `frontend/src/components/jobs/RoleIntelligencePanel.tsx` — `PREPARATION_STAGES` projection (from prior session)
- `asset/demo/offeru-demo.gif` — replaced placeholder with real recording
- `STATUS.md` — closure pass table added
- `frontend/scripts/record-demo.mjs` — **new** recording script

## Remaining risks

- `useCareerTasks(50)` fetches all tasks — fine for 50 tasks, may need pagination later.
- The `benchmark` stage detection uses `preparationTask.result_ref.includes("role_benchmark")` — if the backend changes the ref format, this breaks. The `RoleIntelligencePanel` has its own `benchmark.status` check which is more reliable.
- The demo video is 6.4MB — acceptable for a README GIF but not ideal for web. A hosted MP4/WebM would be smaller.
- The `pool_id` type correction (`number | "ungrouped"` → `string`) is a real drift find — the backend expects string. Verified no callers pass raw numbers.
