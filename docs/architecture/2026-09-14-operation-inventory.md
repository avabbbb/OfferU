> **HISTORICAL SNAPSHOT — 2026-09-14.** The operation counts and manifest measurements below are intentionally preserved as the pre-Tool-Surface-V2 baseline. Do not use them as current tool counts.

# Operation surface inventory — 2026-09-14

Measured against the working checkout before simplification: **257 registered operations, 88 read-only, 169 with side effects, 18 domain groups, 35 Skills (15 featured), 14 Bridge read grants**. CLI remains 8 top-level verbs. The default manifest returns 257 full schemas and serializes to 356,711 UTF-8 bytes using `json.dumps(..., ensure_ascii=False)` with its default separators. Existing `--summary` still advertises all 257 operations and serializes to 26,284 bytes. These are bytes, not token counts.

Using the explicit `tiktoken` encoding `o200k_base` on those exact JSON strings gives **100,131 tokens** for the default manifest and **7,152 tokens** for `--summary`. This is a reproducible reference tokenizer measurement, not a claim about an unpublished model-specific tokenizer or actual billing. Tokenizer packages and cache were installed only in the isolated H-drive audit-tools directory, not the application environment.

Registry inventory comes from the imported `OPERATIONS` mapping with an isolated `OFFERU_DATA_DIR` and SQLite path under `H:/tmp/offeru/simplification-20260914`; no business operation was executed. Caller evidence is exact operation-name references in `backend/app/routes`, `frontend/src`, `integrations` and `extension/src`, excluding test files. It does not claim runtime call frequency or an exhaustive graph of dynamically selected operations. `skills` comes from the current Skill Registry, including directory and plugin discovery.

Each operation has exactly one primary category. `LEGACY` takes precedence for the 28 implementations in `legacy_operations`; every one has a current route reference and **none is justified for deletion**. Diagnostics are explicit health/audit/reset/backup boundaries; integrations are mailbox, scraper and plugin boundaries; helpers are Agent/control/discovery operations; workflows combine preparation/generation/review; remaining domain reads and mutations are primitives. This classification describes product ownership, not a new execution or permission policy. Names alone do not prove duplication. `DUPLICATE_OR_OVERLAPPING` and `REMOVAL_CANDIDATE` are currently zero because equivalence or disuse has not been established.

## Primary categories

| Category | Count |
| --- | ---: |
| CORE_DOMAIN_PRIMITIVE | 131 |
| AGENT_HELPER | 32 |
| PRODUCT_WORKFLOW | 35 |
| LEGACY | 28 |
| INTEGRATION | 16 |
| DIAGNOSTIC | 15 |
| DUPLICATE_OR_OVERLAPPING | 0 |
| REMOVAL_CANDIDATE | 0 |

## Retention policy

- KEEP: preserve execution and product reachability. A matching Skill can discover its operations; other operations remain explicitly discoverable by domain.
- ISOLATE: preserve current route callers, but exclude from beginner/default Agent discovery. No tables, templates or applications are deleted.
- `Default after` below means membership in the existing discovery Skill, not permission to execute. Before simplification, the CLI default advertises every row; Bridge grants remain independently restricted.
- Primary category, full caller references and Skill memberships are also available in [the JSON inventory](2026-09-14-operation-inventory.json).

## Every operation

