> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# 后端数据层（database.py / models.py / SQLite）对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

数据层“能跑但不可信赖”：118 MB 生产级数据跑在 rollback-journal（非 WAL）+ 零 busy_timeout 的单写者 SQLite 上；`applications`/`application_attempts` 双轨并存且 legacy 接口显式标注“不移除”；17 个外键缺 `ondelete` 策略导致「清空回收站」对任何有投递/面试记录的岗位必然 IntegrityError；4 张孤儿表与 1 个幽灵批次（136 个岗位）漂在库中无人认领。离 Apple 水准的「数据完整性 = 不言而喻的正确」还差一次认真的 schema 收口。

## DB 健康检查（sqlite3 只读打开 `backend/djm.db`，118.5 MB / 28937 pages）

| 检查项 | 结果 |
|---|---|
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 行违规（当前无悬空 FK 行） |
| `PRAGMA user_version` | 3（= CURRENT_SCHEMA_VERSION） |
| `PRAGMA journal_mode` | **`delete`**（非 WAL） |
| `PRAGMA synchronous` | 2（FULL） |
| `PRAGMA busy_timeout` | 新连接为 30000ms（引擎连接未设置，aiosqlite 默认 0） |
| `PRAGMA freelist_count` | 0（无碎片） |
| 表数量 | DB 74 张；ORM 定义 68 张（models.py 66 + html_resume.py 2）+ **6 张无 ORM/无代码引用的孤儿表** |
| 行数热点 | jobs=477, agent_runs=621, batches=200, resumes=67, resume_sections=103, interviews=45, application_attempts=68, applications=0, application_stage_events=0, pools=0 |

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|---|---|---|---|---|---|---|
| DL-01 | P1 | bug | `backend/app/ops.py:4365-4368` `delete_jobs_batch_operation` + `models.py:831,851,1604,1467,1447,1394,809` | `PRAGMA foreign_key_list`：`applications.job_id`、`application_attempts.job_id`、`interviews.target_job_id`、`interview_questions.job_id/experience_id`、`interview_experiences.job_id`、`application_records.job_ref_id`、`calendar_events.related_job_id` 全部 `on_delete=NO ACTION`；`db.delete(job)` 无任何子表清理 | 「彻底删除岗位」对任何有投递尝试/面试/面经/日历/投递记录的岗位 100% 触发 IntegrityError→操作失败。当前库 0 个 ignored 岗位所以未爆雷，但「投递→被拒→忽略→清空回收站」是标准流程，必爆 | 给 FK 补 `ondelete="CASCADE"`（attempts/applications/calendar 随岗位走）或 `SET NULL`（interviews/experiences/records 保留内容、断链岗位）；或在 op 里做 demo_data.py 那样的有序删除。推荐前者，与 AGENTS.md「按新设计直接改」一致 |
| DL-02 | P1 | arch | `backend/app/database.py:32-47` | `create_async_engine(settings.database_url, echo=False)` 无 `connect_args`；全仓 grep 无 `journal_mode`/`busy_timeout`/`pool_size` 配置；实测 `journal_mode=delete` | 单文件 SQLite 跑 FastAPI + agent-runtime + 邮箱同步三路并发写。delete 模式下写锁阻塞读；aiosqlite 默认 timeout=0 → 并发写直接 `database is locked` 而非排队。118 MB 库放大锁持有时间 | connect 事件里追加 `PRAGMA journal_mode=WAL`（持久化，一次即可）+ `PRAGMA busy_timeout=30000` + `PRAGMA synchronous=NORMAL`；verify 后保留 FULL 也行 |
| DL-03 | P1 | design | `backend/app/routes/applications.py:325-397` + `models.py:826-843` + `services/legacy_operations.py:244-279` | 注释 `---- 兼容旧接口（不移除）----`；`create_legacy_application` 写 `applications` 并 `auto_write_job_to_total` 写 `application_records`；`applications` 表 0 行 vs `application_attempts` 68 行 | 显式违反 AGENTS.md「项目尚未上线，不写旧字段兼容」。同一业务事实双轨：`applications`(legacy) + `application_attempts`(ADR-0007) + `application_records`(workspace) 三张表各自可数「投递」，`_migrate_schema_v2` 已经把 triage 收口但 Application 轨没收口 | 删除 `Application` 模型 + legacy_operations.py 中 application 三个 op + routes/applications.py 的 `/` `POST/GET/PUT/stats` 旧接口 + `applications` 表；前端如仍调用一并迁移到 attempts/workspace API |
| DL-04 | P1 | design | `backend/app/services/application_progress.py:885,900,1272,1408,1751` | `timeline[-1].stage if timeline else _normalize_stage(attempt.status)` 五处回退到可变字段；`next_event.previous_stage = selected_stage`（line 899-900）回写历史事件 | README 宣称 progress 是事件溯源，实际是混合状态：`application_attempts.status` 是可变真相源 + events 只在存在时优先；且向过去插入事件时直接改 next_event 的 previous_stage，违反 append-only。事件表 0 行也证明链路从未端到端跑过 | 二选一：(a) 真事件源——attempt.status 变为只读投影字段（写入路径只追加 event），删回退分支；(b) 承认混合——文档改口并把 previous_stage 回写改为显式 correction 事件。推荐 (a)，RESTRICT FK 已表明设计意图 |
| DL-05 | P2 | bug | `backend/app/models/models.py:671` `Resume.current_version_id`、`:1492-1493` `OptimizeSession.resume_optimization_proposal_id/research_run_id`、`:70` `Job.batch_id` | `current_version_id`/`proposal_id`/`run_id`/`batch_id` 均为裸列无 ForeignKey；实测 `jobs.batch_id='slice01-test'` 有 136 行但 `batches` 无此行 | 指针悬空无约束：`Resume.current_version_id` 指向可被 CASCADE 删掉的 `resume_versions` 行 → 悬空前端 404；136 个岗位的 batch 已被删除 → Inbox 按批次分区出现不存在的「slice01-test」幽灵分区 | 给这些列补 ForeignKey（`SET NULL` for current_version_id/optional refs，`CASCADE` or 服务端保证 for batch_id）；数据修复：给 slice01-test 补 batch 行或把 jobs.batch_id 归并到存在的批次 |
| DL-06 | P2 | perf | `models.py:706` `resume_sections.resume_id`、`:1460` `interview_questions.experience_id`、`:1467` `job_id`、`:786` `interview_notifications.created_at`、`:804` `calendar_events.start_time`、`:831` `applications.job_id`、`:790` `parsed_at` | `PRAGMA index_list`：resume_sections/calendar_events/interview_notifications/interview_questions/resumes/resume_templates 0 个用户索引；`EXPLAIN QUERY PLAN` 确认 `WHERE resume_id=?`、`ORDER BY start_time`、`ORDER BY created_at DESC` 全 SCAN + TEMP B-TREE | 简历详情页（每简历必查 sections ORDER BY sort_order）、日历区间查询、通知列表全是全表扫描。当前百行级无感，千行级即卡顿；且这些 FK 无索引也拖慢 CASCADE delete | 给上述列补 `index=True`（resume_id/experience_id/job_id/start_time/created_at）；`applications.job_id` 随 DL-03 一起删 |
| DL-07 | P2 | design | `backend/app/models/models.py:652` `Resume.is_primary`、`:304` `Profile.is_default` | `is_primary` 实测 35/67 行为 1；`is_default` 1/65；无任何唯一约束（无 partial unique index）也无应用层互斥；`resume_workspace.py:390` 只拿它做 `ORDER BY is_primary DESC` 排序提示 | 「主简历」语义已崩：35 个 primary 等于没有 primary，workspace 取「主简历」实际是按 updated_at 随机挑一个。default=True 的列默认值让每个新 resume 都自称 primary | 语义改为「最近使用」直接按 updated_at 排序删 is_primary；或保留但建 `CREATE UNIQUE INDEX ux_resumes_one_primary ON resumes(is_primary) WHERE is_primary=1` + 写入路径先清旧 primary |
| DL-08 | P2 | arch | `backend/app/database.py:35-43` vs `services/demo_data.py`、`ops.py` 等 raw `delete()` 调用点 | connect 事件只对 ORM engine 连接开 `PRAGMA foreign_keys=ON`；`_sqlite_report`/backup 用 `mode=ro`/`immutable=1` 只读连接不受限（正确）；但任何未来直连 sqlite3 的写入路径（如 scripts/）默认 FK OFF | 外层防御到位，但 FK 强制是「每连接」而非库级——`python -c` 直连写库即可绕过所有 CASCADE/RESTRICT 制造孤儿，正是 `slice01-test` 136 孤儿岗位最可能的成因 | 所有写路径统一走 engine；scripts/ 里直连 sqlite3 的写操作逐一核查加 `PRAGMA foreign_keys=ON`；CI 加 `foreign_key_check` 门禁 |
| DL-09 | P3 | design | `backend/app/routes/jobs.py:37-66,514-543` | `TRIAGE_ALIAS_GROUPS={"inbox":{"inbox","unscreened"},...}`；`/triage-counts` 返回 `{unscreened,screened,ignored,inbox,picked}` 五个键（重复计数）；`_migrate_schema_v2` 已把库里旧值全部改写 | v2 迁移后库中不存在 unscreened/screened 行，alias 层是纯粹的死兼容代码：API 双键返回、过滤双值匹配、外部契约永远背着两套命名。违反 AGENTS.md 无兼容原则 | 删 `TRIAGE_ALIAS_GROUPS`/`_to_internal_status` 别名分支，`/triage-counts` 只返回 `{inbox,picked,ignored}`；前端同步改 |
| DL-10 | P3 | arch | DB 表 `interview_sessions`/`interview_turns`/`interview_scoreboards`/`story_bank_entries` | `grep -rln` 全仓库仅 djm.db 命中；4 张表均 0 行；列结构是一套完整的「面试 session/turn/scoreboard/story bank」旧设计，现行代码用 `interviews`/`interview_messages`/`interview_evaluation_runs` | 早期面试系统的遗留 schema，代码已完全删除但表未删——按 AGENTS.md「直接按新设计修改」本应随新设计 DROP | 下个 schema migration 里 `DROP TABLE` 这 4 张；或确认还要复活则补回 ORM（不建议） |
| DL-11 | P3 | bug | `backend/app/models/models.py:148` `ResearchEvidenceSnapshot.run_id` 等、`:1548` `smartfill_run_logs.run_id`、`:948-957` `application_stage_events.candidate_id/signal_id` | `ForeignKey("job_research_runs.run_id")` —— 指向非 PK 列（run_id 是 String unique-ish 但表中 `id` 才是 PK）；`smartfill_run_logs` 同理指向 `smartfill_runs.run_id` 且 `on_delete=NO ACTION` | FK 指向非主键列在 SQLite 合法（需被引用列唯一），但语义脆弱：`run_id` 若无 unique 约束则 FK 形同虚设；且 `smartfill_run_logs` NO ACTION → 删 run 必败；RESTRICT 的 stage_events 让 signal/candidate 永远无法删除（privacy_hygiene 只能靠前置 count 检查绕行） | 统一约定：FK 一律指向 PK `id`（加 `run_pk` 列）或给 `run_id` 补 `unique=True`；smartfill_run_logs 补 `ondelete="CASCADE"`；评估 stage_events RESTRICT 是否应改 CASCADE（删除 attempt 时 CASCADE 已正确，signal/candidate RESTRICT 保留可接受但要在删除 UX 里给解释） |
| DL-12 | P3 | ux | `backend/app/database.py:119-157` `_auto_migrate` | `callable(val)` 时 `val()` 直接执行取默认（`default=dict`→`{}`、`default=list`→`[]` 走 `json.dumps`）；NOT NULL 且无 default 的列按类型猜 `DEFAULT ''`/`'[]'`/`0` | 「猜默认」对新 NOT NULL 列：String→`''`、JSON→`'[]'`、其他→`0`——DateTime/Boolean 列会拿到错误类型的字面量 default，SQLite 不报错但语义错误（如 Boolean 列 default '0'）；且 `col.default.arg` 为 `func.now()` 这类 SQL 表达式时 callable 检查失败→落进 `DEFAULT 0` | 未上线项目最干净的修法是删 `_auto_migrate` 让 schema 只由 create_all + 版本化迁移产生；至少要把 default 猜测限定为「有显式 default 才加 DEFAULT 子句，否则 ALTER 直接报错提示手工迁移」 |

