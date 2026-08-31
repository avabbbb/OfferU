# DATA_SAFETY_02 Gate Evidence

## Scope and verdict

这是一份 `DATA_SAFETY_02` 的 Gate 补充报告，验证版本化 SQLite migration、migration 前备份、migration 后完整性/smoke 和失败恢复。它不是完整的 `offeru-core-v1` baseline；机器 summary 保留 24 个 suite task 并明确标记为本轮未运行。

| Field | Value |
| --- | --- |
| Report ID | `data-safety-02` |
| Suite | `offeru-core-v1` / `1.0.0` |
| Evidence date | 2026-08-31 |
| Observed checkout | `cf537cd` plus migration working-tree changes |
| Gate | `DATA_SAFETY_02` |
| Verdict | `PASS` for R43/R44; the wider Data Safety domain remains incomplete because R47/R48 are not verified |
| Recommended decision | Run the next Data Safety gate for structured export and Demo Reset boundaries |

## Environment and isolation

- OS/shell: Windows, PowerShell.
- Python: 3.12.0 via `backend/.venv312/Scripts/python.exe`.
- Node/npm: Node v24.14.0, npm 11.9.0.
- Runtime: local Python/FastAPI backend on port 8765; frontend on port 7410.
- Provider: deterministic local migration/Data Safety service; no external credentials, live Agent provider, email, or job-site account was used.
- Fixtures: temporary SQLite files with an old schema at version 0 and a current-schema fixture at version 1. The normal `backend/djm.db` startup check was performed only after the isolated fixtures and completed with a verified migration.
- No real user data was deleted or exported by this gate. The normal local database received only the additive version marker and the existing triage normalization, with a pre-migration backup created first.

## Implemented migration boundary

1. SQLite file-backed databases now expose `CURRENT_SCHEMA_VERSION = 2` through `PRAGMA user_version`.
2. Migration v1 makes the existing model/column/index baseline explicit; migration v2 normalizes legacy triage values transactionally.
3. Startup checks the version before opening the ORM engine. An old database receives a verified `pre_migration` Online Backup API archive first.
4. Each migration runs inside the schema setup transaction and executes `integrity_check`, `foreign_key_check`, and required-table smoke checks before its version marker is committed.
5. A forced migration failure releases the engine and restores the verified pre-migration snapshot. The application then stops with a clear `DatabaseMigrationError`; it does not continue on a half-migrated database.
6. Future schema versions fail closed without creating a new backup from an unsupported state.
7. CLI Doctor reports current/target schema versions, whether migration is pending, and existing Data Safety state.

## Executed engineering checks

| Check | Result | Evidence |
| --- | --- | --- |
| Migration fixtures | PASS — 4 passed, 25.10s | `backend/tests/test_database_migrations.py` |
| Migration/Data Safety/Registry targeted regression | PASS — 55 passed, 5 warnings, 185.13s | terminal output captured during run |
| Full backend suite | PASS — 279 passed, 10 warnings, 1 subtest, 534.58s | terminal output captured during run |
| Frontend typecheck | PASS | `npm run typecheck` |
| Frontend production build | PASS — Vite 8.1.5, 4263 modules, 26.27s | build output; plugin timing warning only |
| Real startup migration | PASS — `djm.db` version 0 → 2, `integrity_check=ok`, HTTP 200 | `/api/health` and direct SQLite probe |
| CLI Doctor | PASS — schema migration `ready`, current 2/target 2, FK violations 0 | `backend/.venv312/Scripts/python.exe -m app.cli doctor --pretty` |

## Fixture outcomes

### Old schema A: version 0

The isolated fixture contained only minimal `jobs` and `pools` columns, one legacy job, one legacy pool, and `PRAGMA user_version=0`. The run:

```text
prepare → verified pre_migration backup → create missing tables/columns
→ migration v1 → migration v2 → integrity/smoke → user_version=2
```

The original job and pool remained present, `screened` became `picked`, the current `resumes` table existed, and the backup archive remained valid.

### Old schema B: version 1

The second isolated fixture had the current model schema but `PRAGMA user_version=1`. The runner applied only v2, created one `pre_migration` backup, and reached version 2. This proves the migration path is incremental rather than a single untracked startup rewrite.

### Unsupported future schema

An isolated fixture with `PRAGMA user_version=99` was rejected before mutation. No backup was created and Doctor reports the version as failed rather than healthy.

## Failure and rollback outcome

The test injects a migration that adds `transient_column` and then raises. The application-level `init_db` path:

```text
detect old version
→ create pre_migration backup
→ migration raises
→ dispose ORM engine
→ restore verified backup snapshot
→ raise and stop startup
```

After the failure, `transient_column` was absent, `user_version` was back at 0, the original legacy row remained unchanged, and the pre-migration backup was still listed as valid. This explicit restore is required because the Windows SQLite driver mode used here does not make every `ALTER TABLE` failure safely reversible through the ORM transaction alone.

