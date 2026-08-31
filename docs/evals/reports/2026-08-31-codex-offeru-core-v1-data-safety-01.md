# DATA_SAFETY_01 Gate Evidence

## Scope and verdict

这是一份 `DATA_SAFETY_01` 的 Gate 补充报告，不是完整的 `offeru-core-v1` baseline。它记录本轮对本地单人 SQLite 数据安全边界的实现和运行证据；JSON summary 按仓库要求保留全部 24 个 suite task，但这些 task 没有在本轮完整重跑，因此不能据此宣称 Public Release Ready。

| Field | Value |
| --- | --- |
| Report ID | `data-safety-01` |
| Suite | `offeru-core-v1` / `1.0.0` |
| Evidence date | 2026-08-31 |
| Observed checkout | `3e3984e` plus dirty working-tree changes listed below |
| Gate | `DATA_SAFETY_01` |
| Verdict | `PASS` for R45/R46/R49/R76; `FAIL` for the overall Data Safety domain because R43/R44 remain open |
| Recommended decision | Run the next migration-safety gate before any Public Release claim |

## Environment and isolation

- OS/shell: Windows, PowerShell.
- Python: 3.12.0, `backend/.venv312/Scripts/python.exe`.
- Node/npm: Node v24.14.0, npm 11.9.0.
- Runtime: local Python/FastAPI backend on port 8765; frontend on port 7410.
- Agent/provider: deterministic local Data Safety service and Replay-capable product runtime; no real Codex, DSH, Gmail, or job-site credentials were used.
- Isolation: browser verification used a separate temporary backend/database/uploads/artifacts root. The normal runtime was stopped before the isolated server and restored to the normal `./djm.db` runtime afterward.
- Working-tree state at evidence execution included the Data Safety implementation files, the Data Safety test file, and pre-existing local `.tmp`, `GOAL.md`, and `_ui_preview` files. No real user database was used or overwritten by the tests.

## Implemented boundary

The tested path now provides:

1. SQLite Online Backup API snapshots through `sqlite3.Connection.backup`, rather than copying a live database file.
2. A versioned backup format with a manifest, per-file hashes, database metadata, and managed `uploads/` and `artifacts/` snapshots.
3. `PRAGMA integrity_check` and foreign-key validation during backup/restore verification.
4. Archive member traversal and Windows alternate-data-stream validation.
5. Restore staging that does not replace live state immediately; staging is idempotent for the same backup and refuses switching to another pending restore until the current one is cancelled.
6. Startup-time validation and restore before the SQLAlchemy engine connects, including an automatic pre-restore backup.
7. Atomic replacement with verification and automatic rollback when installation verification fails.
8. Operation Registry operations, CLI Doctor visibility, Settings UI visibility, typed confirmation, and safe cancellation.

## Executed engineering checks

| Check | Result | Evidence |
| --- | --- | --- |
| Data Safety deterministic tests | PASS — 10 passed, 2 existing Pydantic warnings | `backend/tests/test_data_safety.py` |
| Data Safety + CLI operation tests | PASS — 50 passed, 5 warnings, 104.34s | test output captured during run |
| Full backend suite | PASS — 275 passed, 11 warnings, 1 subtest, 314.62s | test output captured during run |
| Frontend typecheck | PASS | `npm run typecheck` |
| Frontend production build | PASS — Vite 8.1.5, 4263 modules, 14.68s | build output; plugin timing warning only |
| CLI Doctor | PASS — 244 operations; Data Safety ready; integrity `ok`; FK violations `0` | `backend/.venv312/Scripts/python.exe -m app.cli doctor --pretty` |
| CLI Manifest | PASS — 244 operations exposed | `backend/.venv312/Scripts/python.exe -m app.cli manifest --pretty` |
| Agent playbook | PASS | `backend/.venv312/Scripts/python.exe -m app.cli run agent_playbook --arg detail=full --pretty` |
| Normal runtime health | PASS — HTTP 200; normal `./djm.db`; no pending startup restore | `http://127.0.0.1:8765/api/health` |

## Deterministic restore evidence

The isolated backend tests covered:

- three independent backup → mutate → stage → restart-apply cycles;
- database rows plus managed upload/artifact files surviving each restore;
- a real SQLAlchemy `Profile` and `Job` surviving a new-engine connection after restore;
- idempotent staging and confirmed cancellation without deleting the source backup;
- rejection of a second different pending restore;
- forced install-verification failure rolling back live state while retaining recovery material;
- tampered archive content-hash rejection without creating a pending restore;
- Windows ADS-style archive member rejection;
- corrupt pending-marker quarantine only after explicit cancellation;
- Registry round-trip without exposing an absolute archive path.

