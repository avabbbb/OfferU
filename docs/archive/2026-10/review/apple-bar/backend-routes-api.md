> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Backend Routes/API 层对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

路由层整体工程素养明显高于常见业余 FastAPI 项目——ops registry 收口、统一错误整形、CORS/Host 白名单、SSE 断连语义都有清晰的设计意图；但存在 **1 个 P1 安全缺口（Studio 预览 iframe 未 sandbox，LLM HTML 可同源调 API）**、**1 个 P1 前端死链（`emailApi.auth()` 指向不存在的 `POST /api/email/auth`）**、以及若干输入边界不一致与 87KB resume.py 内的死代码/直连绕过残留。线上验证（8766 实际进程）确认了 CORS 白名单、校验 400、错误 ID 头均生效。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| R1 | P1 | security | `frontend/src/app/studio/page.tsx:167` + `backend/app/routes/studio.py:60-69` | `<iframe src={previewUrl} title="简历预览" className="w-full h-full border-0" />`，无 `sandbox`；后端 `StreamingResponse(iter([resume.html_content]), media_type="text/html")` 原样吐库里的 `html_content` | `html_content` 由 `generate_html_resume` LLM 生成。iframe src 在 `127.0.0.1:8766` origin，框内文档脚本可**同源** fetch 全部未鉴权 API（`PUT /api/config` 改 base_url、`POST /api/scraper/run` 等），JD 注入 → LLM HTML 夹带 `<script>` → 数据外泄链完整成立。CSP `frame-ancestors` 只限制谁能嵌它，不限制框内脚本 | iframe 加 `sandbox="allow-same-origin"`（渲染需要）或干脆 `sandbox=""` + srcdoc；后端对 `html_content` 加 `Content-Security-Policy: script-src 'none'` 响应头（预览本来就是静态简历，禁脚本零成本）；`generate_html_resume` 落库前做一次 `<script>/on*=` 剥离 |
| R2 | P1 | bug | `frontend/src/lib/api.ts:364` vs `backend/app/routes/email.py:96` | 前端 `auth: () => request("/api/email/auth", { method: "POST" })`；后端只有 `GET /api/email/auth-url` + `GET /api/email/callback`，无 `/auth`。线上实测 `POST /api/email/auth` → `404 {"detail":"Not Found","error_id":"err_5d4c28e4ac6e4027"}` | 前端 Gmail 授权入口是死链，调用即 404。若该函数被任何 UI 触达则功能假死（hooks.ts:564 里已有走 `auth-url` 的正确路径，说明 api.ts 这个方法是过期残留） | 删除 `emailApi.auth()` 或改指 `GET /api/email/auth-url`；全局搜调用点确认无消费者后删除 |
| R3 | P2 | bug | `frontend/src/lib/api-types.generated.ts`（生成物） | 脚本 diff 生成文件 vs 线上 `/openapi.json`（234 paths）：**缺失** `/api/connections/`、`/api/jobs/source-search`；反向无陈旧路径 | 生成类型未随最近两次路由新增重跑。前端因此手写 `JobSourceSearchResult`/`JobSourceConnection` 接口（api.ts:1742-1774），目前字段恰好对齐，但失去了生成物「防漂移」的意义——下次后端改响应字段，手写类型不会报错 | `npm run api:types` 重跑；把 `connectionsApi` 的手写接口替换为生成 schema（或给 generated 加 CI freshness check：`git diff --exit-code` 生成物） |
| R4 | P2 | bug | `backend/app/routes/jobs.py:396-402` | `period: str = Query("week", description="week / month")`；`days = 7 if period == "week" else 30`。实测 `GET /api/jobs/trend?period=today` → 200 返回 30 天数据（2026-08-21 起） | `period` 是自由字符串，任何非 "week" 值静默落到 30 天。文档只写 week/month，但 `list_jobs` 同参数支持 today，调用方极易把 `?period=today` 带过来拿到错误的月视图 | `period: Literal["week","month"] = "week"`（或 Query(pattern=...)），非法值直接 422 |
| R5 | P2 | design | `backend/app/main.py:169-212` + 线上实测 | `env CORS_ORIGINS` 当前含 `http://localhost:3000`、`http://localhost:5140`（AGENTS.md 预警的旧值漂移场景真实存在）；实测这两个 origin 的 preflight 返回 `Access-Control-Allow-Origin`；`STUDIO_PREVIEW_EMBED_ORIGINS` 也继承它们进 CSP frame-ancestors | 白名单按 host 而非 host:port 收敛是本机威胁模型下的合理选择，但**陈旧端口来源保留全部 API 的跨域读权限**（3000/5140 上若跑着别的 dev server 被挂马页面，它能读 OfferU 数据）。且 frame-ancestors 随之放宽 | 短期：清理系统环境变量里的旧端口（AGENTS.md 已写流程）。中期：`_is_allowed_cors_origin` 除 host 外再卡端口白名单 `{7410, 8766}` + tauri/extension scheme；frame-ancestors 同理只保留 7410 |
| R6 | P2 | design | `backend/app/routes/main_agent.py:214,241,471,515,543,594,606,859,982`；`memory.py:44,50`；`scraper.py:127` | `limit: int = 20`（runs）、`limit: int = 200`（events）、`limit=8`（memory_search）等 10+ 处无 `Query(le=)`；`RunRequest.max_results: int = 50` 无上界 | 对比 `email.py`/`jobs.py` 全部 `Query(..., ge=1, le=N)`——同一 codebase 两套输入边界纪律。`limit=999999` 不会 422，直达 DB/service 层 | 统一补 `le=`：runs/events ≤500、career-tasks ≤200、memory ≤50、scraper `max_results ≤200`；价值观即 email.py 已有写法 |
| R7 | P2 | ux | `backend/app/routes/email.py:117-130` | `oauth_callback` 失败时 `_operation_outputs` 抛 HTTPException → 用户浏览器看到裸 JSON `{"detail":...}`；成功时才 `RedirectResponse(.../email?auth=success)` | OAuth 失败路径把用户丢在后端 JSON 错误页，无返回入口；对照成功路径有明确前端跳转 | except 后 `RedirectResponse(f"{_frontend_url()}/email?auth=error&reason={quote(msg)}")`，错误展示交给前端页面 |
| R8 | P3 | arch | `backend/app/routes/resume.py:540-617` | `_resolve_university_logo_url`（80 行 httpx+wikidata 逻辑）定义后**零调用**——`/logo/resolve` 走 `_execute_operation("resolve_resume_logo")`（ops.py:3843 注册到 service 层）。`__pycache__` 与 grep 均确认无调用点 | 死代码；且其内部 `httpx.AsyncClient(timeout=15)` 未 `trust_env=False`（与 fetch_models 的显式 `trust_env=False` 不一致），残留着旧实现的安全差异 | 删除函数及 `httpx`/`quote` import（若无其它用途）；保留 service 层实现为唯一入口 |
| R9 | P3 | design | `backend/app/routes/scraper.py:69-119` | `_mark_batch_failed_fallback`（直接 `update(Batch)` + `db.commit()`）与 `_reap_orphaned_running_batches`（同上）是 routes 层**仅有的两处绕过 ops registry 的写路径** | 属有意识的兜底设计（注释说明），但绕过时绕过了 registry 的审计/幂等层；`_reap_orphaned` 还在 `GET /tasks` 读端点里做写操作（GET 语义污染：拉列表会改库） | 收割逻辑搬回 service/ops（如 `reap_orphaned_scraper_batches` op，由 list_tasks 调用）；`_mark_batch_failed_fallback` 保留但加 TODO 注释指向 ops 化 |
| R10 | P3 | design | `backend/app/routes/bridge.py:28-38` | `list_pending_proposals` 函数体内 `from sqlalchemy import select`、`from app.database import async_session`、`from app.models.models import AgentRunRecord` **逐字重复 import 两次** | 复制粘贴残留，无功能影响但暴露「函数内 import」约定没被 lint 兜住 | 删重复段；考虑把函数内 import 收敛到文件头（这三项不是循环依赖场景） |
| R11 | P3 | design | `backend/app/routes/main_agent.py:764-769` vs `follow_runtime_run_events:360-412` | `stream_runtime_run` 的 `run_and_record` task 在客户端断开后继续跑（注释声明是有意的，事件落库权威）——合理；但 `follow_runtime_run_events` 对**永不完结的 run** 每 0.25s 轮询 DB 且无最大时长 | SSE follow 循环的退出条件只认 `run` 状态完结；若 provider 崩溃未写终态，连接会无限期 4 QPS 打 DB | 给 follow 循环加 idle 上限（如无新事件 N 分钟则发 error 收尾），或复用 run heartbeat 超时判死 |
| R12 | P3 | ux | `backend/app/routes/resume.py:1947-1991` | `/parse` 校验顺序：先查 filename → 扩展名 → size → parse；`parse_resume_document` 返回 None → **500**「文件解析失败」 | 损坏 PDF/加密 docx 是用户输入问题，返回 500 语义错误（会进全局 unhandled 计数），且与空文本的 400 不一致 | `parse_resume_document` 失败统一映射 422/400；500 只留给真正的内部异常 |
| R13 | P3 | perf | `backend/app/routes/jobs.py:254-255` | `total_q = select(func.count()).select_from(query.subquery())`——带全部 WHERE+ORDER BY 的子查询做 count | count 子查询继承了无意义的 `ORDER BY created_at DESC`（子查询排序在 SQLite 多数被优化掉但属脏 SQL）；真正 N+1 在本文件中未见（batches/stats/trend 均为聚合查询，optimize.py:1144-1153 已显式批查避免 N+1） | count 用 `query.order_by(None)` 后再 subquery，或 `select(func.count(Job.id)).where(...)` 独立构造——低优先级打磨 |
| R14 | P3 | design | `backend/app/routes/scraper.py:183-234` | `task_id = hashlib.md5(f"{source}-{utcnow().isoformat()}")[:12]`；`asyncio.create_task(_execute_scraper(...))` 无引用保留、无取消通道 | 同一 source 同微秒双击会撞 task_id（概率极低）；**scraper 任务无任何取消端点**——career-tasks/agent-runs 都有 cancel/abort，唯独最早实现的 scraper 没有 | task_id 改 `uuid4().hex[:12]`；如需取消语义，给 `_tasks` 存 `asyncio.Task` 引用并加 `POST /tasks/{id}/cancel`（或承认「爬取不可取消」并写进 API 注释） |
| R15 | P3 | design | `backend/app/routes/config.py:902-978` | `fetch-models` 接受任意 `base_url` 直接 `client.get(f"{base_url}/models")`——SSRF 形状（本机 loopback 应用风险低，但与 `_probe_llm_endpoint` 相同面）；`trust_env=False` 已正确设置 | 与 `PUT /api/config` 可改 LLM base_url 同属「本机无鉴权 API 信任边界」问题的一部分；单独看仅是不一致（`fetch-models` 有超时 15s + follow_redirects=False，做对了大半） | 短期不改；长期值得给所有外发 URL 过一层「http(s) + 非内网保留段或用户显式确认」helper，统一入口 |
| R16 | P3 | ux | `backend/app/routes/resume.py:1947` vs 文件头注释 `:24` | 头注释 API 清单缺 `/logo`、`/logo/resolve`、`/export/image`、`/ai/*`、`/versions`、`/share*`、`/workspace*`、`/ai/generate-draft` 等 20+ 端点 | 87KB 文件头的端点索引严重漂移——新读者按注释只能看到 13 个端点，实际 30+ | 头注释改为只写分区名（CRUD/AI/Export/Version/Share/Workspace）或删清单改指 OpenAPI docs |
| R17 | P3 | design | `backend/app/routes/email.py:73-80` 等 | `_operation_outputs` 在 6+ 个 route 文件各复制一份，错误→状态码映射规则**各不相同**：email 全 400；resume `not found→404/密码→401/过期→403`；scraper 全 400；pools `not found→404/already exists→409` | 同一个 ops 错误字典在不同路由被翻译成不同 HTTP 语义；`delete_pool` 的「不存在」靠字符串 `"not found"` 猜，中文错误消息会漏匹配→误报 400 | 抽 `app/routes/_operation.py` 共享 helper，错误带 `code` 字段（ops 层产出）替代字符串嗅探 |

