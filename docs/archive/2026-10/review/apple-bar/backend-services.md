> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Backend Services 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

核心服务的工程纪律远超一般开源项目——fail-closed 钥匙串、哈希校验备份、提案审核账本都做得扎实——但仍有三处「静默假成功」会让用户以为系统在工作而实际数据已丢/已腐坏（embedding 零向量、distill 烧掉观察、web_search 全灭返空），以及一条可以绕过事实门直写/改写职业档案的公开路由；距 Apple 级「错误永远可见」还差一层。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| SVC-01 | P1 | bug | `backend/app/services/memory_distiller.py:316-330` | `if candidates: new_content["memory_candidates"]=...` 后 **`row.distilled_at = _now()` 无条件执行** | LLM 调用失败（`chat_completion` 返回 `None`）或 `extract_json` 失败时 `candidates=[]`，观察仍被标记 `distilled_at`；下次 distill 循环 `where(distilled_at.is_(None))` 永远跳过它。一次 provider 故障把批内全部观察的提炼机会永久烧掉——静默数据丢失，用户无感知。 | 只在 `candidates` 非空时写 `distilled_at`；LLM 失败路径记录 `distill_error`/`retry_count` 并保持 `distilled_at=None`，下次重试；或将失败观察计数进返回值 `errors` 字段暴露给调用方。 |
| SVC-02 | P1 | bug | `backend/app/services/semantic_search.py:114-120`；`backend/app/agents/llm.py:696` | `except Exception` → `return [0.0] * EMBEDDING_DIMENSION` | embedding API 失败时返回零向量并 **照常 upsert 进 Qdrant**。索引"成功"但向量是垃圾：零向量与零向量 cosine=1，互相污染召回；且 `_embedding_cache` 在 try 外还是内？（line 111 在 try 内，缓存不写——但 upsert 已写入坏向量）。同样模式在 `get_embedding` 尾部。 | embedding 失败应抛错/返回 `None`，让 `index_*` 跳过该条并计入指标；至少不要把零向量写库。向量索引质量类故障必须有可见计数。 |
| SVC-03 | P1 | design | `backend/app/services/profile_operations.py:565-628` + `backend/app/ops.py:3580-3603` + `backend/app/routes/profile.py:1533-1546` | `create_profile_section`/`update_profile_section` 注册为普通 write Operation 且挂公开 HTTP 路由；**无 source_text、无 fact gate、无 preference_confirmation 校验** | AGENTS.md:62 承诺「Agent 推断、简历建议不能直接成为职业事实」。`add_profile_evidence`（agent_operations.py:1454-1585）实现了完整门（fact gate + preference 门 + 去重），但这两条 Operation/路由整体绕过：任何内容可直写 `ProfileSection`（`source=任意字符串`），`update_profile_section` 还能改写已审核条目的 `content_json` 而不重新过门——审核通过的事实可被后门改写。 | `create/update_profile_section` 若定位是「用户手动编辑」需：(a) 强制 `source="manual"` 且 tier 受限；(b) `update` 时对含 `_agent_provenance` 或 evidence-link 的条目拒绝改写或重走 fact gate；(c) 从 agent 可发现 operation 面剔除（检查 `list_operations` 暴露面）。 |
| SVC-04 | P1 | ux | `backend/app/services/web_search.py:251-265` | 全部 provider 失败 → `errors` 仅 `_logger.warning` → `return []` | 调用方拿到 `[]` 无法区分「无结果」vs「provider 全灭/欠费/key 失效」。`job_research._collect_backend_research:1830` 用 `if not pages: raise` 兜底了，但 `role_intelligence.py:1134` 同样消费——空结果会被当成「网上没有该公司信息」进入 LLM 上下文 → 产出无依据结论。假成功。 | `web_search` 返回 `{"results": [...], "provider_errors": [...]}` 或在全灭时抛错；至少把 errors 透传进返回结构让调用方能展示「搜索服务不可用」而非「没有找到」。 |
| SVC-05 | P2 | bug | `backend/app/agents/llm.py:454-465` | `except asyncio.TimeoutError → return None`；`except Exception → return None` | provider 超时/鉴权失败/限流（重试 3 次后）全部被压平为 `None`。调用方（ai_interviews.py:515/942/1495、job_research.py:1860、memory_distiller.py:306）统一报「模型未返回可解析的 JSON」——把**基础设施故障误诊为模型输出故障**，用户排障方向被误导。错误分类丢失。 | `chat_completion` 返回结构化结果 `{text, error_kind}` 或对 transport 层错误抛 `LLMUnavailableError`（保留重试后）；解析失败才返回 None。调用方区分「服务挂了」与「输出坏了」。 |
| SVC-06 | P2 | ux | `backend/app/services/email_sync.py:1193-1220` | except 后 `stored_account.last_error = safe_error`（固定文案「邮箱增量同步失败…」），真实异常只留 `error_type` 名进 trace_json | 所有失败原因（auth 失效、网络、IMAP 协议错、Gmail history 过期后的二级故障）对用户显示同一句文案。`trace_json.error_type` 有类型名但 `_run_payload` 是否透出未验证 [INFERENCE: 多半不透出]。用户无法自助修复（重新授权 vs 检查网络）。 | `safe_error_message(exc)` 已做脱敏，应把脱敏后的真实原因写入 `stored_run.error`/`account.last_error`；通用兜底文案留给 UI 未分类错误。 |
| SVC-07 | P2 | bug | `backend/app/services/email_sync.py:1420-1428` | `_email_sync_loop` 中 `except Exception: pass`（无日志） | 后台同步循环任何系统性故障（DB 断、全局 bug）每周期静默吞掉，永远无人知道——唯一的可见性是「同步再也没发生」。`sync_email_notifications:1242` 的 per-account `except Exception: failed += 1` 也只计数不记原因。 | loop 层至少 `_logger.exception`；per-account 失败把 `safe_error_message` 汇总进返回 dict（已有 `runs` 字段可挂 `errors`）。 |
| SVC-08 | P2 | bug | `backend/app/services/authorized_research.py:517-518, 549-551` | `page_url` 来自 `_platform_url()`（line 109 `urlunsplit` 丢弃 query/fragment）→ `capture.url` 与 `content_hash` 用净化后 URL | 证据 URL 丢失 query 参数：`zhipin.com/job_detail?id=ABC` 存为 `.../job_detail`。审计回放时无法定位真实页面；不同 query 页面相同 excerpt 会误判 dedup。只读采集的安全意图是防跳转，但证据定位器被削得太狠。 | `capture.url` 保留完整 URL（含 query）；`_platform_url` 仅用于域名校验；hash 同样按完整 URL+excerpt 计算。 |
| SVC-09 | P2 | bug | `backend/app/services/authorized_research.py:970-973` | `return {..., "scrubbed_capture_count": True}` | 字段名叫 count，值是布尔 `True`。API 契约说谎；前端如按数字展示会显示 `true`。 | 返回实际删除条数（`delete()` 前 select count）或改名 `captures_scrubbed: true`。 |
| SVC-10 | P2 | ux | `backend/app/services/llm_secret_vault.py:54-55, 176-206` | `_is_masked = "*" in value`；`_dehydrate_config_item` 先 `item["api_key"]=""` 再判 masked → 无 existing_ref 且 deterministic ref 解析不到时 `credential_ref=""` | 含 `*` 的真实 API key（部分 provider key 允许 `*`）被当成前端脱敏回传 → 既不进钥匙串也不落盘 → **key 静默蒸发**，保存返回成功。 | masked 判定加更严格签名（如 `*` 占比/长度阈值，或与 stored ref 的 mask 形态比对）；无法归类时拒绝保存并报错，不静默丢 key。 |
| SVC-11 | P2 | ux | `backend/app/services/ai_interviews.py:1298-1299` | `except Exception: proposal_result = {"ok": False}` → report 写 `learning_candidate.status="failed"` | 提案创建失败原因完全丢失，只留「暂时未生成」。低危因有 `recover_interrupted_interview_state` 重试路径，但失败类别（DB vs 校验）不可见。 | `proposal_result` 捕获 `safe_error_message(exc)` 进 report；或记录 error_id。 |
| SVC-12 | P2 | arch | `backend/app/services/email_sync.py:78`；`backend/app/services/authorized_research.py:68-69`；`backend/app/services/ai_interviews.py:1532` | `_ACCOUNT_LOCKS`/`_LIVE_BROWSERS`/`_LOCKS` 模块级 dict 只增不删（locks 无淘汰） | `_LOCKS.setdefault(clean_id, asyncio.Lock())` 每个面试 id 一把锁永驻；`_ACCOUNT_LOCKS` 同型。长时间运行内存缓慢增长；多实例部署时锁还失效 [INFERENCE: 单机桌面应用，影响有限]。 | `WeakValueDictionary` 或按活跃集合清理；至少 document 单机前提。 |
| SVC-13 | P3 | design | `backend/app/services/career_memory.py:356-357`；`backend/app/services/profile_operations.py:626-627`；`backend/app/services/memory_distiller.py:178-179, 202-203` | `_index_observation_vector` / `index_profile_section` / `_related_observation_context` 三处 `except Exception: pass` 无日志 | 「best-effort 向量索引静默跳过」是注释明的意图，但零日志意味着 Qdrant 挂了几个月也没人发现——语义搜索悄悄退化为 SQL LIKE 甚至空上下文。 | 静默降级可以，但需要：一次性 warning + `status()` 可查询的降级计数（vault `status()` 已是范例）。 |
| SVC-14 | P3 | ux | `backend/app/services/data_safety.py:212, 249, 443` | `DataSafetyError(f"SQLite 完整性检查失败: {exc}")` 等把底层异常直接拼进消息 | 其余地方都走 `safe_error_message`；这里 sqlite/zip 异常原文透出（含文件路径）。本地应用风险低，但与模块自身标准不一致。 | 统一走 `safe_error_message` 或脱敏路径。 |
| SVC-15 | P3 | ux | `backend/app/services/llm_secret_vault.py:39, 129-133, 316` | `_hydrate_errors` 全局 list，`hydrate()` 每次 `clear()`；`status()` 60s 缓存但 `hydrate` 重置 `_status_cache` | 多读者共享一个可变全局：runtime_credentials `load_scraper_cookie` 也调 `hydrate`（runtime_credentials.py:34）→ 读 cookie 会清掉别处刚攒的 hydrate 错误 → `/api/config` 的 `vault_status` 漏报。 | `_hydrate_errors` 按调用方区分或改为计数+最近错误的时间窗结构，不被无关 hydrate 调用清空。 |
| SVC-16 | P3 | design | `backend/app/services/optimize_agent_operations.py`（legacy 会话优化器）vs `backend/app/services/resume_optimization.py` + `resume_optimize_support.py`（新管线） | 两套简历优化实现并存，`ops.py` 同时注册两边 Operation | 平行实现必漂移：fact gate 规则、section 规范化各处一份。`resume_optimize_support` docstring 自称「one implementation for all callers」，但 legacy optimizer 仍走 `app.agents.optimize_agent` 自有管线。 | 收敛到一套 fact-gate/规范化核心；legacy 会话层只做编排，或标记弃用时间表。 |
| SVC-17 | P3 | ux | `backend/app/agents/llm.py:441-452` | `max_completion_tokens=max_tokens*3` 先尝，仅当错误消息含 `"max_completion_tokens"` 才回退 | 用错误消息子串做能力探测：网关若返回英文以外的措辞（如 `unsupported_parameter`）会被 `raise` 不再回退 → 某些 provider 上 reasoning 预算直接 400 死掉。 | 检查 `exc` 的结构化字段（`openai.BadRequestError` param）或按 provider 能力表选择参数名。 |
| SVC-18 | P3 | perf | `backend/app/services/authorized_research.py:193-228` | `_schedule_expiry` 每会话一个 `asyncio.sleep(delay)` task；`stop` 时 gather | 设计 OK（任务数小）。但 `_expire_session` 在 `asyncio.sleep` 里被 cancel 后，`finally` 只清 `_EXPIRY_TASKS`；若 cancel 落在 sleep 与 DB 写之间，session 停留 active 状态直到 `recover_authorized_research_sessions` 下次启动兜底——可接受但留痕。 | expiry task 内 sleep 分段或 catch CancelledError 时也把状态落库为 interrupted（当前靠重启恢复，已够）。 |
| SVC-19 | P3 | doc | `backend/app/services/email_sync.py:1156` | `result_payload` 硬编码 `"failed": 0`、`"calendar_created": 0` | 字段是死值占位（功能未实现/预留），API 消费者看到永远是 0 会以为「日历集成可用但没建事件」。 | 从 payload 删除未实现字段，或改名 `_reserved`；在 schema 文档标注。 |
| SVC-20 | P3 | arch | `backend/app/services/agent_operations.py` 整体 | ~2500 行中约 2/3 是 `from app.services.X import Y; return await Y(...)` 的转发器 | 文件名为 agent_operations 实为 operation 转发集合——巨型 facade 增加了导航成本但不产生行为问题；好在委托都是 lazy import 避免循环依赖。 | 长期按域拆到各 services 模块、ops.py 直接引用目标函数；短期可接受。 |