## Top-5 修复优先级

1. **DL-02 WAL + busy_timeout**：一行 connect-pragma 改动，消除全部并发写 `database is locked` 风险与读写互锁，性价比最高。
2. **DL-01 删除岗位 IntegrityError**：给 7 个 NO ACTION 的 jobs 子表 FK 补 `ondelete`（CASCADE/SET NULL），否则「清空回收站」对有真实使用痕迹的岗位必坏。
3. **DL-03 删 `Application` legacy 轨**：`applications` 表 + legacy ops + routes 旧接口整体移除，收敛到 `application_attempts`/`application_records` 双轨（仍偏多，但至少删一轨），符合 AGENTS.md 明令。
4. **DL-05 幽灵批次 + 悬空指针**：补 `jobs.batch_id`/`resumes.current_version_id` 等 FK；处理 136 个 `slice01-test` 岗位（建批次或归并）。
5. **DL-04 事件溯源口径**：要么把 `attempt.status` 降级为派生投影（写路径只追加 stage event，删五处 fallback），要么文档改口「混合模型」——现状是宣称 A 实现 B。

## 已达标的点（简短）

- `PRAGMA foreign_keys=ON` 按连接开启（database.py:39-43），且 `_schema_smoke_check` 在每次迁移后跑 `integrity_check` + `foreign_key_check` + 缺表检查，fail-closed。
- 迁移框架完整：`user_version` 版本门 + 迁移前 `create_backup` + 失败自动 `restore_backup_snapshot` 回滚 + 版本高于代码时拒绝启动（database.py:246-313）。
- `integrity_check`/`foreign_key_check` 当前全绿；`freelist_count=0` 无碎片。
- `demo_data.py` 删除顺序严格按「最严子表先删」编排，注释明确知道 RESTRICT 约束的存在（line 205-206）。
- `ApplicationStageEvent` 的 `signal_id`/`candidate_id` 双 unique + v3 迁移补 `ux_application_stage_events_signal_id` 唯一索引，幂等意图清晰。
- `OperationAuditLog.idempotency_key` unique 索引 + `application_progress_candidates.signal_id` unique 约束，防重设计一致。
