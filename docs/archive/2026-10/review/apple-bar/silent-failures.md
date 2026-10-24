> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 静默失败 / 假成功 / 错误吞没 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

错误处理的「骨架」大体合规（Operation 信封、event_warning 持久化、前端 `safeClientErrorMessage` 渲染），但存在两类真实差距：**一个用户可见的静默降级**（interview 提炼失败被 `catch {}` 吞掉，用户看到空题库不知道失败过）、**两处无日志的后台任务吞错**（email 周期同步、work-source 自动同步的循环体），以及 AGENTS.md 红线的一个「已修但脆弱」点（capability probe 吞 OSError/TimeoutError 且无 error 字段记录探测失败本身）。假成功面不大，但「成功」里混着用户无感的降级结果（instant-draft 回退到模板、smart-fill 回退到 NONE、skill 路由回退 deterministic、scraper 详情页 enrich 失败返回无 JD 的结果）——这些都返回 200 但内容质量下降且无可见标记。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|---|---|---|---|---|---|---|
| SF-1 | P1 | bug | `frontend/src/app/interview/page.tsx:111-113` | `try { await extractQuestions(result.id); } catch {}` | 用户粘贴面经提交后，提炼面试问题失败被完全吞掉；模态框正常关闭、字段清空、列表刷新——用户看到一条「面经已收录」但题库里永远没有这次的问题，无任何提示。这是「用户会看到成功但其实失败」的直接实例。 | 复用 `handleExtract` 同款错误路径：`setInterviewError(safeClientErrorMessage(error, "提炼失败"))`；或复用 `handleExtract(result.id)` 调用并依赖其错误展示。 |
| SF-2 | P1 | bug | `backend/app/routes/profile.py:1741-1747` | `except Exception: pass` 后静默落回内置模板草稿（`profile.py:1749-1761`） | `/api/profile/instant-draft`：LLM 草稿生成失败时返回 200 + 模板化假草稿（`"负责{exp}相关事项…[具体成果待补充]"`），响应里没有 `generated_by`/fallback 标记，前端无区分路径。这是「返回成功但实际未执行（且内容降级）」。 | 返回体加 `source: "llm"|"template_fallback"` + 可选 `fallback_reason`；或 LLM 失败时直接 502 让前端走手填路径（前端无调用方，可直接改契约）。 |
| SF-3 | P1 | bug | `backend/app/services/agent_skill_registry.py:228-250` | `except Exception: pass` → `return fallback_skill(fallback_mode), "deterministic_fallback"` | Agent skill 路由：LLM 路由失败静默回退 deterministic skill，用户消息被路由到错误 skill 且 trace 只记 `deterministic_fallback` 字符串、无失败原因。Provider 故障被埋进正常响应。 | 在返回的 reason 中附 `router_error`（脱敏后），并在 run trace 中记录 `skill_router.failed=true`；前端 AgentPanel 可在 metadata 里显示。 |
| SF-4 | P1 | bug | `backend/app/routes/profile.py:2656-2667` | `except Exception: pass` → `return {"ok": True, **result}`（result.matchType=="NONE"） | smart-fill option-match：AI 兜底匹配失败静默返回 `ok:true` + `matchType:"NONE"`，前端把「没匹配上」和「AI 尝试但挂了」混为一谈；用户看到无建议而非错误。 | AI 匹配失败时返回 `ok:true` + `ai_match_error` 字段（或 `matchType:"NONE_ERROR"` 约定），前端至少 toast 一次。 |
| SF-5 | P1 | bug | `backend/app/routes/profile.py:1314-1333` | `except Exception: parsed=None` → 落回 `_fallback_resume_candidates`（正则启发式） | 简历导入抽取：LLM 抽取失败静默退化为启发式候选，响应结构与 LLM 成功完全相同（`{"base_info", "candidates"}`），用户拿到的候选质量骤降但无任何提示。 | `candidates` 同级加 `extraction: "llm"|"heuristic_fallback"`；或失败时抛 502（前端 ProfileOnboarding 已展示错误横幅）。 |
| SF-6 | P2 | ux | `backend/app/services/coding_agent_runtime.py:462-463` | `except (OSError, asyncio.TimeoutError): pass`，结果字段 `available=bool(version)` 无 `probe_error` | AGENTS.md 红线的原始事故点（探测超时→批量误判 incompatible）。超时已提到 20s，但探测失败本身仍无日志、无 error 字段——CLI 挂/超时/OSError 与「二进制不存在」在响应里不可区分，下一次同类事故还会表现为静默误判。 | `result` 加 `probe_error: str`（脱敏），失败时 logger.warning；前端连接页把 `probe_error` 透出来。 |
| SF-7 | P2 | bug | `backend/app/services/email_sync.py:1422-1427` | `_email_sync_loop`：`except Exception: pass` 后 `await asyncio.sleep(interval)` | 周期同步循环每轮吞所有异常且无日志。单个账户失败已持久化（`sync_email_account` 1193-1220 写 `stored_run.status="failed"`），但循环体级的异常（DB 连接断、账号列表查询失败、`sync_email_notifications` 顶层异常）完全无日志无告警——可造成「同步服务看起来在跑但实际什么都没干」的假运行态。 | `except Exception as exc: logger.error("email sync iteration failed: %s", safe_error_message(exc))`；必要时接 health 指标。 |
| SF-8 | P2 | bug | `backend/app/services/work_sources.py:1039-1053` | 内层 `except Exception: continue`（单源同步失败跳过）+ 外层 `except Exception: pass`（整轮失败吞掉） | 工作源自动同步循环：单源 `start_work_source_sync` 抛错只 `continue`，整轮 DB 查询/迭代异常 `pass`，两处均无日志。与 SF-7 同型假运行态。 | 两处各加 `logger.error/warning`（含 source.id / iteration 标记）。 |
| SF-9 | P2 | ux | `frontend/src/app/optimize/components/OptimizeWorkspace.tsx:136-140` | `catch { setJobs([]); setJobsTotal(0) }` | 岗位列表加载失败渲染为「0 个岗位」而非错误态——用户把加载失败看成空池子，对后续批量优化是假输入。 | `setJobsError(safeClientErrorMessage(err, "岗位加载失败"))` + 条件渲染错误条，与 `loadingJobs` 并列。 |
| SF-10 | P2 | ux | `backend/app/services/agent_operations.py:2133-2147`, `application_workspace.py:662-683`, `861-876`, `application_progress.py:981-1004` | `application_event_store.record` 失败 → `event_warning = safe_error_message(exc)` 挂在响应里 | 投递记录/状态变更的业务事件埋点失败：主操作成功但事件没记上，仅 `event_warning` 字段承载。需确认前端是否展示该字段——若只进 JSON 不落 UI，则是「事件静默丢」的 P1。 | [INFERENCE 待验证] 前端若未消费 `event_warning`，至少在响应调用点统一映射成一条非阻塞 toast/日志；服务端同时 `logger.warning`。 |
| SF-11 | P2 | bug | `backend/app/services/scrapers/shixiseng.py:171-172`, `zhilian.py:261-262` | 详情页 enrich `except Exception: pass`（并发 worker） | 爬虫详情页增强失败静默返回无 `raw_description` 的 JobItem——下游以「有 URL 但无 JD」的假完整数据进库，影响 LLM 评估输入质量且无来源标记。 | enrich 失败时 `item.enrichment_failed = True`（或 logger.debug 一行汇总计数）；search 结果可加 `enriched: n/total` 元数据。 |
| SF-12 | P2 | bug | `backend/app/services/scrapers/corporate.py:63-73` | 每个 keyword 搜索 `except Exception: continue` | 企业爬虫单关键词失败静默跳过——公司官网 API 挂时返回部分关键词的空结果集，与「真没岗位」不可区分。 | 失败 keyword 计数进 result metadata（`failed_keywords: n`）或 logger.warning 一行。 |
| SF-13 | P3 | design | `backend/app/routes/resume.py:1499-1503`, `1544-1548` | Playwright 渲染失败 `except Exception:` 落回 WeasyPrint/ReportLab | PDF/图片导出静默降级渲染引擎——输出可能视觉不同但用户无感知；两路全挂才报错（1504-1512, 1554-1558 已 fail-closed）。 | 降级路径在响应头加 `X-OfferU-Export-Renderer: playwright|fallback`，或日志 warning 一次。 |
| SF-14 | P3 | design | `backend/app/services/memory_distiller.py:168-179`, `454-470`; `profile_operations.py:617-627`, `671-681`; `career_memory.py:335-357` | 语义检索/向量索引失败 `except Exception: pass` → SQL LIKE 降级或直接跳过 | 向量层不可用时静默降级：召回质量下降但无 trace 标记，profile 段落创建/更新后向量索引可能永久缺失而无重试路径。 | 降级处写 `logger.debug`（不刷日志量），并把「向量不可用」反映到任一 status/diagnostics 面；索引失败可考虑进入 retry 队列。 |
| SF-15 | P3 | design | `backend/app/services/ai_interviews.py:1812-1828` | `resolve_scoring_skill` 失败 `except Exception: pass` → `filtered_summary = summary`（未过滤） | 行为事件摄入时若 scoring skill 解析失败，本应过滤的报告面板原样全量下发——降级方向是「多给」而非「少给」，虽非假成功但绕过了展示边界。 | 失败时按 `always_kept` 白名单过滤（保守降级），并记 `filtered_by: "fallback"`。 |
| SF-16 | P3 | ux | `frontend/src/components/ai/ProfileAgentDock.tsx:97-99`, `frontend/src/components/workbench/AgentPanel.tsx:244-246`, `frontend/src/components/workbench/InspectorPanel.tsx:105-106` | 历史会话/对话列表 `catch { setX([]) }` | 加载历史失败渲染为空列表而非错误——与 SF-9 同型，把「加载挂了」显示成「没有历史」。 | 各加一行 `setError(...)` 或保留前值 + 轻提示；批量收敛到统一的 `loadOrError` 工具。 |
| SF-17 | P3 | ux | `frontend/src/components/workbench/AgentPanel.tsx:384-388`, `465-468` | abort/恢复 Run `catch { /*注释*/ }` | 「新对话仍可开始」的 abort 失败与「没有可恢复 Run」的恢复失败都静默——语义上可接受但无遥测，真出问题时看不到链路。 | 至少 `console.warn`；abort 失败可在 UI 侧记 `lastAbortFailed` 供诊断面板读取。 |
| SF-18 | P3 | design | `backend/app/services/agent_runtime.py:648-656`, `batch_job_evaluations.py:455-464`, `agent_conformance.py:678-681`, `731-732` | 健康持久化/批任务收尾/探测报告持久化的 `except Exception: pass` | 「诊断数据落库失败不掩盖主结果」语义正确，但全部无日志——诊断设施本身的故障不可见。 | 统一加 `logger.debug` 单行；这些是辅助路径，不需要重试。 |
| SF-19 | P3 | doc | `backend/app/services/diagnostics.py:216-219`, `main_agent_guardian.py:115-118`, `agent_run_state.py:33-36`, `harness_memory.py:63-66`, `llm_secret_vault.py:103-110`, `authorized_research.py:179-190`, `coding_agent_runtime.py:389-408`, `pi_agent_worker.py:158-161`, `codex_adapter.py:196-208`, `database.py:96-99` | 资源清理/探针删除/回滚辅助路径的 `except Exception: pass` | 均为正确的「清理失败不掩盖主错误」模式，但全部裸 `pass`——若清理持续失败（如钥匙串残留累积、临时目录膨胀）完全无信号。 | 低风险统一 `logger.debug` 兜底；`database.py:96-99` 回滚失败已升级为 `DatabaseMigrationError`（正确）。 |
| SF-20 | P3 | ux | `backend/app/routes/config.py:455-459`, `llm_config_store.py:197-199` | `config.json` 损坏 → `logger.warning` + 默认配置 | 有日志但用户面不可见——LLM 配置损坏时静默跑默认配置，设置页看不到「配置文件坏了」的横幅。 | `/api/config` 响应加 `config_load_warning` 字段透给设置页（已有 `vault_status` 同款先例）。 |

