# DATA_SAFETY_03 Gate Evidence

## Scope and verdict

这是一份 `DATA_SAFETY_03` Gate 补充报告，验证结构化用户数据导出、递归敏感字段排除、明确 Demo/Fixture scope 的重置边界，以及真实 Settings UI 的隔离浏览器路径。它不是完整的 `offeru-core-v1` baseline；机器 summary 保留 24 个 suite task 并明确标记为本轮未运行。

| Field | Value |
| --- | --- |
| Report ID | `data-safety-03` |
| Suite | `offeru-core-v1` / `1.0.0` |
| Evidence date | 2026-08-31 |
| Observed checkout | `d5b9232` |
| Gate | `DATA_SAFETY_03` |
| Verdict | `PASS` for R47/R48; Data Safety requirements R43–R49 and R76 are now covered by current gate reports |
| Recommended decision | Continue to the highest remaining Public Release blocker: Security |

## Environment and isolation

- OS/shell: Windows, PowerShell.
- Python: 3.12.0 via `backend/.venv312/Scripts/python.exe`.
- Node/npm: Node v24.14.0, npm 11.9.0.
- Runtime: local Python/FastAPI backend on port 8765; frontend on port 7410.
- Provider: deterministic local export/reset service; no external credentials, live Agent provider, email, or job-site account was used.
- Backend fixture: temporary SQLite database containing one explicitly marked Demo Job (`source=offeru-demo`, `batch_id=offeru-demo-v1`) and one unmarked real-looking Job, plus a Profile. The browser reset run started with two Jobs and ended with the real-looking Job only.
- Showcase fixture: browser-facing Showcase reset/export routes use independent IndexedDB/fallback fixture storage; SQLite backup is not faked in Showcase mode.
- No real user data was deleted. Normal local `djm.db` was restored after the isolated browser run and health returned HTTP 200.

## Implemented boundary

1. Structured export now includes the core user collections: Profile, Job, Application, Resume, ResumeSection, Interview, InterviewMessage and CareerArtifact, with counts and JSON-readable records.
2. Export redaction recursively removes credential-like keys from nested metadata instead of only filtering top-level fields. Resume share tokens/passwords, provider/connection credentials, email/browser session state and operation audit payloads remain excluded by the existing export policy.
3. Demo Reset is an explicit Operation Registry mutation and UI action. It accepts only the boolean confirmation payload and only matches the reserved pair `source=offeru-demo` plus `batch_id=offeru-demo-v1`.
4. Demo reset deletes dependent synthetic records in an explicit child-first order, scopes CareerArtifact deletion by matched Demo Job/Application IDs, and returns a visible no-op when no marked Demo data exists.
5. Profile, unmarked Jobs, provider credentials, backups and shared user Application records are not reset by this operation. The isolated backend test and browser run both assert preservation of real-scope data.
6. Settings exposes the scope, confirmation phrase, success/no-op result and independent Showcase behavior. The browser path does not directly mutate the database or invent a success response.

## Executed engineering checks

| Check | Result | Evidence |
| --- | --- | --- |
| Data Safety 03 targeted regression | PASS — 17 passed, 2 warnings, 47.34s | `backend/tests/test_data_export.py`, `test_demo_data.py`, `test_data_safety.py`, `test_database_migrations.py` |
| Full backend suite | PASS — 281 passed, 10 warnings, 1 subtest, 529.75s | `backend/.venv312/Scripts/python.exe -m pytest tests -q` |
| Frontend typecheck | PASS | `npm run typecheck` |
| Frontend production build | PASS — Vite 8.1.5, 4263 modules, 22.76s | build output; plugin timing warning only |
| Structured export browser path | PASS — download completed, required collections and redactions checked, console errors 0 | [export-ui-summary.txt](artifacts/data-safety-03/export-ui-summary.txt) |
| Demo Reset browser path | PASS — 2 Jobs before, 1 real Job after; reset message visible; console errors 0 | [settings-demo-reset.png](artifacts/data-safety-03/settings-demo-reset.png) |
| Normal runtime health after isolation | PASS — HTTP 200, `database_path=./djm.db`, no pending restore | `/api/health` |
| CLI Doctor | PASS — schema current/target 2/2, integrity `ok`, FK violations 0, backup count 2 | `backend/.venv312/Scripts/python.exe -m app.cli doctor --pretty` |

