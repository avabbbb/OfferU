# OfferU Public Release — portable CI browser smoke

日期：2026-09-01  
观察 checkout：当前工作树  
结论：`PARTIAL`

## Scope

本轮把新用户 Public Release 冒烟从本机临时脚本整理为：

```text
backend/scripts/e2e/test_public_release_smoke.py
```

脚本使用 Playwright managed Chromium、隔离 browser context 和显式 `replay` provider，不依赖开发者机器的 Chrome 路径，也不直接写数据库跳过用户流程。失败时才保存 screenshot 和 trace；成功不留下大体积 trace。

`.github/workflows/build.yml` 新增 `browser-smoke` job，并按场景建立三个相互隔离的
matrix runner：

```text
isolated SQLite (empty / smoke / interview)
→ Python backend 8765
→ Vite frontend 7410
→ Playwright Chromium
→ scenario-specific browser path
→ smoke runner: CareerTask worker 100-cycle + cross-process claims
→ failure-only artifact upload
```

Desktop package 与 tag release 都依赖该 job。

## Local verification

使用新的临时 SQLite、真实本地后端和真实前端页面执行：

```text
Profile onboarding                                  PASS
Create first Job through visible UI                 PASS
Double-click Job submit                             PASS / one Job + one task
Automatic Replay Role Intelligence                  PASS
Committed-then-503 transport retry                  PASS / two attempts, one effect
Job Detail packet projection                        PASS
Actionable empty states (Today/Pipeline/Opportunity/Profile/Resume) PASS
Unexpected HTTP responses                           0
Unexpected console errors                           0
page errors                                          0
Interview Focus → Debrief → Learning               PASS / replay fixture
```

机器结果：

```json
{
  "status": "PASS",
  "task_status": "completed",
  "runtime_provider": "replay",
  "retry_task_status": "completed",
  "transport_attempts": 2,
  "expected_transport_failure": "503 /api/jobs/ingest",
  "bad_responses": ["503 /api/jobs/ingest"],
  "console_errors": ["expected 503 resource error"],
  "page_errors": []
}
```

临时数据库只用于这次 smoke，正常 `djm.db` 在测试结束后恢复并通过 `/api/health`。同一 CI job 还执行 [Reliability-09 worker matrix](2026-09-01-codex-offeru-public-release-reliability-09.md)，本机 100/100 cycles 通过。空状态脚本在同一隔离后端上覆盖 Today、Pipeline、Opportunity、Profile 和 Resume，均通过且没有 HTTP/console/page error。
Interview learning 脚本另外在全新隔离数据库上通过 Focus Plan、模糊回答追问、transcript-backed Debrief 和 Profile Learning Candidate accept；详见 [Interview learning E2E](2026-09-01-codex-offeru-public-release-interview.md)。

## CI boundary

本地已完成：

- GitHub Actions YAML parse；
- `browser-smoke` 三场景 matrix 与 dependency graph 检查；
- managed Chromium 本机执行；
- 双击提交与已提交后 503 transport retry 本机执行；
- Today/Pipeline/Opportunity/Profile/Resume 空状态矩阵本机执行（fresh DB）；
- Interview Focus → Interviewer Mode → Debrief → Learning Candidate 本机执行（fresh DB）；
- 真实 backend 100-cycle CareerTask worker matrix 本机执行；
- 失败 trace/screenshot 代码路径。

本轮没有远程 GitHub runner 执行，因此以下仍不是 PASS：

- Ubuntu runner 的真实安装与 Playwright dependency setup；
- CI 失败时 artifact upload；
- tag release 的 Windows package/sign/verify；
- clean-machine installer UI acceptance。

不能把本地 smoke 当作远程 CI、签名或 Public Release 结论。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R68 Browser E2E philosophy | `PARTIAL` | portable script uses visible UI and verifies duplicate/retry effects; remote CI execution still missing |
| R69 Playwright isolation | `PASS` for this smoke | each scenario has a fresh browser context and scenario-specific isolated SQLite |
| R70 Failure artifacts | `PARTIAL` | failure-only trace/screenshot path implemented; runner upload not executed |
| R12 Empty States | `PARTIAL` | isolated browser matrix covers Today/Pipeline/Opportunity/Profile/Resume with actionable copy; full installer/human path remains |
| R27–R30 Interview learning | `PARTIAL` | [Interview learning E2E](2026-09-01-codex-offeru-public-release-interview.md) covers Focus Plan, vague-answer follow-up, transcript-backed Debrief and Profile Candidate acceptance with replay; live provider/full lifecycle remains |
| R71 New-user Golden Path | `PARTIAL` | local new-user preparation, duplicate submit, transport retry and empty-state smoke pass; full installer/human path remains |
| R74 Duplicate Mutation | `PARTIAL` | browser double-click/committed-then-503 retry passes; full concurrent worker/provider matrix remains |
| R92 CI Release Pipeline | `PARTIAL` | three-scenario isolated browser matrix, 100-cycle worker step and dependency chain are configured; remote run remains unverified |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "suite_version": "1.0.0",
  "run_id": "ci-browser-smoke",
  "evidence_date": "2026-09-01",
  "verdict": "PARTIAL",
  "local_smoke": {
    "status": "PASS",
    "provider": "replay",
    "duplicate_submit": {"jobs": 1, "role_tasks": 1},
    "transport_retry": {"attempts": 2, "expected_503": 1, "business_effects": 1},
    "unexpected_bad_responses": 0,
    "unexpected_console_errors": 0,
    "page_errors": 0
  },
  "interview_learning": {
    "status": "PASS_FIXTURE_REPLAY",
    "focus_plan": true,
    "interviewer_follow_up": true,
    "debrief_transcript_citation": true,
    "learning_candidate": "accepted",
    "browser_errors": 0
  },
  "empty_state_matrix": {
    "status": "PASS",
    "routes": ["/", "/jobs", "/applications?view=board", "/profile", "/resume"],
    "unexpected_bad_responses": 0,
    "console_errors": 0,
    "page_errors": 0
  },
  "scenario_isolation": {
    "status": "CONFIGURED",
    "scenarios": ["empty", "smoke", "interview"],
    "database_per_scenario": true
  },
  "worker_matrix": {
    "status": "PASS",
    "cycles": 100,
    "unique_jobs": 100,
    "unique_tasks": 100,
    "unique_automation_events": 100
  },
  "ci_runner_executed": false,
  "remote_release_verified": false,
  "public_release": "NOT_READY"
}
```