| Operation | Domain | Category | Effects | Decision | Default after | Skill count | Caller evidence |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| `access_resume_share_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2211` |
| `activate_authorized_research_read_only` | research | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 1 | `backend/app/routes/research.py:230` |
| `add_profile_evidence` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `frontend/src/lib/agentToolPresentation.ts:68` |
| `agent_playbook` | governance | AGENT_HELPER | read | KEEP | no | 0 | `backend/app/routes/agent.py:51` |
| `analyze_application_patterns` | applications | PRODUCT_WORKFLOW | read | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:61` |
| `apply_application_template_to_all` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:300` |
| `apply_profile_agent_patch` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile_agent.py:548`<br>`backend/app/routes/profile_agent.py:550` |
| `apply_resume_record_template` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:404` |
| `apply_resume_suggestion` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:1840` |
| `apply_resume_suggestions_batch` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:1864` |
| `apply_resume_template` | resume | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/templates.py:170` |
| `auto_fill_calendar_events` | calendar | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/calendar.py:97` |
| `auto_write_application_job` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:320` |
| `batch_optimize_resume_records` | resume | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | `backend/app/routes/resume.py:1899` |
| `batch_triage` | jobs | PRODUCT_WORKFLOW | write | KEEP | no | 3 | `backend/app/routes/jobs.py:331` |
| `batch_update_jobs` | jobs | PRODUCT_WORKFLOW | write | KEEP | no | 0 | `backend/app/routes/jobs.py:312`<br>`backend/app/routes/jobs.py:338`<br>`backend/app/routes/agent.py:60` |
| `begin_gmail_oauth` | email | INTEGRATION | write | KEEP | no | 0 | `backend/app/routes/email.py:110` |
| `build_job_projection` | job | PRODUCT_WORKFLOW | read | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `build_role_benchmark` | research | PRODUCT_WORKFLOW | external, llm, write | KEEP | no | 1 | `backend/app/routes/research.py:118`<br>`backend/app/routes/research.py:123`<br>`frontend/src/components/jobs/RoleIntelligencePanel.tsx:385` |
| `cancel_authorized_research_session` | research | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/research.py:272` |
| `cancel_career_task` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:546`<br>`backend/app/routes/main_agent.py:547` |
| `cancel_data_restore` | governance | DIAGNOSTIC | write | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1064`<br>`backend/app/routes/main_agent.py:1066` |
| `cancel_job_research` | research | CORE_DOMAIN_PRIMITIVE | write, external | KEEP | no | 3 | `backend/app/routes/main_agent.py:901` |
| `capture_authorized_research_page` | research | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 1 | `backend/app/routes/research.py:244` |
| `chat_optimize_agent_session` | resume | CORE_DOMAIN_PRIMITIVE | llm, write | KEEP | no | 0 | `backend/app/routes/optimize.py:1103` |
| `check_database_integrity` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1042` |
| `classify_progress_signal` | applications | CORE_DOMAIN_PRIMITIVE | llm, write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `clear_current_view` | context | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:933`<br>`backend/app/routes/agent.py:241` |
| `collect_interview_experience` | interview | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/interview.py:127` |
| `complete_authorized_research_session` | research | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/research.py:258` |
| `complete_gmail_oauth` | email | INTEGRATION | external, write | KEEP | no | 0 | `backend/app/routes/email.py:128` |
| `complete_smart_fill_run` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:2566`<br>`backend/app/routes/profile.py:2635` |
| `confirm_profile_bullet` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1622`<br>`backend/app/routes/profile.py:1624` |
| `connect_imap_account` | email | INTEGRATION | external, write | KEEP | no | 0 | `backend/app/routes/email.py:141` |
| `consolidate_memory_observations` | memory | PRODUCT_WORKFLOW | write | KEEP | no | 2 | No literal caller in scanned surfaces; dynamic use not excluded |
| `continue_profile_agent_session` | profile | CORE_DOMAIN_PRIMITIVE | llm, write | KEEP | no | 0 | `backend/app/routes/profile_agent.py:542` |
| `create_ai_interview` | interview | CORE_DOMAIN_PRIMITIVE | llm, external, write | KEEP | no | 1 | `backend/app/routes/interviews.py:126` |
| `create_application` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `frontend/src/lib/agentToolPresentation.ts:73`<br>`backend/app/routes/applications.py:373`<br>`backend/app/routes/agent.py:62` |
| `create_application_attempt` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `create_application_table` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:171` |
| `create_application_table_record` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:228` |
| `create_calendar_event` | calendar | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/calendar.py:88` |
| `create_data_backup` | governance | DIAGNOSTIC | write | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1051`<br>`backend/app/routes/main_agent.py:1052` |
| `create_fixture_job_research` | research | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `create_interview_scoring_skill` | interview | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/interviews.py:96` |
| `create_legacy_application` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:374` |
| `create_memory_proposal` | memory | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 2 | `backend/app/routes/memory.py:64` |
| `create_pool` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/pools.py:99`<br>`backend/app/routes/pools.py:102` |
| `create_profile_section` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1534`<br>`backend/app/routes/profile.py:1535` |
| `create_resume_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:340` |
| `create_resume_section` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:465` |
| `create_resume_share_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2126` |
| `create_resume_template` | resume | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/templates.py:128` |
| `create_resume_version_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2018` |
| `create_target_role` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1524`<br>`backend/app/routes/profile.py:1525` |
| `delegate_career_task` | agent_runtime | AGENT_HELPER | external, llm, write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `delete_ai_interview` | interview | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/interviews.py:196` |
| `delete_application_records` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:262` |
| `delete_application_table` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:192` |
| `delete_harness_conversation` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:952` |
| `delete_jobs_batch` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/jobs.py:319`<br>`backend/app/routes/jobs.py:322` |
| `delete_optimize_agent_session` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/optimize.py:1204` |
| `delete_pool` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/pools.py:124`<br>`backend/app/routes/pools.py:130` |
| `delete_profile_section` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1550`<br>`backend/app/routes/profile.py:1551` |
| `delete_resume_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:438` |
| `delete_resume_section` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:491` |
| `delete_resume_share_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2173` |
| `delete_resume_template` | resume | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/templates.py:156` |
| `delete_target_role` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1529`<br>`backend/app/routes/profile.py:1530` |
| `derive_career_model` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/memory.py:58` |
| `distill_harness_conversation` | agent_runtime | AGENT_HELPER | llm, write | KEEP | no | 0 | `backend/app/routes/main_agent.py:960` |
| `distill_memory` | memory | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `draft_interview_scoring_skill` | interview | CORE_DOMAIN_PRIMITIVE | llm | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `duplicate_resume_template` | resume | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/templates.py:186` |
| `email_connection_status` | email | INTEGRATION | read | KEEP | no | 2 | `backend/app/routes/email.py:153` |
| `ensure_resume_workspace` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:379`<br>`backend/app/routes/resume.py:381` |
| `export_diagnostic_bundle` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:997`<br>`backend/app/routes/main_agent.py:999` |
| `export_resume_pdf` | resume | PRODUCT_WORKFLOW | write | KEEP | no | 1 | `frontend/src/lib/agentToolPresentation.ts:46` |
| `export_user_data` | governance | PRODUCT_WORKFLOW | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:991`<br>`backend/app/routes/main_agent.py:993` |
| `extract_interview_questions` | interview | LEGACY | llm, write | ISOLATE | no | 0 | `backend/app/routes/interview.py:137` |
| `finalize_scraper_batch` | jobs | INTEGRATION | write | KEEP | no | 0 | `backend/app/routes/scraper.py:237`<br>`backend/app/routes/scraper.py:265` |
| `generate_cover_letter` | applications | PRODUCT_WORKFLOW | llm | KEEP | no | 2 | `backend/app/routes/applications.py:10`<br>`backend/app/routes/agent.py:62` |
| `generate_html_resume` | resume | LEGACY | llm, write | ISOLATE | no | 0 | `backend/app/routes/studio.py:43`<br>`backend/app/routes/studio.py:50` |
| `generate_legacy_cover_letter` | applications | LEGACY | llm | ISOLATE | no | 0 | `backend/app/routes/applications.py:379` |
| `generate_legacy_interview_answer` | interview | LEGACY | llm, write | ISOLATE | no | 0 | `backend/app/routes/interview.py:147` |
| `generate_profile_narrative` | profile | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | `backend/app/routes/profile.py:1729` |
| `get_agent_connections` | agent_runtime | AGENT_HELPER | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:433` |
| `get_agent_provider_health` | agent_runtime | DIAGNOSTIC | read | ISOLATE | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `get_ai_interview` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/interviews.py:155` |
| `get_ai_interview_runtime` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/interviews.py:79` |
| `get_application_progress_board` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/applications.py:137` |
| `get_application_progress_candidate` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/email.py:290` |
| `get_application_progress_overview` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/email.py:321` |
| `get_application_progress_timeline` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/applications.py:149` |
| `get_application_workspace` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 9 | No literal caller in scanned surfaces; dynamic use not excluded |
| `get_authorized_research_session` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/research.py:216` |
| `get_batch_job_evaluation` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:27` |
| `get_career_artifact` | artifacts | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 11 | No literal caller in scanned surfaces; dynamic use not excluded |
| `get_career_task` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `backend/app/routes/main_agent.py:529` |
| `get_career_task_result` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `backend/app/routes/main_agent.py:542` |
| `get_current_view` | context | AGENT_HELPER | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:921`<br>`backend/app/routes/agent.py:63`<br>`backend/app/routes/agent.py:221` |
| `get_data_safety_status` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1013` |
| `get_email_sync_run` | email | INTEGRATION | read | KEEP | no | 2 | `backend/app/routes/email.py:220` |
| `get_hosted_executor_session` | agent_runtime | AGENT_HELPER | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:864` |
| `get_interview_scoring_skill` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/interviews.py:107` |
| `get_job` | jobs | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 15 | `backend/app/routes/jobs.py:501`<br>`backend/app/routes/agent.py:61`<br>`backend/app/routes/agent.py:62` |
| `get_job_research` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/research.py:103`<br>`backend/app/routes/agent.py:61` |
| `get_legacy_profile` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1460`<br>`backend/app/routes/profile.py:1465`<br>`backend/app/routes/profile.py:1501`<br>`backend/app/routes/profile.py:2575`<br>`backend/app/routes/profile.py:2683`<br>`backend/app/routes/profile.py:2714` |
| `get_local_agent_capability_matrix` | agent_runtime | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:451` |
| `get_local_agent_capability_report` | agent_runtime | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:479` |
| `get_pre_application_state` | pre_application | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/research.py:163` |
| `get_privacy_hygiene_status` | governance | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:1019` |
| `get_profile` | profile | CORE_DOMAIN_PRIMITIVE | read | KEEP | yes | 27 | `backend/app/routes/profile.py:1459`<br>`backend/app/routes/agent.py:60`<br>`backend/app/routes/agent.py:61` |
| `get_profile_agent_session` | profile | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/profile_agent.py:556`<br>`backend/app/routes/profile_agent.py:558` |
| `get_profile_chat_session` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1617`<br>`backend/app/routes/profile.py:1618` |
| `get_profile_evolution_report` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:465` |
| `get_resume` | resume | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 5 | `backend/app/routes/resume.py:410` |
| `get_resume_optimization` | resume | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/optimize.py:1018`<br>`backend/app/routes/agent.py:61`<br>`backend/app/routes/agent.py:62` |
| `get_resume_workspace` | resume | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/resume.py:374`<br>`backend/app/routes/resume.py:375` |
| `get_role_benchmark` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/research.py:141`<br>`backend/app/routes/research.py:158` |
| `get_synthetic_email_test_data_status` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `get_work_source` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `get_work_source_sync_run` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `import_harness_memory` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:1074` |
| `import_jd` | jobs | PRODUCT_WORKFLOW | write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `import_job_batch` | jobs | PRODUCT_WORKFLOW | write | KEEP | no | 0 | `extension/src/background/offeru-control-http.ts:140`<br>`backend/app/routes/scraper.py:217`<br>`backend/app/routes/jobs.py:514`<br>`backend/app/routes/jobs.py:519` |
| `import_jobs_to_application_table` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:204` |
| `import_latest_extension_batch_to_application_table` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:218` |
| `ingest_application_signal` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/email.py:262` |
| `ingest_interview_behavior_events` | interview | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/interviews.py:174` |
| `inspect_resume_document` | resume | CORE_DOMAIN_PRIMITIVE | external | KEEP | no | 2 | No literal caller in scanned surfaces; dynamic use not excluded |
| `install_capability_plugin` | plugins | INTEGRATION | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:572` |
| `invalidate_memory_source` | memory | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `invalidate_work_source` | memory | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `invoke_plugin_capability` | plugins | INTEGRATION | external_read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `job_stats` | analytics | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 3 | `backend/app/routes/jobs.py:359`<br>`backend/app/routes/agent.py:59` |
| `list_agent_provider_health` | agent_runtime | DIAGNOSTIC | read | ISOLATE | no | 1 | `backend/app/routes/main_agent.py:428` |
| `list_agent_runs` | agent_runtime | AGENT_HELPER | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:217`<br>`backend/app/routes/main_agent.py:220` |
| `list_ai_interviews` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/interviews.py:118` |
| `list_application_events` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 5 | `frontend/src/lib/agentToolPresentation.ts:58` |
| `list_application_progress_candidates` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/email.py:278` |
| `list_application_records` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_applications` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 7 | `backend/app/routes/applications.py:329` |
| `list_authorized_research_sessions` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/research.py:205` |
| `list_automation_events` | automation | PRODUCT_WORKFLOW | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:587` |
| `list_automation_inbox` | automation | PRODUCT_WORKFLOW | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:599` |
| `list_automation_rules` | automation | PRODUCT_WORKFLOW | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:607` |
| `list_batch_job_evaluations` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:36` |
| `list_calendar_events` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_capability_plugins` | plugins | INTEGRATION | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:562` |
| `list_career_artifacts` | artifacts | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 12 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_career_ledger` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | `backend/app/routes/memory.py:52` |
| `list_career_task_events` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `backend/app/routes/main_agent.py:535` |
| `list_career_tasks` | agent_runtime | AGENT_HELPER | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:508` |
| `list_coding_agents` | agent_runtime | AGENT_HELPER | read | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:39` |
| `list_data_backups` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1047` |
| `list_email_accounts` | email | INTEGRATION | read | KEEP | no | 2 | `backend/app/routes/email.py:168` |
| `list_email_sync_runs` | email | INTEGRATION | read | KEEP | no | 2 | `backend/app/routes/email.py:208` |
| `list_follow_up_cadence` | applications | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:50` |
| `list_hosted_executor_sessions` | agent_runtime | AGENT_HELPER | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:852` |
| `list_interview_questions` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_interview_scoring_skills` | interview | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/interviews.py:88` |
| `list_job_research_runs` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 2 | `backend/app/routes/research.py:96` |
| `list_jobs` | jobs | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 20 | `backend/app/routes/jobs.py:159`<br>`backend/app/routes/agent.py:59`<br>`backend/app/routes/agent.py:60` |
| `list_learning_observations` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 3 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_memory_inbox` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 3 | `backend/app/routes/memory.py:46` |
| `list_operation_audit` | governance | DIAGNOSTIC | read | ISOLATE | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_plugin_capabilities` | plugins | INTEGRATION | read | KEEP | no | 1 | `backend/app/routes/main_agent.py:567` |
| `list_pools` | jobs | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/pools.py:56`<br>`backend/app/routes/agent.py:59` |
| `list_profile_chat_sessions` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1610`<br>`backend/app/routes/profile.py:1613` |
| `list_profile_evidence` | profile | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 5 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_profile_target_roles` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1520` |
| `list_resume_optimizations` | resume | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/optimize.py:1010`<br>`backend/app/routes/agent.py:62` |
| `list_resumes` | resume | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 5 | `backend/app/routes/resume.py:317` |
| `list_role_delta_signals` | research | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | `backend/app/routes/research.py:151` |
| `list_work_source_sync_runs` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `list_work_sources` | memory | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `move_application_records` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:252` |
| `prepare_pre_application_decision` | pre_application | PRODUCT_WORKFLOW | write, external | KEEP | no | 1 | `backend/app/routes/research.py:167`<br>`backend/app/routes/research.py:172` |
| `prepare_resume_optimization` | resume | PRODUCT_WORKFLOW | llm, write | KEEP | no | 2 | `backend/app/routes/optimize.py:914`<br>`backend/app/routes/agent.py:61` |
| `prepare_role_interview_focus` | interview | PRODUCT_WORKFLOW | read | KEEP | no | 2 | `backend/app/routes/interviews.py:130`<br>`backend/app/routes/interviews.py:138` |
| `probe_agent_connection` | agent_runtime | AGENT_HELPER | read | KEEP | no | 0 | `backend/app/routes/main_agent.py:437`<br>`backend/app/routes/main_agent.py:438` |
| `promote_harness_memory` | agent_runtime | AGENT_HELPER | llm, write | KEEP | no | 0 | `backend/app/routes/main_agent.py:968` |
| `promote_session_memory` | memory | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `purge_synthetic_email_test_data` | governance | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 0 | `backend/app/routes/main_agent.py:1035` |
| `record_automation_event` | automation | PRODUCT_WORKFLOW | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:613`<br>`backend/app/routes/main_agent.py:615`<br>`backend/app/routes/jobs.py:529` |
| `record_follow_up` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `frontend/src/lib/agentToolPresentation.ts:55` |
| `refresh_job_research_report` | research | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `refresh_role_benchmark` | research | PRODUCT_WORKFLOW | external, llm, write | KEEP | no | 1 | `backend/app/routes/research.py:129`<br>`backend/app/routes/research.py:134` |
| `register_work_source` | memory | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `reject_agent_run` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/bridge.py:103` |
| `rename_application_table` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:183` |
| `reorder_resume_sections` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:456` |
| `reset_demo_data` | governance | DIAGNOSTIC | write | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1003`<br>`backend/app/routes/main_agent.py:1006` |
| `reset_local_business_data` | governance | DIAGNOSTIC | write | ISOLATE | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `resolve_automation_inbox_item` | automation | PRODUCT_WORKFLOW | write | KEEP | no | 1 | `backend/app/routes/main_agent.py:621`<br>`backend/app/routes/main_agent.py:626` |
| `resolve_resume_logo` | resume | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 0 | `backend/app/routes/resume.py:686` |
| `restart_ai_interview` | interview | PRODUCT_WORKFLOW | write | KEEP | no | 1 | `backend/app/routes/interviews.py:185` |
| `restore_resume_version_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2096` |
| `resume_batch_job_evaluation` | agent_runtime | AGENT_HELPER | write, external | KEEP | no | 2 | `frontend/src/lib/agentToolPresentation.ts:23` |
| `resume_career_task` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:556`<br>`backend/app/routes/main_agent.py:557` |
| `resume_job_research` | research | PRODUCT_WORKFLOW | write, external | KEEP | no | 3 | `backend/app/routes/main_agent.py:913` |
| `resume_work_source_sync` | memory | CORE_DOMAIN_PRIMITIVE | external, llm, write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `retry_career_task` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:551`<br>`backend/app/routes/main_agent.py:552` |
| `review_application_progress` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 2 | `frontend/src/lib/showcase/rules.ts:96`<br>`frontend/src/lib/showcase/router.ts:1025`<br>`backend/app/routes/email.py:305` |
| `review_job_research` | research | PRODUCT_WORKFLOW | write | KEEP | no | 3 | `backend/app/routes/research.py:112` |
| `review_memory_proposal` | memory | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 3 | `backend/app/routes/memory.py:74` |
| `review_pre_application_decision` | pre_application | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/research.py:178`<br>`backend/app/routes/research.py:183` |
| `review_resume_optimization` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | `backend/app/routes/optimize.py:1029`<br>`backend/app/routes/agent.py:61`<br>`backend/app/routes/agent.py:62` |
| `review_resume_proposal_item` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:387`<br>`backend/app/routes/resume.py:392` |
| `revoke_email_account` | email | INTEGRATION | external, write | KEEP | no | 2 | `backend/app/routes/email.py:180` |
| `run_codex_offeru_conformance` | agent_runtime | AGENT_HELPER | external_read, llm | KEEP | no | 0 | `backend/app/routes/main_agent.py:494` |
| `save_career_artifact` | artifacts | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 12 | `frontend/src/lib/agentToolPresentation.ts:43` |
| `save_harness_conversation` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:649`<br>`backend/app/routes/main_agent.py:670`<br>`backend/app/routes/main_agent.py:701`<br>`backend/app/routes/main_agent.py:741`<br>`backend/app/routes/main_agent.py:820` |
| `save_profile_chat_turn` | profile | CORE_DOMAIN_PRIMITIVE | llm, write | KEEP | no | 0 | `backend/app/routes/profile.py:1571` |
| `save_profile_resume_import` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1713` |
| `save_resume_draft_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2438` |
| `save_smart_fill_cache` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:2468` |
| `save_smart_fill_run_logs` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:2485` |
| `scrub_legacy_email_notification_bodies` | governance | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:1026` |
| `search_memory` | memory | CORE_DOMAIN_PRIMITIVE | llm | KEEP | no | 0 | `backend/app/routes/main_agent.py:974`<br>`backend/app/routes/main_agent.py:977` |
| `set_current_view` | context | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:927`<br>`backend/app/routes/agent.py:231` |
| `stage_data_restore` | governance | DIAGNOSTIC | write | ISOLATE | no | 0 | `backend/app/routes/main_agent.py:1056`<br>`backend/app/routes/main_agent.py:1058` |
| `start_authorized_research_session` | research | PRODUCT_WORKFLOW | external, write | KEEP | no | 1 | `backend/app/routes/research.py:193` |
| `start_batch_job_evaluation` | agent_runtime | AGENT_HELPER | write, external | KEEP | no | 1 | `frontend/src/lib/agentToolPresentation.ts:23` |
| `start_career_task` | agent_runtime | AGENT_HELPER | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:520`<br>`backend/app/routes/main_agent.py:522` |
| `start_job_research` | research | PRODUCT_WORKFLOW | write, external | KEEP | no | 3 | `backend/app/routes/agent.py:61` |
| `start_optimize_agent_session` | resume | PRODUCT_WORKFLOW | llm, write | KEEP | no | 0 | `backend/app/routes/optimize.py:1087` |
| `start_profile_agent_session` | profile | PRODUCT_WORKFLOW | write | KEEP | no | 0 | `backend/app/routes/profile_agent.py:534` |
| `start_scraper_batch` | jobs | INTEGRATION | external, write | KEEP | no | 0 | `backend/app/routes/scraper.py:125` |
| `start_smart_fill_run` | profile | PRODUCT_WORKFLOW | write | KEEP | no | 0 | `backend/app/routes/profile.py:2563` |
| `start_work_source_sync` | memory | PRODUCT_WORKFLOW | external, llm, write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `stream_optimize_agent_session` | resume | CORE_DOMAIN_PRIMITIVE | llm, write | KEEP | no | 0 | `backend/app/routes/optimize.py:1118` |
| `submit_ai_interview_answer` | interview | PRODUCT_WORKFLOW | llm, external, write | KEEP | no | 1 | `backend/app/routes/interviews.py:163` |
| `sync_email_notifications` | email | INTEGRATION | external, write | KEEP | no | 2 | `backend/app/routes/email.py:192` |
| `toggle_resume_share_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:2186` |
| `triage_job` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 1 | No literal caller in scanned surfaces; dynamic use not excluded |
| `uninstall_capability_plugin` | plugins | INTEGRATION | write | KEEP | no | 0 | `backend/app/routes/main_agent.py:577` |
| `update_application_record` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 4 | No literal caller in scanned surfaces; dynamic use not excluded |
| `update_application_settings` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:313` |
| `update_application_status` | applications | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 3 | No literal caller in scanned surfaces; dynamic use not excluded |
| `update_application_table_record` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:241` |
| `update_application_table_schema` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:275` |
| `update_application_template` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:291` |
| `update_job` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/jobs.py:355` |
| `update_legacy_application` | applications | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/applications.py:395` |
| `update_pool` | jobs | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/pools.py:110`<br>`backend/app/routes/pools.py:119` |
| `update_profile` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1514`<br>`backend/app/routes/profile.py:1515` |
| `update_profile_section` | profile | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/profile.py:1539`<br>`backend/app/routes/profile.py:1544` |
| `update_resume_record` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:430` |
| `update_resume_section` | resume | CORE_DOMAIN_PRIMITIVE | write | KEEP | no | 0 | `backend/app/routes/resume.py:478` |
| `update_resume_template` | resume | LEGACY | write | ISOLATE | no | 0 | `backend/app/routes/templates.py:142` |
| `upload_resume_logo` | resume | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 0 | `backend/app/routes/resume.py:668` |
| `upload_resume_photo` | resume | CORE_DOMAIN_PRIMITIVE | external, write | KEEP | no | 0 | `backend/app/routes/resume.py:649` |
| `validate_fact_gate` | profile | CORE_DOMAIN_PRIMITIVE | read | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `workflow_catalog` | governance | AGENT_HELPER | read | KEEP | no | 0 | No literal caller in scanned surfaces; dynamic use not excluded |
| `workflow_plan` | governance | AGENT_HELPER | read | KEEP | no | 0 | `backend/app/routes/agent.py:51` |