## Structured export outcome

The isolated export browser run returned:

```text
schema=offeru.internal-beta.export.v1
collections=profiles, jobs, applications, resumes, interviews and the remaining structured collections
redactions=provider and connection credentials; email account credentials and browser session state; resume share tokens and passwords; operation audit payloads
consoleErrors=0
```

The backend test adds records across Profile, Job, Resume, ResumeSection, Application, Interview, InterviewMessage, CareerTask and CareerArtifact. It verifies that required collection counts and readable record content survive JSON serialization while nested `api_key`/`api_token` metadata is absent from the export. This is an export of structured career state, not an opaque database copy.

## Demo Reset outcome

The isolated browser run used a fresh database with:

```text
Profile: 1
Jobs: 2
  Demo: source=offeru-demo, batch_id=offeru-demo-v1
  Real: unmarked local Job
```

The user performed the actual Settings flow:

```text
Settings
→ Demo / Fixture 工作区
→ 重置 Demo
→ 输入“重置 Demo”
→ 确认
```

The observed result was:

```json
{
  "beforeJobCount": 2,
  "afterJobCount": 1,
  "remainingJobs": ["隔离真实岗位"],
  "resetMessage": "Demo 数据已重置，清除了 1 条明确标记的合成数据。真实用户数据未改动。",
  "consoleErrors": []
}
```

The backend test also verifies that a second reset is a visible no-op, confirmation is mandatory, the Profile remains, the unmarked Job remains, and Demo-linked artifacts/application materials are scoped by the matched IDs. Reset is not exposed as arbitrary `delete(job_id)` and does not remove backups or provider credentials.

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R43 Database Migration | PASS | Covered by `data-safety-02`; current full backend regression also passes migration fixtures. |
| R44 Migration Safety | PASS | Covered by `data-safety-02`; current full backend regression retains failure rollback coverage. |
| R45 Consistent Backup | PASS | Covered by `data-safety-01`; Online Backup API and manifest/hash remain the recovery source. |
| R46 Restore 3 cycles | PASS | Covered by `data-safety-01`; not re-counted as new cycles here. |
| R47 Structured Data Export | PASS | Required structured collections, readable JSON/counts, nested redaction and Settings download are covered by backend tests and the browser artifact. |
| R48 Reset Demo vs Delete Data | PASS | Exact reserved scope, explicit confirmation, child cleanup, real-data preservation and isolated Settings browser evidence are covered. |
| R49 SQLite Integrity | PASS | Covered by `data-safety-01`/`02`; current Doctor reports `integrity_check=ok`, FK violations 0. |
| R76 Golden Path F — Data Recovery | PASS | Covered by `data-safety-01`; current normal runtime has no pending restore. |

## Limitations and next gate

- This report does not prove the 24-task `offeru-core-v1` baseline, 10/10 repeatability, 50-run stability, packaging, clean-machine installation, live provider, or complete security gates.
- Demo reset intentionally preserves the long-lived Profile and unmarked user Jobs. A Demo loader is not added to the normal workspace; reset is a safety boundary for explicitly marked fixture data, while Showcase has its own isolated fixture store.
- Showcase mode provides export/reset fixture behavior but does not pretend to provide SQLite backup. Normal local SQLite backup/restore remains the Data Safety 01 path.
- The next highest blocker is Security: secret/canary scan, dependency audit, PII/logging review, Tauri CSP/capability tightening and diagnostic/error correlation evidence remain open. Public Release must remain `NOT_READY`.

