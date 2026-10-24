> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 前端数据层（lib/）对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

`agentConnection.tsx` 的单写入者串行队列是合格设计，AGENTS.md 记录的双写覆盖问题已真正解决；但 `hooks.ts`(96KB/3185 行/206 个导出) 与 `api.ts`(53KB/1788 行) 是两套平行数据层，同一文件内混用、错误语义分叉、4 个写操作静默吞错（HTTP 非 2xx 直接 `res.json()` 当成功返回）、SSE 解析逻辑手写重复 5 份且互不兼容 — 达不到上线水准，需要先收敛数据层再谈打磨。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| FD-01 | P1 | bug | `hooks.ts:1531-1538` `updateApplication` | `const res = await showcaseFetch(...); return res.json();` — 无 `res.ok` 检查 | 投递状态更新失败（4xx/5xx/网络外的 HTTP 错误）被当成成功，`res.json()` 返回的 `{detail:...}` 被调用方当正常结果；用户在「投递进展」改状态失败后 UI 显示成功 | 补 `if (!res.ok)` + `safeClientErrorMessage`，与同文件 `createApplication` 对齐 |
| FD-02 | P1 | bug | `hooks.ts:1541-1548` `generateCoverLetter` | 同上，无 `res.ok` 检查 | 求职信生成失败静默返回错误体，调用方拿到 `{detail}` 当文本用 | 同上 |
| FD-03 | P1 | bug | `hooks.ts:1313-1319` `reorderSections`、`1323-1331` `uploadResumePhoto`、`1334-1342` `uploadResumeLogo` | 三个函数均无 `res.ok` 检查（同文件 `resolveResumeLogo` 1351 行有） | 简历段落排序/照片/校徽上传失败 = 假成功；排序失败会让用户以为已保存，刷新后顺序回退 — 数据正确性感知级 bug | 三处统一补错误检查 |
| FD-04 | P1 | design | `api.ts:86-90` `readEventStream` | `const res = await fetch(...)` 未包 try/catch，对比 `request()` 56-65 行有 catch→友好文案 | Agent 流式请求网络失败抛原生 `TypeError: Failed to fetch`，而不是 `request()` 的「无法连接本地后端」；上层拿到的错误文案/形态不一致，`agentRuntimeApi.start` 的 reconnect 分支会把瞬时网络抖动当可重连错误处理，8 次指数退避后才抛出原生 TypeError | `readEventStream` 的 fetch 包一层网络错误翻译；区分「网络层失败（值得重连）」和「HTTP 错误（不值得）」目前靠字符串匹配 `__SSE_UNAVAILABLE__`/`API Error: 404`，脆弱 |
| FD-05 | P1 | arch | `hooks.ts` ↔ `api.ts` 双数据层 | `jobs/page.tsx:35` 同时 `import { jobsApi } from "@/lib/api"` + `import {...} from "@/lib/hooks"`；`PoolManager.tsx:20-21` 同模式；35 个文件用 hooks、22 个文件用 api、至少 6 个文件两者混用 | 同一资源（jobs/pools/resume/profile/applications）有两套调用入口、两套错误文案、两套 showcase 分流（`hooks.ts` 走 `showcaseFetch`→`Response`，`api.ts` `request()` SHOWCASE 分支直接返回对象）。新代码不知道抄哪边，错误处理漂移由此产生（FD-01~03 全是 hooks.ts 侧） | 见文末拆分建议：按域拆 hooks.ts，写操作收敛到 api.ts 的 `request()`，hooks 只留 SWR key + fetcher |
| FD-06 | P2 | bug | `api.ts:51-73` `request()` 的 `redirect: "error"` | 后端 FastAPI `redirect_slashes` 默认开启（`backend/app/main.py:154` 未关闭）；前端路径有尾斜杠混用（`/api/jobs/` vs `/api/jobs/batches`） | 任何一个路径尾斜杠不匹配 → 后端 307 → `redirect:"error"` 使 fetch 抛 TypeError → 被 56-65 行 catch 翻译成「无法连接本地后端，请确认 8766 服务已启动」— **把路由 bug 报成宕机**，排查方向完全错误 | `redirect: "manual"` + 3xx 单独报错「路径不匹配(3xx)」；或逐路径对齐后端路由（目前没炸是因为两边恰好对齐，靠运气） |
| FD-07 | P2 | ux | `hooks.ts:40-43` fetcher vs 全部 mutation | SWR fetcher 非 2xx 只抛 `API {status}`（+errorId），不读 body `detail`；mutation 抛 `safeClientErrorMessage(err.detail,...)` | 同一后端 422 校验错误：列表页显示干巴巴的 `API 422`，操作按钮显示后端详细中文说明。错误 ID（后端排障线索）在 79 处 `showcaseFetch` 里只有 2 处读取（41、1352 行） | 统一 error-shape：`{status, detail, errorId}` 的 `ApiError` 类，fetcher 与 mutation 共用 |
| FD-08 | P2 | ux | `hooks.ts:17-19` `formatBackendNetworkError` | 文案固定写死「配置 API Key 时浏览器只会请求本地后端，不会直接连接 DeepSeek」 | 该函数被 `controlCareerTask`/`updateConfig`/`createAIInterview`/`submitAIInterviewAnswer` 等通用场景复用 — 用户删一个岗位失败会看到一段关于 DeepSeek API Key 的说明，困惑且泄漏实现细节 | 按场景出文案；通用版只留「无法连接本地后端」 |
| FD-09 | P2 | arch | `hooks.ts` SSE 解析 ×5 | `streamProfileChat`(1086)、`batchOptimizeResume`(2001)、`streamOptimizeAgentChat`(2149)、`streamOptimizeGenerate`(2321)、`streamGenerateResumeDraft`(2905) + `api.ts:76` `readEventStream` — 6 份手写 SSE 循环 | `findBoundary`/emit/reader 循环复制粘贴 5 次但事件解析互不兼容：`batchOptimizeResume` 用 `"\n\n" split` + `event: `（带空格）解析，其它用 `indexOf` + `event:`（无空格）— `data: x`（无空格）事件在 2044-2045 行被静默丢弃；`batchOptimizeResume` 流结束无 `done` 事件时返回 `{total,success:0,results:[]}` 假成功（2063 行） | 抽一个 `readSseStream(res, {onEvent})` 共享；`batchOptimizeResume` 缺 `done` 应抛错而不是返回空成功 |
| FD-10 | P2 | bug | `hooks.ts:630-643` `imapConnect` | `return { ok: res.ok, data: await res.json() }` — 全文件唯一不抛错而是返回 ok 标志的写操作 | 错误处理契约不一致：调用方必须记得检查 `.ok`，忘记则静默失败（邮箱密码错误场景！） | 改为抛错或统一文档化两种契约；至少 grep 调用方确认都检查了 ok |
| FD-11 | P3 | design | `apiBase.ts:9` | `LOCAL_API_HOSTS.has(parsed.hostname) → return DEFAULT_API_BASE` | `VITE_API_URL=http://127.0.0.1:9000` 被静默改写成 `:8766` — 防注入硬化正确，但连合法端口配置也吞掉，dev 自定义端口调试时「配置不生效」无任何提示 | 本地 host 保留用户端口：`return parsed.origin`；或 console.warn 一次 |
| FD-12 | P3 | arch | `api-types.generated.ts` 421KB | 194 个响应 `application/json: unknown`（后端无 response_model），仅请求体有类型；`api-typed.ts` 只导出 9 个请求类型 | 「类型化 API 层」名不副实：响应侧全靠 `api.ts` 手写 interface（`AgentRunRecord` 等 40+ 个），与后端模型漂移无编译期保障。生成文件 14,860 行造成的类型安全感是幻觉 | 后端补 response_model（产出更大）或在 api-typed.ts 顶部注释明确「仅请求体类型」；中期价值在于先让后端声明响应 |
| FD-13 | P3 | ux | `hooks.ts:241-272` `useJobs` vs `api.ts:172-176` `JobsListQuery` | `JobFilters` 手写 interface 与 generated `JobsListQuery` 字段重复（page_size/period/source/keyword/job_type/education/is_campus/triage_status/pool_id/batch_id），且 `JobFilters` 缺 `sort_by` | 同一查询参数集维护两份；后端加参数 generated 文件更新但 `JobFilters` 不动 → 前端无法传新参数 | `useJobs` 改用 `JobsListQuery` 类型；`JobFilters` 别名化 |
| FD-14 | P3 | perf | `agentConnection.tsx:87-91` | `refreshInterval: 15000` 每 15s 轮询 connections，即使窗口隐藏也继续（SWR 默认 `refreshWhenHidden=false` 故隐藏时停 — 见下） | 实际 SWR 默认行为掩盖了问题；但 `useCareerTasks`(hooks.ts:354-363) 8s 常驻 + `useScraperTasks` 15s 常驻 + connections 15s — 常驻 3 个轮询器无统一调度 | 可接受；建议统一 `refreshWhenHidden/offline` 策略注释。降级 P3 |
| FD-15 | P3 | bug | `agentConnection.tsx:159-175` payload | `entity_id: selection ? String(selection.id) : routeEntity.entity_id` — selection 优先于路由 | WorkbenchShell 在 pathname 变化时 `clearSelection()`，已闭环；**但** selection 与路由不同步的中间帧（同页切换选中项从 job:A 到 application:B）写入顺序依赖 250ms debounce + 串行队列，正确；残留风险仅 `title` 用 `selection.title` 无 fallback 校验 | 当前实现经得起对抗审查；`retry` 计数放 effect deps（188 行）会在每次 retry 重入队同一 payload — 符合预期 |
| FD-16 | P3 | arch | `hooks.ts` 整体 | 3185 行、206 个导出、横跨 20 个业务域（jobs/pools/email/resume/profile/ai-optimize/applications/tables/scraper/boss/interview/progress-board/draft/optimize-sessions/calendar/config/notifications/automation/career-tasks/templates） | god-file：类型定义与 hooks 与 mutation 与 SSE 流全混在一个模块；任何域改动都碰这个文件，merge 冲突与审查盲区源头 | 拆分建议见下 |

