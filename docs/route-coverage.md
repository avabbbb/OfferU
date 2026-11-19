# 路由覆盖：Python → TypeScript

Python 后端（FastAPI，`backend/`）已在 `chore/remove-python` 删除，最后一版保留在 tag [`python-backend-final`](https://github.com/avabbbb/OfferU/tree/python-backend-final)。本表列出 Python 当时注册的每个 HTTP 路由在 TS 后端（`backend-ts/src/app.ts` 的 Hono 应用 + `routes/companion/`）里的去向，由 Hono 路由器逐条匹配生成（不发请求）。

- Python 路由共 **157** 条（含 `main.py` 里直接注册的 19 条）；TS 已提供 **135** 条，未迁 **22** 条（全部有意不迁，原因见下）。
- 同一个 Hono 应用跑在三处：网页版页面内（IndexedDB）、Cloudflare Worker（只发静态文件和 `/llm-proxy`）、桌面 / lite 伴侣（Node + SQLite）。只靠本机能力的路由（本机文件、Playwright PDF、BOSS 登录、Agent 看板、配置文件）在网页版回 501，不假装成功。
- 前端和扩展调用的每个 `/api` 路径都由 `backend-ts/test/route-coverage.test.ts` 检查：新增前端调用若没有 TS 路由，测试失败；`KNOWN_UNSERVED` 只列 Python 自己也从没有过的死接口（`python_never`）和不迁的 `/api/research/*`（`research_dropped`）。
- 非 `/api` 的挂载：`/uploads` 静态目录由 `/api/files/*` 替代；HTTP `/mcp`（Streamable）未迁，MCP 走 stdio（`backend-ts` 的 `mcp` 命令）；工作台静态页由伴侣 `server.ts` / `offeru start` 提供。

## 未迁的路由

| 方法 | Python 路径 | 原因 |
| --- | --- | --- |
| GET | `/api/agent/runtime/skill` | 不迁：Skill 改由 `backend-ts/skill/SKILL.md` 随伴侣打包，公开分发在 GitHub |
| GET | `/api/research/job-runs` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/job-runs/{run_id}` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/job-runs/{run_id}/review` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/role-benchmarks/{job_id}/build` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/role-benchmarks/{job_id}/refresh` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/role-benchmarks/job/{job_id}` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/role-benchmarks/{run_id}/signals` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/role-benchmarks/{run_id}` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/pre-application/{job_id}` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/pre-application/{job_id}/prepare` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/pre-application/decisions/{decision_id}/review` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/pre-application/{job_id}/manual` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/authorized-sessions` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/authorized-sessions` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/research/authorized-sessions/{session_id}` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/authorized-sessions/{session_id}/read-only` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/authorized-sessions/{session_id}/captures` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/authorized-sessions/{session_id}/complete` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| POST | `/api/research/authorized-sessions/{session_id}/cancel` | 不迁（2026-11-15 决定 5：旧 djm.db 研究服务，前端已不调用） |
| GET | `/api/bridge/proposals/pending` | 不迁：旧 Proposal 审批桥，前端和扩展均不调用（写操作改为直接生效 + 撤销） |
| GET | `/api/bridge/proposals/{run_id}` | 同上 |

## 全表

### `backend/app/routes/main_agent.py` （69/70）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/agent/runs` | ✅ |
| GET | `/api/agent/runs/{run_id}` | ✅ |
| GET | `/api/agent/runs/{run_id}/events` | ✅ |
| GET | `/api/agent/runtime/actions` | ✅ |
| POST | `/api/agent/runtime/actions/{action_id}/confirm` | ✅ |
| POST | `/api/agent/runtime/actions/{action_id}/reject` | ✅ |
| GET | `/api/agent/runtime/actions/{action_id}/undo-preview` | ✅ |
| POST | `/api/agent/runtime/actions/{action_id}/undo` | ✅ |
| GET | `/api/agent/runtime/runs/{run_id}/input-requests/pending` | ✅ |
| POST | `/api/agent/runtime/runs/{run_id}/input-requests/{request_id}/answer` | ✅ |
| GET | `/api/agent/runtime/runs/{run_id}/events/stream` | ✅ |
| GET | `/api/agent/runtime` | ✅ |
| GET | `/api/agent/skills` | ✅ |
| GET | `/api/agent/runtime/providers/health` | ✅ |
| GET | `/api/agent/runtime/connections` | ✅ |
| GET | `/api/agent/runtime/skill` | — |
| POST | `/api/agent/runtime/connections/{provider_id}/probe` | ✅ |
| POST | `/api/agent/runtime/connections/{provider_id}/integration` | ✅ |
| GET | `/api/agent/runtime/conformance` | ✅ |
| POST | `/api/agent/runtime/conformance/{provider_id}/probe` | ✅ |
| POST | `/api/agent/runtime/conformance/codex-offeru` | ✅ |
| GET | `/api/agent/runtime/career-tasks` | ✅ |
| POST | `/api/agent/runtime/career-tasks` | ✅ |
| GET | `/api/agent/runtime/career-tasks/{task_id}` | ✅ |
| GET | `/api/agent/runtime/career-tasks/{task_id}/events` | ✅ |
| GET | `/api/agent/runtime/career-tasks/{task_id}/result` | ✅ |
| GET | `/api/agent/runtime/career-artifacts` | ✅ |
| GET | `/api/agent/runtime/career-artifacts/{artifact_id}` | ✅ |
| POST | `/api/agent/runtime/career-tasks/{task_id}/cancel` | ✅ |
| POST | `/api/agent/runtime/career-tasks/{task_id}/retry` | ✅ |
| POST | `/api/agent/runtime/career-tasks/{task_id}/resume` | ✅ |
| GET | `/api/agent/runtime/plugins` | ✅ |
| GET | `/api/agent/runtime/plugins/capabilities` | ✅ |
| POST | `/api/agent/runtime/plugins/{plugin}/install` | ✅ |
| DELETE | `/api/agent/runtime/plugins/{plugin}` | ✅ |
| GET | `/api/agent/runtime/automation/events` | ✅ |
| GET | `/api/agent/runtime/automation/inbox` | ✅ |
| GET | `/api/agent/runtime/automation/rules` | ✅ |
| POST | `/api/agent/runtime/automation/events` | ✅ |
| POST | `/api/agent/runtime/automation/daily-review` | ✅ |
| POST | `/api/agent/runtime/automation/inbox/{item_id}` | ✅ |
| POST | `/api/agent/runtime/runs` | ✅ |
| POST | `/api/agent/runtime/runs/stream` | ✅ |
| POST | `/api/agent/runtime/runs/{run_id}/resume` | ✅ |
| POST | `/api/agent/runtime/runs/{run_id}/steer` | ✅ |
| POST | `/api/agent/runtime/runs/{run_id}/abort` | ✅ |
| GET | `/api/agent/runtime/hosted-sessions` | ✅ |
| GET | `/api/agent/runtime/hosted-sessions/{session_id}` | ✅ |
| POST | `/api/agent/runtime/hosted-sessions/{session_id}/cancel` | ✅ |
| POST | `/api/agent/runtime/hosted-sessions/{session_id}/resume` | ✅ |
| GET | `/api/agent/context` | ✅ |
| PUT | `/api/agent/context` | ✅ |
| DELETE | `/api/agent/context` | ✅ |
| GET | `/api/agent/conversations` | ✅ |
| GET | `/api/agent/conversations/{conversation_id}` | ✅ |
| POST | `/api/agent/conversations/{conversation_id}/branch` | ✅ |
| DELETE | `/api/agent/conversations/{conversation_id}` | ✅ |
| GET | `/api/agent/data/export` | ✅ |
| GET | `/api/agent/diagnostics/bundle` | ✅ |
| POST | `/api/agent/data/demo/reset` | ✅ |
| POST | `/api/agent/data/fresh-reset` | ✅ |
| GET | `/api/agent/data/safety/status` | ✅ |
| GET | `/api/agent/data/privacy-hygiene` | ✅ |
| POST | `/api/agent/data/privacy-hygiene/scrub` | ✅ |
| POST | `/api/agent/data/privacy-hygiene/purge-synthetic` | ✅ |
| GET | `/api/agent/data/safety/integrity` | ✅ |
| GET | `/api/agent/data/backups` | ✅ |
| POST | `/api/agent/data/backups` | ✅ |
| POST | `/api/agent/data/restore` | ✅ |
| POST | `/api/agent/data/restore/cancel` | ✅ |
| POST | `/api/agent/runtime/attachments` | ✅ |
| GET | `/api/agent/runtime/attachments/{attachment_id}` | ✅ |

### `backend/app/routes/agent_board.py` （8/8）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/agent-board` | ✅ |
| POST | `/api/agent-board` | ✅ |
| PATCH | `/api/agent-board/{agent_id}` | ✅ |
| DELETE | `/api/agent-board/{agent_id}` | ✅ |
| POST | `/api/agent-board/{agent_id}/hidden` | ✅ |
| POST | `/api/agent-board/{agent_id}/connect` | ✅ |
| POST | `/api/agent-board/{agent_id}/check` | ✅ |
| POST | `/api/agent-board/{agent_id}/launch` | ✅ |

### `backend/app/routes/interviews.py` （23/23）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/interviews/runtime` | ✅ |
| GET | `/api/interviews/scoring-skills` | ✅ |
| POST | `/api/interviews/scoring-skills` | ✅ |
| GET | `/api/interviews/scoring-skills/{skill_id}` | ✅ |
| GET | `/api/interviews/` | ✅ |
| POST | `/api/interviews/` | ✅ |
| POST | `/api/interviews/debriefs` | ✅ |
| GET | `/api/interviews/reviews` | ✅ |
| POST | `/api/interviews/reviews` | ✅ |
| POST | `/api/interviews/reviews/extract` | ✅ |
| GET | `/api/interviews/reviews/weak-spots` | ✅ |
| POST | `/api/interviews/reviews/weak-spots` | ✅ |
| POST | `/api/interviews/reviews/transcribe` | ✅ |
| GET | `/api/interviews/reviews/{review_id}` | ✅ |
| PUT | `/api/interviews/reviews/{review_id}` | ✅ |
| POST | `/api/interviews/reviews/{review_id}/mark-rejected` | ✅ |
| DELETE | `/api/interviews/reviews/{review_id}` | ✅ |
| GET | `/api/interviews/focus-plan` | ✅ |
| GET | `/api/interviews/{interview_id}` | ✅ |
| POST | `/api/interviews/{interview_id}/messages` | ✅ |
| POST | `/api/interviews/{interview_id}/behavior-events` | ✅ |
| POST | `/api/interviews/{interview_id}/restart` | ✅ |
| DELETE | `/api/interviews/{interview_id}` | ✅ |

### `backend/app/routes/research.py` （0/19）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/research/job-runs` | — |
| GET | `/api/research/job-runs/{run_id}` | — |
| POST | `/api/research/job-runs/{run_id}/review` | — |
| POST | `/api/research/role-benchmarks/{job_id}/build` | — |
| POST | `/api/research/role-benchmarks/{job_id}/refresh` | — |
| GET | `/api/research/role-benchmarks/job/{job_id}` | — |
| GET | `/api/research/role-benchmarks/{run_id}/signals` | — |
| GET | `/api/research/role-benchmarks/{run_id}` | — |
| GET | `/api/research/pre-application/{job_id}` | — |
| POST | `/api/research/pre-application/{job_id}/prepare` | — |
| POST | `/api/research/pre-application/decisions/{decision_id}/review` | — |
| POST | `/api/research/pre-application/{job_id}/manual` | — |
| POST | `/api/research/authorized-sessions` | — |
| GET | `/api/research/authorized-sessions` | — |
| GET | `/api/research/authorized-sessions/{session_id}` | — |
| POST | `/api/research/authorized-sessions/{session_id}/read-only` | — |
| POST | `/api/research/authorized-sessions/{session_id}/captures` | — |
| POST | `/api/research/authorized-sessions/{session_id}/complete` | — |
| POST | `/api/research/authorized-sessions/{session_id}/cancel` | — |

### `backend/app/routes/config.py` （5/5）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/config/` | ✅ |
| PUT | `/api/config/` | ✅ |
| POST | `/api/config/test-llm` | ✅ |
| POST | `/api/config/llm-providers/import` | ✅ |
| POST | `/api/config/fetch-models` | ✅ |

### `backend/app/routes/interview.py` （5/5）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/interview/questions` | ✅ |
| POST | `/api/interview/collect` | ✅ |
| POST | `/api/interview/extract` | ✅ |
| POST | `/api/interview/generate-answer` | ✅ |
| GET | `/api/interview/experiences` | ✅ |

### `backend/app/routes/bridge.py` （0/2）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/bridge/proposals/pending` | — |
| GET | `/api/bridge/proposals/{run_id}` | — |

### `backend/app/routes/connections.py` （1/1）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/connections/` | ✅ |

### `backend/app/routes/boss.py` （2/2）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/applications/boss-login` | ✅ |
| POST | `/api/applications/boss-login/{action}` | ✅ |

### `backend/app/routes/consent.py` （3/3）

| 方法 | 路径 | TS |
| --- | --- | --- |
| GET | `/api/consent/platform-collect` | ✅ |
| POST | `/api/consent/platform-collect` | ✅ |
| DELETE | `/api/consent/platform-collect` | ✅ |

### `backend/app/main.py` （19/19）

| 方法 | 路径 | TS |
| --- | --- | --- |
| POST | `/api/ui/pair` | ✅ |
| GET | `/api/tools` | ✅ |
| POST | `/api/tools/{name}` | ✅ |
| GET | `/api/resume/templates/{template}.css` | ✅ |
| POST | `/api/resume/render` | ✅ |
| GET | `/api/resume/{doc_id}/pdf` | ✅ |
| GET | `/api/resume/{doc_id}/png` | ✅ |
| GET | `/api/resume/assets/school-logos` | ✅ |
| GET | `/api/resume/assets/school-logos/{file_name}` | ✅ |
| POST | `/api/resume/assets/school-logos/{file_name}/use` | ✅ |
| POST | `/api/resume/{doc_id}/tailor` | ✅ |
| POST | `/api/jobs/evaluate` | ✅ |
| POST | `/api/resume/impact` | ✅ |
| POST | `/api/resume/logo` | ✅ |
| POST | `/api/files` | ✅ |
| GET | `/api/files/{name}` | ✅ |
| GET | `/api/pairing` | ✅ |
| GET | `/api/health` | ✅ |
| GET | `/api/diagnostics/runtime-identity` | ✅ |