The final isolated three-cycle assertion ended with six valid managed backups (three user backups plus three pre-restore backups), no invalid backups, and `integrity_check=ok` after every applied restore.

## Browser evidence

The browser path used the real Settings UI and the isolated backend, not direct database edits.

### Stage restore

```json
{"backupCount":1,"disabledBeforePhrase":true,"enabledAfterPhrase":true,"pendingRestartVisible":true,"consoleErrors":[],"screenshot":"docs/evals/reports/artifacts/data-safety-01/settings-stage.png"}
```

The UI created a backup, ran an integrity check, required the exact confirmation phrase `恢复`, staged the restore, and showed the pending-restart banner. The restore did not replace live data while the application remained open.

### Restart recovery and cancellation

After stopping the isolated server and starting it again with the same isolated root, `/api/health` reported:

```json
{"startup_restore":{"applied":true,"reason":"restored_before_database_connect","backup_id":"05b0c777c2014aaba4237974d84d74ac","pre_restore_backup_id":"561cf24a50bb484e8764d7d7393fa3da"}}
```

The restart browser check then reported:

```json
{"countAfterRestart":2,"pendingAfterRestart":0,"cancelVisible":true,"consoleErrors":[],"screenshot":"docs/evals/reports/artifacts/data-safety-01/settings-restart.png"}
```

The second restore was staged, visibly cancelled, and left the source backups available. The normal OfferU server was subsequently restarted and returned to `./djm.db` with `startup_restore.applied=false` and HTTP 200.

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R45 Consistent Backup | PASS | Online Backup API, managed asset snapshot, manifest/hash validation, and Doctor visibility are implemented and tested. |
| R46 Restore 3 cycles | PASS | Three isolated restore/restart cycles passed; database, assets, integrity, and recovery material were checked. |
| R49 SQLite Integrity | PASS | Restore and Doctor verify `integrity_check=ok`; foreign-key violations were zero in the exercised fixtures. |
| R76 Golden Path F — Data Recovery | PASS for the recovery slice | Real Settings UI staged/cancelled restore and a restarted isolated backend applied a verified restore; this does not inherit unrelated Public Release E2E claims. |
| R43 Database Migration | FAIL | No versioned migration path or old-database A/B fixture has been proven. |
| R44 Migration Safety | FAIL | Backup-before-migration, migration integrity/smoke, and atomic migration rollback are still unimplemented. |

## Limitations and next gate

- This report does not prove the 24-task `offeru-core-v1` baseline, 10/10 repeatability, 50-run stability, packaging, security, live provider, or clean-machine gates.
- Migration safety remains the highest Data Safety blocker: implement versioned migration, backup-before-migration, integrity/smoke verification, and failure rollback using old-schema fixtures.
- Backup retention policy, encryption at rest, cloud sync, and arbitrary external-file transactionality are outside this local single-user gate.
- The current Doctor now covers database integrity and backup state, but not the complete desktop bridge, storage, and version-consistency release contract.
- The browser screenshots are local, task-specific, and contain only fixture data; they are not a substitute for the complete release artifact set.