## hooks.ts 拆分建议

按现有 `// ----` 注释天然分界，拆为 `lib/data/` 目录，每个域一个文件，`hooks.ts` 先转 re-export 桶、再逐调用方迁移删除：

```
lib/data/
  _shared.ts        # API_BASE, fetcher, showcaseFetch, ApiError, formatBackendNetworkError, SSE reader
  jobs.ts           # Job/Pool/BatchSummary/JobFilters + useJobs/useJob/usePools/... + patchJob(s)/pools CRUD (≈L77-516)
  calendar-email.ts # CalendarEvent/Notification + useCalendarEvents/useNotifications/email 同步 (≈L139-163,553-653)
  config.ts         # useConfig/updateConfig/saveBossCookie (≈L414-419,520-536,1950-1974)
  resume.ts         # Resume*/sections/templates/upload (≈L656-805,1298-1394,1881-1894)
  profile.ts        # Profile*/chat/stream/import (≈L805-1205)
  ai-optimize.ts    # Ai*/analyze/batch-optimize/optimize-sessions/3个SSE流 (≈L1207-1478,1976-2392)
  applications.ts   # Application*/workspace/tables/records (≈L1480-1894)
  interview.ts      # Interview*/AIInterview*/focus (≈L2394-2880)
  progress.ts       # ProgressBoard*/candidates/timeline (≈L2976-3185)
  ingest.ts         # ingestJob/hashJobInput/automation inbox/career tasks (≈L165-232,341-411,2523-2566)
```