## Top-5 修复优先级

1. **SF-1**（interview 提炼静默失败）— 最直接的「用户看到成功但失败」；单行改动，前端已有同款错误路径可复用。
2. **SF-6**（capability probe 无 error 字段）— AGENTS.md 红线的原始事故机制仍在（超时加大只是缓解）；加 `probe_error` + warning 日志让下一次误判可见。
3. **SF-2 + SF-5**（instant-draft / resume-extract 静默降级为模板/启发式）— 返回假高质量结果；至少加 `source`/`extraction` 标记字段。
4. **SF-7 + SF-8**（email sync / work-source 循环体裸吞）— 假运行态，后台任务「在跑但没干活」无法被发现；各加一行 `logger.error`。
5. **SF-3 + SF-4**（skill 路由 / option-match 静默回退）— Agent 决策路径上的 provider 故障被埋；trace/响应里附失败原因。

## 已达标的点（简短）

- **Operation Registry 信封（ops.py:4891）**：异常统一落成 `ok:false` + `errors[]`，路由层 `_execute_operation`/`_operation_output_or_error` 一致抛 HTTP 错误，前端 `request()` 把非 2xx + `ok:false` 都转成 throw——主链路没有假成功。
- **event_warning 模式（application_workspace.py:682, 875; agent_operations.py:2147, 2487; application_progress.py:1004; resume_route_operations.py:694）**：埋点失败如实挂字段，语义正确（仅需前端消费确认，SF-10）。
- **email_sync.py:1193-1220**：单账户失败持久化 `stored_run.status="failed"` + `last_error`，UI 可查——失败不是假成功。
- **ai_interviews.py:1298-1321**：proposal 失败 `report["learning_candidate"]={"status":"failed"}` 落库，可见。
- **agent_conformance.py:656-732**：live/lifecycle probe 失败显式 `failure_state` + `failure_reason` + 持久化 error——红线「provider 失败必须可见」在新代码里被遵守。
- **database.py:96-105**：迁移回滚失败升级为 `DatabaseMigrationError`，fail-closed。
- **llm_secret_vault.py:95-100**：写钥匙串失败 `raise VaultUnavailableError`（fail-closed，符合「绝不回退明文」红线）。
- **data_safety.py:669-686**：恢复失败自动回滚，回滚失败 `raise DataSafetyError`——备份路径无静默。
- **前端今日页/岗位详情/设置页**：抽查的 6 个调用点全部 `setXError(safeClientErrorMessage(...))` 渲染，SWR 错误有对应 UI 条。
- **resume.py:1550-1558**：导出全链路失败 `raise HTTPException(500)`，fail-closed。