## API 一致性清单（抽查结果）

| 端点 | 后端签名 | 前端调用 | 结果 |
|------|----------|----------|------|
| `GET /api/jobs/` | jobs.py:163-177（page/page_size le=100、triage_status、pool_id、period 等 12 参） | api.ts:175 `jobsApi.list(params?: JobsListQuery)` — 用生成类型 | ✅ 一致 |
| `PATCH /api/jobs/batch-update` | jobs.py:312 `JobBatchPatchRequest` | api.ts:186 用 `Schemas["JobBatchPatchRequest"]` | ✅ 一致 |
| `GET /api/jobs/source-search` | jobs.py:480-513（keywords/location/limit/sources） | api.ts:1780-1786 `connectionsApi.search` 手写类型 | ⚠️ 字段对齐但 generated.ts 缺该路径（R3） |
| `POST /api/studio/generate` | studio.py:42 `GenerateHtmlResumeRequest{profile_id,template_id,design_overrides,job_ids}` | studio/page.tsx:82-90 同四字段 | ✅ 一致 |
| `POST /api/resume/{id}/ai/generate-draft` | resume.py:2315 SSE，事件 progress/error/result/done | hooks.ts:2905-2974 手写 SSE parser 同事件名 | ✅ 一致 |
| `POST /api/email/auth` | **不存在** | api.ts:364 | ❌ 死链（R2） |
| `GET /api/email/progress-candidates` | email.py:266-270（status/disclosure/limit） | hooks.ts:3141 同三参 | ✅ 一致 |
| `GET /api/scraper/sources`、`POST /run`、`GET /tasks` | scraper.py:167/183/358 | hooks.ts:1923/1928/1936 | ✅ 一致 |
| `GET /api/connections/` | connections.py:37 返回 `{ok, connections[]}` | api.ts:1778 手写接口字段全对 | ⚠️ 字段对齐但 generated.ts 缺路径（R3） |
| 全量路径 diff | 234 paths @ /openapi.json | api-types.generated.ts | ❌ 缺 2 条新路径（R3） |

