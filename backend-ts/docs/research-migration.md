# 岗位研究 / 投递进度域迁 TS（分支 ts/research）

## 已迁移

| 端点 | Python | TS |
| --- | --- | --- |
| `POST /api/jobs/evaluate`（SSE） | `main.py` jobs_evaluate → `core/tools.py` evaluate_stream → `core/job_eval.py` | `routes/research.ts` → `@offeru/core` `research/evaluate.ts` + `research/job-eval.ts` |
| `GET /api/applications/boss-login` | `routes/boss.py` → `services/boss_login.py` | `routes/companion/boss-login.ts` + `boss-cli.ts`（只在 Node 伴侣；Worker 上 501） |
| `POST /api/applications/boss-login/{start,cancel,logout}` | 同上 | 同上 |

core 里同时导出了工具形态 `evaluateJobs`（Python `evaluate_jobs`：limit 默认 3、1–20，返回 remaining），还没挂进 `backend-ts/src/tools.ts`（工具表属于 core-tools 分支，且 callTool 目前拿不到 LlmClient）。

### LlmClient
`origin/ts/core-tools` 当时不存在，所以在 `packages/core/src/llm.ts` 定义了最小接口：
`LlmClient.chat(messages, {temperature, jsonMode, maxTokens, tier, signal}) → Promise<string | null>`（失败/超时返回 null，只有 abort 才 reject，对齐 Python chat_completion），外加 `openAiCompatibleClient`（fetch 注入，浏览器/Worker/Node 通用）和 `extractJson`。
`AppDeps.llm?: () => LlmClient | null`，每次请求现取。Node 伴侣暂时从环境变量读：`OFFERU_LLM_BASE_URL / OFFERU_LLM_API_KEY / OFFERU_LLM_MODEL / OFFERU_LLM_JSON_MODE=0`（`src/llm-env.ts`）；Python 的 config.json + 密钥保险箱解析（resolve_llm_client_config）留给配置域。

### 与 Python 的行为差异（只在失败路径）
- 没配模型、id 不存在、岗位没 JD：开流之前直接回 400/404 JSON（Python 是 200 开流后断掉）。
- 流中途失败（所有岗位模型都没给出可用评估等）：最后一条 `{"type":"error","detail","code"}`（Python 是断连接）。`frontend/src/lib/evaluate.ts` 已改为把它和非 2xx 的 detail 抛成 Error，页面原有的 catch 会显示。
- 每个岗位的评估文档和 job.score 在一个事务里写（Python 是两次独立写）。
- 没迁：「没配模型时交给本机 Agent」（agent_fallback）。评估前补 posting（enrich_jobs，属于 job intake）做成了可选注入 `enrich`，路由暂未接。
- BOSS：只认 `OFFERU_BOSS_BIN`；Python 源码运行时的 `python backend/boss_entry.py` 回退随 Python 一起删除。

## 契约测试
`backend-ts/test/research.test.ts`：
- `test/fixtures/job-eval-parity.json` 由 `test/fixtures/gen_job_eval_parity.py` 跑 Python `job_eval` 生成（在 `backend/` 下 `PYTHONPATH=. python3 ../backend-ts/test/fixtures/gen_job_eval_parity.py`），TS 对同样输入要求 prompt 消息逐字一致、normalize 结果一致（含 banker's rounding、码点截断、str() 语义、模型自写来源被丢弃、评分口径段）。
- 评估流顺序/落库/重评覆盖同一文档/工具分块（对应 Python test_evaluate_stream.py）。
- HTTP SSE、400、error 事件；BOSS 登录用假 boss 脚本走 start → waiting(二维码) → cancel → logout，Worker 501。

## 没迁（死代码 / 旧架构），可随 Python 一起删

依据：AGENTS.md 写明 `app/ops.py`、`app/services/`、`app/agents/`、`app/routes/` 是旧架构；这些服务读写的是旧 SQLAlchemy 库 `djm.db`（`jobs`、`job_research_runs`、`role_benchmark_runs` … 几十张表），和当前 `offeru.db` 的 records/changes 不是一个库，岗位 id 也不对应；前端没有任何组件调用它们。

`routes/research.py` 全部 19 个端点（frontend `lib/api.ts` 里的 `roleBenchmarkApi / jobResearchApi / preApplicationApi` 无任何组件引用）：
- `GET /api/research/job-runs`、`GET /job-runs/{run_id}`、`POST /job-runs/{run_id}/review`
- `POST /role-benchmarks/{job_id}/build`、`POST /role-benchmarks/{job_id}/refresh`、`GET /role-benchmarks/job/{job_id}`、`GET /role-benchmarks/{run_id}/signals`、`GET /role-benchmarks/{run_id}`（依赖 coding_agent_runtime 拉起本机 codex/claude 等 CLI 做“岗位基准”）
- `GET /pre-application/{job_id}`、`POST /pre-application/{job_id}/prepare`、`POST /pre-application/decisions/{id}/review`、`POST /pre-application/{job_id}/manual`
- `POST/GET /authorized-sessions`、`GET /authorized-sessions/{id}`、`POST …/read-only`、`…/captures`、`…/complete`、`…/cancel`

对应服务（~11.7k 行）：`role_intelligence.py`、`job_research.py`、`authorized_research.py`、`pre_application_decisions.py`、`packet_readiness.py`、`application_progress.py`、`application_workspace.py`、`work_sources.py`、`job_ingest.py`，以及 `ops.py`/`agent_operations.py` 里对应的 Operation 注册、`main.py` lifespan 里的 recover_interrupted_research_runs / authorized_research / work_source_auto_sync 启停。
其他仍引用它们的地方（属于别的域，删除时一起处理）：`routes/main_agent.py` 的 hosted job_research cancel/resume、`routes/interviews.py` 的 `role_benchmark_run_id`、`frontend/src/app/interview/ai/page.tsx` 的 role_intelligence 复盘展示、`routes/connections.py` 的 application_progress 标签、`scripts/run_research_driver.py`、`scripts/e2e/*`、`scripts/live_eval/*`。

## 前端调用了但 Python 根本没有的接口（全部无组件引用，未实现）
- `lib/api.ts`：`GET /api/jobs/{id}`、`/api/jobs/batches`、`/api/jobs/stats`、`POST /api/jobs/capture/draft`、`POST /api/jobs/capture`、`GET /api/pools/`、`DELETE /api/pools/{id}`、`GET /api/jobs/source-search`（`connectionsApi.search`，组件只用了 `list`）
- `lib/hooks.ts`：`/api/jobs/{id}`、`/api/jobs/stats`、`/api/jobs/trend`、`/api/scraper/tasks`、`/api/applications/workspace|settings|template|tables|tables/{id}|tables/{id}/records|schema|import-jobs|import-latest-extension-batch|import-boss`、`/api/applications/records|records/{id}|records/move|records/delete`
- `lib/api-types.generated.ts` 里的 `/api/research/*` 类型是从 Python OpenAPI 生成的，随上面一起删。

建议协调者在前端清理分支里删掉这些无引用的客户端函数和 hooks。