## Normal runtime outcome

After the isolated checks, the project `.venv312` launcher was restarted on the normal local database. The observed result was:

```json
{"user_version":2,"integrity":"ok"}
```

and `/api/health` returned HTTP 200 with `database_path="./djm.db"` and no pending startup restore. Doctor reported:

```json
{"schema_migration":{"status":"ready","current_version":2,"target_version":2,"migration_required":false},"integrity_check":"ok","foreign_key_violations":0}
```

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R43 Database Migration | PASS | Versioned v1/v2 path, old-schema A/B fixtures, current-version marker, and future-version fail-closed behavior are tested. |
| R44 Migration Safety | PASS | Pre-migration verified backup, post-migration integrity/smoke, forced failure recovery, preserved original data, and stopped startup are tested. |
| R45 Consistent Backup | PASS | Covered by `DATA_SAFETY_01`; Online Backup API and manifest/hash remain the source of recovery. |
| R46 Restore 3 cycles | PASS | Covered by `DATA_SAFETY_01`; not re-counted as new cycles here. |
| R49 SQLite Integrity | PASS | Migration smoke and normal Doctor both report `integrity_check=ok`, FK violations 0. |
| R47 Structured Data Export | NOT_VERIFIED | Existing JSON export has not received the required Public Release completeness/readability audit. |
| R48 Reset Demo vs Delete Data | NOT_VERIFIED | Demo reset scope and real-data protection still need a current UI/browser report. |

## Limitations and next gate

- This report does not prove the 24-task `offeru-core-v1` baseline, 10/10 repeatability, 50-run stability, packaging, clean-machine installation, live provider, or complete security gates.
- The migration implementation currently has two explicit versions; future schema changes must add a new numbered migration and corresponding old-schema fixture rather than extending `_auto_migrate` silently.
- Backup retention, encryption at rest, cloud sync, arbitrary external-file transactionality, and signed installers remain outside this gate.
- Doctor now reports schema migration state and database integrity, but the complete desktop bridge, storage, and version-consistency release contract remains open under R104.

## Machine-readable eval summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "data-safety-02",
  "target_scope": "core-baseline",
  "started_at": "2026-08-31T09:19:06+08:00",
  "finished_at": "2026-08-31T10:00:44+08:00",
  "executor": {"agent":"Codex","model":"GPT-5"},
  "environment": {
    "commit": "cf537cd",
    "dirty_files": ["backend/app/cli.py","backend/app/database.py","backend/app/services/data_safety.py","frontend/src/app/settings/page.tsx","backend/tests/test_database_migrations.py",".tmp/","GOAL.md","_ui_preview/"],
    "os": "Windows with PowerShell",
    "python": "3.12.0 via backend/.venv312/Scripts/python.exe",
    "node": "v24.14.0 / npm 11.9.0",
    "offeru_cli": "local CLI; doctor/manifest/playbook reported 244 operations",
    "provider": "deterministic local migration and Data Safety service",
    "provider_model": "not applicable; migration gate is deterministic",
    "data_isolation": "proven"
  },
  "engineering_checks": [
    {"name":"database_migration_fixtures","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m pytest tests/test_database_migrations.py -q -s","exit_code":0,"duration_ms":25100,"artifact":"backend/tests/test_database_migrations.py"},
    {"name":"data_safety_registry_regression","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m pytest tests/test_database_migrations.py tests/test_data_safety.py tests/test_cli_ops.py -q","exit_code":0,"duration_ms":185130,"artifact":"backend/tests/test_data_safety.py"},
    {"name":"backend_full_regression","status":"PASS","command":"backend\\.venv312\\Scripts\\python.exe -m pytest tests -q","exit_code":0,"duration_ms":534580,"artifact":"backend/tests/test_database_migrations.py"},
    {"name":"frontend_typecheck","status":"PASS","command":"npm run typecheck","exit_code":0,"duration_ms":null,"artifact":"frontend/tsconfig.json"},
    {"name":"frontend_build","status":"PASS","command":"npm run build","exit_code":0,"duration_ms":26270,"artifact":"frontend/dist"},
    {"name":"normal_startup_migration","status":"PASS","command":".venv312\\Scripts\\python.exe run_server.py and GET /api/health","exit_code":0,"duration_ms":null,"artifact":"STATUS.md"},
    {"name":"offeru_doctor","status":"PASS","command":".venv312\\Scripts\\python.exe -m app.cli doctor --pretty","exit_code":0,"duration_ms":null,"artifact":"STATUS.md"}
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
  "limitations": ["This is a DATA_SAFETY_02 gate report, not a complete offeru-core-v1 baseline.","R47 and R48 remain unverified.","External providers, packaging, clean-machine installation, soak, and complete security gates were not run."],
  "recommended_decision": "run-more-evals"
}
```