## Machine-readable eval summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "data-safety-03",
  "target_scope": "core-baseline",
  "started_at": "2026-08-31T10:00:00+08:00",
  "finished_at": "2026-08-31T11:00:00+08:00",
  "executor": {"agent":"Codex","model":"GPT-5"},
  "environment": {
    "commit": "d5b9232",
    "dirty_files": ["QUALITY_SCORE.md","RELEASE_CHECKLIST.md","STATUS.md",".tmp/","GOAL.md","_ui_preview/"],
    "os": "Windows with PowerShell",
    "python": "3.12.0 via backend/.venv312/Scripts/python.exe",
    "node": "v24.14.0 / npm 11.9.0",
    "offeru_cli": "local CLI; Doctor reported 245 operations",
    "provider": "deterministic local Data Safety service plus isolated browser fixture",
    "provider_model": "not applicable; export/reset boundary is deterministic",
    "data_isolation": "proven"
  },
  "engineering_checks": [
    {"name":"data_safety_03_targeted_regression","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_data_export.py tests\\test_demo_data.py tests\\test_data_safety.py tests\\test_database_migrations.py -q","exit_code":0,"duration_ms":47340,"artifact":"backend/tests/test_demo_data.py"},
    {"name":"backend_full_regression","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m pytest tests -q","exit_code":0,"duration_ms":529750,"artifact":"backend/tests"},
    {"name":"frontend_typecheck","status":"PASS","command":"npm run typecheck","exit_code":0,"duration_ms":null,"artifact":"frontend/tsconfig.json"},
    {"name":"frontend_build","status":"PASS","command":"npm run build","exit_code":0,"duration_ms":22760,"artifact":"frontend/dist"},
    {"name":"structured_export_browser","status":"PASS","command":"Playwright Settings export download and JSON assertions","exit_code":0,"duration_ms":null,"artifact":"docs/evals/reports/artifacts/data-safety-03/export-ui-summary.txt"},
    {"name":"demo_reset_browser","status":"PASS","command":"Playwright isolated Settings Demo Reset and API preservation assertions","exit_code":0,"duration_ms":null,"artifact":"docs/evals/reports/artifacts/data-safety-03/settings-demo-reset.png"},
    {"name":"normal_runtime_health","status":"PASS","command":"GET /api/health after isolated browser run","exit_code":0,"duration_ms":null,"artifact":"STATUS.md"},
    {"name":"offeru_doctor","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m app.cli doctor --pretty","exit_code":0,"duration_ms":null,"artifact":"STATUS.md"}
  ],
  "totals": {"pass":0,"fail":0,"blocked":0,"not_run":24,"invalid":0},
  "verdicts": {"required_tasks":"NOT_RUN","core_journey":"NOT_RUN","integration_claims":"NOT_RUN","overall":"NOT_RUN"},
  "tasks": [
    {"id":"CORE-ENV-001","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-REG-001","class":"diagnostic","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-REG-002","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-REG-003","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-REG-004","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-001","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-002","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-003","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-004","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-005","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-006","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-AGT-007","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-JOB-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-JOB-002","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-RSH-001","class":"integration","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["External research not exercised."]},
    {"id":"CORE-DEC-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-RES-001","class":"integration","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Resume integration not assessed."]},
    {"id":"CORE-APP-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-FUP-001","class":"integration","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Email integration not exercised."]},
    {"id":"CORE-SEC-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full security baseline not run."]},
    {"id":"CORE-SEC-002","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full security baseline not run."]},
    {"id":"CORE-RESIL-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full long-task contract."],"failed_assertions":[],"limitations":["Migration recovery is narrower than this suite task."]},
    {"id":"CORE-RESIL-002","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full retry contract."],"failed_assertions":[],"limitations":["Migration idempotency is narrower than this suite task."]},
    {"id":"CORE-RESIL-003","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full provider failure contract."],"failed_assertions":[],"limitations":["Full provider failure matrix not run."]}
  ],
  "metrics": {"pass_at_1":null,"pass_power_3":null,"tool_argument_validity":null,"latency_p50_ms":null,"latency_p95_ms":null},
  "security_findings": [],
  "limitations": ["This is a DATA_SAFETY_03 gate report, not a complete offeru-core-v1 baseline.","Public Release remains blocked by Security, Reliability, Packaging, Live Runtime and E2E gates.","Showcase reset/export is fixture-scoped and is not a SQLite backup implementation."],
  "recommended_decision": "run-more-evals"
}
```