## Machine-readable eval summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "data-safety-01",
  "target_scope": "core-baseline",
  "started_at": "2026-08-31T09:19:06+08:00",
  "finished_at": "2026-08-31T09:19:06+08:00",
  "executor": {
    "agent": "Codex",
    "model": "GPT-5"
  },
  "environment": {
    "commit": "3e3984e",
    "dirty_files": [
      "backend/app/cli.py",
      "backend/app/main.py",
      "backend/app/ops.py",
      "backend/app/routes/main_agent.py",
      "backend/app/services/data_safety.py",
      "backend/tests/test_cli_ops.py",
      "backend/tests/test_data_safety.py",
      "frontend/src/app/settings/page.tsx",
      "frontend/src/lib/api.ts",
      ".tmp/",
      "GOAL.md",
      "_ui_preview/"
    ],
    "os": "Windows with PowerShell",
    "python": "3.12.0 via backend/.venv312/Scripts/python.exe",
    "node": "v24.14.0 / npm 11.9.0",
    "offeru_cli": "local CLI; doctor/manifest/playbook reported 244 operations",
    "provider": "Replay-capable local runtime; no external credentials",
    "provider_model": "not applicable; Data Safety gate is deterministic",
    "data_isolation": "proven"
  },
  "engineering_checks": [
    {
      "name": "data_safety_targeted",
      "status": "PASS",
      "command": "backend\\.venv312\\Scripts\\python.exe -m pytest tests/test_data_safety.py -q",
      "exit_code": 0,
      "duration_ms": null,
      "artifact": "backend/tests/test_data_safety.py"
    },
    {
      "name": "data_safety_cli_contract",
      "status": "PASS",
      "command": "backend\\.venv312\\Scripts\\python.exe -m pytest tests/test_data_safety.py tests/test_cli_ops.py -q",
      "exit_code": 0,
      "duration_ms": 104340,
      "artifact": "backend/tests/test_cli_ops.py"
    },
    {
      "name": "backend_full_regression",
      "status": "PASS",
      "command": "backend\\.venv312\\Scripts\\python.exe -m pytest tests -q",
      "exit_code": 0,
      "duration_ms": 314620,
      "artifact": "backend/tests/test_data_safety.py"
    },
    {
      "name": "frontend_typecheck",
      "status": "PASS",
      "command": "npm run typecheck",
      "exit_code": 0,
      "duration_ms": null,
      "artifact": "frontend/tsconfig.json"
    },
    {
      "name": "frontend_build",
      "status": "PASS",
      "command": "npm run build",
      "exit_code": 0,
      "duration_ms": 14680,
      "artifact": "frontend/dist"
    },
    {
      "name": "offeru_doctor",
      "status": "PASS",
      "command": "backend\\.venv312\\Scripts\\python.exe -m app.cli doctor --pretty",
      "exit_code": 0,
      "duration_ms": null,
      "artifact": "STATUS.md"
    },
    {
      "name": "isolated_browser_stage_restore",
      "status": "PASS",
      "command": "Playwright Settings UI stage-restore flow against isolated backend",
      "exit_code": 0,
      "duration_ms": null,
      "artifact": "docs/evals/reports/artifacts/data-safety-01/settings-stage.png"
    },
    {
      "name": "isolated_browser_restart_cancel",
      "status": "PASS",
      "command": "Playwright Settings UI restart-recovery and cancel flow against isolated backend",
      "exit_code": 0,
      "duration_ms": null,
      "artifact": "docs/evals/reports/artifacts/data-safety-01/settings-restart.png"
    }
  ],
  "totals": {
    "pass": 0,
    "fail": 0,
    "blocked": 0,
    "not_run": 24,
    "invalid": 0
  },
  "verdicts": {
    "required_tasks": "NOT_RUN",
    "core_journey": "NOT_RUN",
    "integration_claims": "NOT_RUN",
    "overall": "NOT_RUN"
  },
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
    {"id":"CORE-RES-001","class":"integration","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Resume integration not assessed by this gate report."]},
    {"id":"CORE-APP-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full core baseline not run."]},
    {"id":"CORE-FUP-001","class":"integration","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Email integration not exercised."]},
    {"id":"CORE-SEC-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full security baseline not run."]},
    {"id":"CORE-SEC-002","class":"required","status":"NOT_RUN","trials_required":1,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed."],"failed_assertions":[],"limitations":["Full security baseline not run."]},
    {"id":"CORE-RESIL-001","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full long-task contract."],"failed_assertions":[],"limitations":["This report's restore restart evidence is narrower than the suite task."]},
    {"id":"CORE-RESIL-002","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full operation retry contract."],"failed_assertions":[],"limitations":["This report's restore idempotency evidence is narrower than the suite task."]},
    {"id":"CORE-RESIL-003","class":"required","status":"NOT_RUN","trials_required":3,"trials_passed":0,"commands":[],"trajectory_evidence":["Not run in this gate-scoped report."],"outcome_evidence":["Not assessed as the full provider failure contract."],"failed_assertions":[],"limitations":["Full provider failure matrix not run."]}
  ],
  "metrics": {
    "pass_at_1": null,
    "pass_power_3": null,
    "tool_argument_validity": null,
    "latency_p50_ms": null,
    "latency_p95_ms": null
  },
  "security_findings": [],
  "limitations": [
    "This is a DATA_SAFETY_01 gate report, not a complete offeru-core-v1 baseline.",
    "R43 and R44 versioned migration and migration rollback remain open.",
    "External providers, packaging, clean-machine installation, soak, and full release security gates were not run."
  ],
  "recommended_decision": "run-more-evals"
}
```