## Top-5 修复优先级

1. **R1 Studio iframe sandbox + CSP script-src 'none'** — 唯一一条从「不可信输入（JD）」到「同源写全量 API」的完整链路；一个属性 + 一个响应头即可拆掉。
2. **R2 删除/修复 `emailApi.auth()` 死链** — 一行修复，但它是「前端以为功能存在、实际 404」的典型假成功面；顺手全局搜调用点。
3. **R5 CORS/端口收敛 + 清理漂移的环境变量** — AGENTS.md 预警的场景正在本机真实发生（3000/5140 持有跨域读权）；`_is_allowed_cors_origin` 加端口白名单是把文档教训固化成代码。
4. **R3 重跑 `npm run api:types` 并给生成物加 freshness check** — 成本十分钟，恢复「生成类型防漂移」机制的信用。
5. **R17 收敛 `_operation_outputs` 到共享 helper + ops 错误码字段** — 6 份字符串嗅探副本是后续所有「404 变 400」类 bug 的温床。

## 已达标的点（简短）

- **CORS 白名单 + env 漂移防线**（main.py:169-204）：非本机 origin 直接拒并 warn，7410 无条件兜底——实测 `evil.example.com` preflight 400、chrome-extension regex 正常放行。
- **DNS-rebinding Host 校验**（main.py:348-366）：非回环 Host → 403 + error_id（注意：当前运行的 8766 进程是 9/18 启动的旧代码，`reload=False`，实测返回 200 属「修复未部署」而非代码缺陷——重启后生效）。
- **统一错误整形**：HTTPException/Starlette/ValidationError/兜底 Exception 全部过 `_error_response`，`X-OfferU-Error-Id` 头 + `record_error` 落诊断；422 刻意不回显 `input` 防密钥泄漏。
- **写路径 ops registry 收口**：resume/profile/applications/interviews/research 等 20+ 文件的 mutation 全部走 `execute_operation`；仅 scraper.py 两处文档化兜底直连（R9）。
- **SSE 工程**：`batch-optimize` 有 `is_disconnected()` + ping/send_timeout；`runs/stream` 断开后 run 继续、可经 `events/stream` 重接（durable event log 权威）——这是 Apple 级的断连语义。
- **N+1 纪律**：`optimize.py:1144` 显式批查注释、`interview.py:167` 分组 count、`resume.py` `selectinload`/`_load_source_jobs_map` 批载——作者群有意识且留注释。
- **Agent 工具调用安全**（agent.py:247-263）：TOOL_REGISTRY 白名单 + 副作用操作强制 dry-run + 人工 confirm 端点——LLM 不可直达写操作。
- **输入校验整体**：pydantic Field 约束（`min_length/max_length/pattern/ge/le`）覆盖大多数体；email.py/jobs.py 的 Query 边界完整——缺失集中在 main_agent/memory/scraper（R6）。
