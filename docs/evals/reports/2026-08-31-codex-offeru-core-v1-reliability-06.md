# OfferU Core v1 Reliability 06 — mutation idempotency and restart retry

日期：2026-08-31  
观察 checkout：`f2fa8f1` 加本轮未提交工作树变更  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮针对 Reliability-05 暴露的重复 mutation 风险，在全新隔离 SQLite 和真实 FastAPI backend `127.0.0.1:8765` 上验证：

```text
Resume same-payload retry
Application auto-write retry
legacy Application create retry
legacy Application status retry
Memory accept/reject retry
concurrent Replay interview answer
interview answer retry after backend restart
```

隔离数据库为：

```text
C:\Users\ava\AppData\Local\Temp\offeru-soak-real-20260831-05\soak.db
```

测试没有使用正常 `backend/djm.db` 的职业数据。完成后停止隔离 backend，恢复正常 backend，并验证 `djm.db`、诊断包、完整性和岗位读取。

## Baseline before the fix

在另一份从同一 fixture 复制的隔离库 `offeru-soak-real-20260831-04` 上先运行相同矩阵，确认了本轮要修的真实行为：

| Mutation | Before fix |
| --- | --- |
| identical Resume update | HTTP 200，但 `workspace_revision` 从 `100` 推进到 `102` |
| legacy Application create retry | 两次请求返回不同 Application id，产生重复记录 |
| Memory reject retry | 第二次相同 reject 返回 HTTP 400 |

Concurrent Interview answer 和 restart retry 在 baseline 中已经表现为单次 business effect，因此本轮保留它们作为回归矩阵。

## Changes under test

- legacy Application create 按 `job_id` 串行化，并复用已存在的 Application；
- Application workspace auto-write 使用已有总表记录跳过逻辑；
- Resume 仅在实际内容变化时更新 section 和 `workspace_revision`；
- Memory proposal 对同一终态的重复 review 返回 `duplicate=true`，不同终态仍拒绝；
- legacy Application status update 不重复改变 `submitted_at` 或已相同的字段。

正式业务变化仍由现有服务和 Operation Registry 负责；本轮没有新增平行状态表或绕过确认门。

## Deterministic regression tests

执行：

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_reliability06_mutations.py -q
3 passed, 1 warning

backend\.venv312\Scripts\python.exe -m pytest tests\test_reliability06_mutations.py tests\test_application_workspace_legacy.py tests\test_resume_workspace.py -q
7 passed, 2 warnings
```

测试覆盖 legacy Application create/status、Resume identical payload/revision、Memory terminal review retry。

## Real backend mutation matrix

在新隔离库上通过真实 HTTP API 执行，结果如下：

| Case | Result |
| --- | --- |
| Resume identical payload | 首次 `duplicate=false`，重试 `duplicate=true`；revision `100→101`；Resume/Section 行数不增加 |
| Application auto-write | 首次将总表记录 `0→1`；重试仍为 1 条并安全跳过；两次 HTTP 请求均成功 |
| legacy Application create | 首次返回 id `2`、`duplicate=false`；重试仍返回 id `2`、`duplicate=true`；Application 总数只增加 1 |
| legacy Application status | 首次更新成功；相同状态重试 `duplicate=true`；`submitted_at` 不被重新写入 |
| Memory accept | 首次 `duplicate=false`；相同 accept 重试 `duplicate=true`，均为 HTTP 200 |
| Memory reject | 首次 HTTP 200；相同 reject 重试 HTTP 200、`duplicate=true` |
| concurrent Replay answer | 两个并发请求一真一重复；只新增 1 个 EvaluationRun、2 条消息、1 条 Observation、1 条 Proposal |

隔离库在矩阵前后关键计数为：

```text
Application       1 → 2
ApplicationRecord 0 → 1
Interview         10 → 11
InterviewMessage  20 → 22
EvaluationRun     10 → 11
Observation       22 → 23
MemoryProposal    22 → 23
```

除明确的一次新 Application、一次 auto-write、一次并发 Interview 外，没有因 retry 产生额外 business effect。

## Restart retry

完成上述矩阵后停止真实 backend，再用同一隔离库重新启动。对同一 Interview answer 再次提交：

```text
HTTP 200
duplicate=true
```

EvaluationRun、InterviewMessage、Observation 和 MemoryProposal 计数没有再次增加，证明 answer idempotency key 和持久化结果跨进程重启仍然有效。

## Normal workspace restoration

隔离 backend 停止后，正常 `djm.db` backend 恢复在 `8765`。复核结果：

```text
/api/health                         200
/api/agent/diagnostics/bundle       200
/api/agent/data/safety/integrity    200
/api/jobs/?page_size=1              200, total=463
```

health 返回 `database_path=djm.db`、`runtime_mode=local`；诊断包不包含 Profile/Job/Resume 内容、凭据或请求 headers；完整性为 `ok`，foreign-key violations 为 0。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | auto-write retry 已通过；后台 Automation/CareerTask worker 的全量 exactly-once、cancel/retry/resume 仍缺 |
| R35 CareerTask lifecycle | PARTIAL | 本轮没有改变既有 worker 结论；Reliability-01/05 的局部 evidence 保留 |
| R36 Restart Recovery | PARTIAL | Interview answer 的持久化 retry 跨真实 backend restart 通过；完整 running task、approval、browser 矩阵仍缺 |
| R62 Soak Test | PARTIAL | duplicate mutation 矩阵已补齐，但不是 2 小时 endurance 或完整 worker soak |
| R63 Memory / Resource Leak | PARTIAL | 本轮未增加长期资源测量；Reliability-05 的 100-cycle RSS evidence 保留 |
| R74 Duplicate Mutation | PARTIAL | Resume、Application、Memory review、并发 Interview answer 和 restart retry 已有真实证据；完整 UI/network fault/browser matrix 仍缺 |
| R79 Full Test Gate | NOT_VERIFIED | 定向回归通过；本轮不替代 backend/frontend/browser/desktop full verification |

## Explicit non-claims

本报告不证明：

- 2 小时 endurance、生产 bundle 性能或 UI Performance SLO；
- 所有正常 web API 在真实网络重试下的 transport-level exactly-once；
- CareerTask/AutomationEvent 完整 worker 的跨进程 retry/cancel/resume；
- 浏览器 Resume/Application/Memory 全流程、跨标签冲突或 live Provider；
- Security residual、Packaging、Installer、Public Release readiness。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-06",
  "target_scope": "real-backend-mutation-idempotency-restart",
  "evidence_date": "2026-08-31",
  "observed_checkout": "f2fa8f1",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "resume_same_payload_idempotent",
    "application_auto_write_idempotent",
    "legacy_application_create_idempotent",
    "legacy_application_status_idempotent",
    "memory_terminal_review_idempotent",
    "concurrent_interview_answer_exactly_once",
    "interview_answer_retry_after_restart",
    "targeted_regression_tests",
    "normal_database_restored"
  ],
  "partial_subchecks": [
    "no_two_hour_endurance",
    "no_full_transport_retry_matrix",
    "no_full_worker_or_browser_matrix"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-security-residual-and-public-release-evidence"
}
```