## 已验证的关键不变量（结论）

- **review-candidate 门（AGENTS.md:62）主路径成立**：`career_memory.review_memory_proposal`（career_memory.py:997-1339）是唯一能 promote 的路径，accept 时先置 `applying`、走 `add_profile_evidence` fact gate、失败回滚 `pending`，源码失效可撤销已写条目（1248-1269）；`invalidate_memory_source` 级联失效观察/链接/提案/条目（1342-1455）。`consolidate_memory_observations` 只产提案不写 Profile。**但 SVC-03 的 `create/update_profile_section` 路由构成了绕过通道**。
- **vault fail-closed 成立**：`write_key`/`_dehydrate_config_item`/`dehydrate` 三处写钥匙串失败都抛 `VaultUnavailableError`（llm_secret_vault.py:99-100, 217-218, 274-275），`save_llm_config_file` 回滚已建 ref（llm_config_store.py:105-108），`import_provider` 捕获后返回 ok=False（llm_config_store.py:473-480）；keyring 后端白名单限定 OS 原生（credential_store.py:13-22）。明文迁移 `migrate_plaintext` 走 dehydrate 同一不变式。
- **超时/取消**：`chat_completion` 用 `asyncio.wait_for`+限 3 次指数退避，`CancelledError`(BaseException) 可穿透所有 except 层；`authorized_research` expiry task、email_sync loop、`_expire_session` 都正确 re-raise `CancelledError`。
- **data_safety 是本批次最强文件**：备份全程哈希校验+manifest 成员白名单+symlink 拒绝+原子替换+自动回滚（631-694），fail-closed 且 pending marker 损坏时拒绝启动。