同时进行的收敛（与拆分同 PR 或紧随其后）：
1. **消灭双数据层**：`api.ts` 保留 `request()`/`readEventStream()`/`streamResult()` 三个底层原语 + 手写 domain interface；`lib/data/*` 的 SWR hooks 与 mutation 全部改走 `api.ts` 原语，`showcaseFetch`/`fetcher`/`formatBackendNetworkError` 从 hooks.ts 删除。迁移顺序：先 `_shared.ts` 落地 → `jobs.ts`（验证样板）→ 其余域逐个搬 → 最后删 `hooks.ts`。
2. **统一错误 shape**：`class ApiError extends Error { status, errorId, detail }`；`request()`、`showcaseFetch` 后继者、SSE 三个入口全部抛它；`safeClientErrorMessage` 只做展示层脱敏。
3. **SSE 单实现**：保留 `api.ts:readEventStream` 的 `event:`/`data:` 解析（兼容 `data: x` 带空格），让 5 个 hooks.ts SSE 函数改成薄封装只传 `onEvent`。
4. **响应类型**：后端给高频端点补 `response_model`，generated 文件才有价值；否则 `api-typed.ts` 注释降级为「请求体类型」。

## Top-5 修复优先级

1. **FD-01/02/03**：4 个写操作吞 HTTP 错误 → 假成功（updateApplication / generateCoverLetter / reorderSections / uploadResumePhoto / uploadResumeLogo）。改动小、用户可见的正确性问题。
2. **FD-06**：`redirect:"error"` + FastAPI redirect_slashes — 现在靠路径恰好对齐没炸；任何一处新端点尾斜杠不一致就会报成「后端没启动」，误导排查。
3. **FD-09**：6 份 SSE 手写解析，`batchOptimizeResume` 的 `event: `（带空格）解析丢事件 + 无 `done` 返回空成功。
4. **FD-05**：双数据层收敛 — 是 FD-01~04 这类错误的结构性根源。
5. **FD-04**：`readEventStream` 网络错误未翻译 + 用错误文案字符串匹配（`__SSE_UNAVAILABLE__`/`API Error: 404`）驱动重连分支 — 脆弱。

## 已达标的点（简短）

- `agentConnection.tsx` 单写入者串行队列（`queued`/`inFlight`/`sequence`）设计正确：last-writer-wins、并发不会互相覆盖、abort+10s 超时、`mounted` 守卫齐全；AGENTS.md 双写问题已真正闭环（WorkbenchShell 路由切换清 selection + `entityFromRoute` fallback 补直开详情页）。
- `safe-error.ts` 凭证/PII 脱敏正则体系完善，且被多数 mutation 正确使用。
- `useCareerTasks`/`useEmailSyncRuns`/`useScraperTasks` 的条件轮询（有活跃任务才高频）是正确做法。
- `apiBase.ts` 对非本地 origin 的注入式 `VITE_API_URL` 拒绝是合理的 local-first 硬化。
- `controlCareerTask` 的两段式（projection → confirm）写边界在客户端正确实现。