## Top-5 修复优先级

1. **SVC-01**：`memory_distiller` LLM 失败也打 `distilled_at`——静默烧观察，一行修复（只在 candidates 非空时标记 + 失败计数透出）。
2. **SVC-03**：`create/update_profile_section` 绕过事实门——要么收紧为 manual-only+tier 限制，要么对已审核条目强制重走 gate；这是「AI 推断不直接成为事实」承诺的直接漏洞。
3. **SVC-02**：embedding 失败写零向量进 Qdrant——污染召回，改抛错跳过即可。
4. **SVC-04+SVC-05**：`web_search` 全灭返 `[]` 与 `chat_completion` 全错返 `None`——同一「假成功」家族：让 transport 错误可区分、可透出。
5. **SVC-06/07**：email_sync 失败原因被通用文案覆盖+后台循环静默 pass——同步坏了用户永远不知道原因。

## 已达标的点（简短）

- 钥匙串边界：真正 fail-closed，含回滚、探测缓存、env:VAR 例外、masked 回传防护（SVC-10 除外）。
- 记忆提案账本：状态机完备（pending/deferred/applying/accepted/rejected/revoked/invalidated/superseded 链），级联失效与取代链回环检测都有。
- 授权浏览：域名白名单+只读路由守卫+摘录最小化+凭据零持久化，是「登录态调研」的教科书式实现。
- 数据安全：备份/恢复的正确性工程（哈希、原子、回滚、拒绝 symlink）达到发布水准。
- 幂等：idempotency_key + IntegrityError 重读路径在 observation/proposal/automation/email 各处一致实现。
