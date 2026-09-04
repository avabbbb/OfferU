# OfferU Core v1 Reliability 05 — real backend mixed workload and RSS

日期：2026-08-31  
观察 checkout：`f2fa8f1`  
实现 commit：无代码变更；本轮为运行证据与文档更新  
结论：`PARTIAL`

## Scope

本轮在全新隔离 SQLite 和真实 FastAPI backend 进程 `127.0.0.1:8765` 上执行 100 个串行混合周期。隔离数据库为：

```text
C:\Users\ava\AppData\Local\Temp\offeru-soak-real-20260831-03\soak.db
```

没有读取或写入正常 `backend/djm.db` 的职业数据。隔离库只包含：3 个岗位、1 个 Profile、1 份 Resume、1 个 Application、12 个待审 Memory Proposal。测试结束后使用普通 backend 恢复启动，并验证健康、诊断包和数据库完整性路径。

## Reference environment

```text
OS: Windows-11-10.0.26200-SP0
Python: 3.12.0
CPU logical processors: 12
RAM: 16,800,157,696 bytes
C: free disk: 85,120,823,296 bytes
Backend: local-development, real Python process, port 8765
Runtime used by interview fixture: replay
Warm-up: 10 read-surface cycles
Soak: 100 cycles, sequential, no artificial concurrency
```

## Workload method

每个周期执行以下真实 HTTP 路径：

1. 读取 health、Job 列表/详情、Resume 列表/详情、Application、Memory Inbox、Automation Inbox、CareerTask 列表；
2. 通过 `PUT /api/resume/{id}` 写入一次隔离 Resume 摘要；
3. 前 12 个周期分别审核一个预置 Candidate，偶数接受、奇数拒绝；
4. 每 10 个周期通过 Automation Event 和 CareerTask 的 UI proposal boundary 各提交一次请求；
5. 每 10 个周期创建并提交 1 次 Replay 短面试回答，共 10 次，产生真实 EvaluationRun、Observation 和 pending Memory Proposal；
6. 每个 warm-up/soak 样本读取 backend RSS；结束时通过 Registry-backed integrity endpoint 检查数据库。

Automation Event 与 CareerTask 的 UI 路径按当前安全设计只持久化待确认 proposal，没有绕过确认门直接执行副作用。此前 Reliability-01 已单独证明 100 个 Replay CareerTask worker cycle；本轮不把 proposal creation 误报成 worker completion。

## Result

```json
{
  "cycles_requested": 100,
  "cycles_completed": 100,
  "errors": [],
  "interviews_completed": 10,
  "rss_before_bytes": 125263872,
  "rss_warmup_median_bytes": 127422464,
  "rss_warmup_last_bytes": 127455232,
  "rss_end_bytes": 131256320,
  "rss_peak_bytes": 131256320,
  "rss_sample_count": 110,
  "rss_growth_bytes_after_warmup": 3833856,
  "rss_growth_ratio_after_warmup": 0.030088,
  "database_integrity": "ok",
  "foreign_key_violations": 0
}
```

warm-up 后 RSS 净增约 `3.66 MiB / 3.01%`，低于当前 `20%` 资源门槛；本次 100 周期未发生 crash、HTTP 错误或持续增长迹象。测量总运行时间约 15.3 秒，因此它不是 2 小时 endurance proof。

### HTTP latency summary

| Operation group | Count | Median | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Read surface（10 个 GET） | 110 | 207.443 ms | 270.900 ms | 309.987 ms |
| Resume write | 100 | 51.909 ms | 69.747 ms | 137.570 ms |
| Candidate review | 12 | 73.312 ms | 106.225 ms | 107.910 ms |
| Automation proposal | 10 | 57.354 ms | 65.914 ms | 67.546 ms |
| CareerTask proposal | 10 | 61.960 ms | 64.568 ms | 65.190 ms |
| Short Replay interview | 10 | 227.571 ms | 241.892 ms | 264.015 ms |

### Persisted state after the run

```text
Resume: 1
ResumeSection: 1
Application: 1
Interview: 10 completed
InterviewMessage: 20
InterviewEvaluationRun: 10 completed
LearningObservation: 22 active
MemoryProposal: 6 accepted, 6 rejected, 10 pending
AgentRun: 20 waiting_confirmation
AgentRunEvent: 60
CareerTask: 0
AutomationEvent: 0
OperationAuditLog: 603
```

`CareerTask: 0` 和 `AutomationEvent: 0` 是预期结果：本轮通过 UI proposal boundary 测量了提案持久化，而非绕过用户确认执行；对应的 20 个 Agent Run 均保持 `waiting_confirmation`，没有伪造完成。10 次 Replay Interview 均完成，Learning handoff 新增 10 条观察和 10 条待审提案，没有直接写入 Profile。

直接 SQLite 校验结果：`PRAGMA integrity_check = ok`，`PRAGMA foreign_key_check` 为空。

## Normal workspace restoration

隔离 backend 停止后，正常 `backend/djm.db` backend 以受控本地进程恢复。沙箱内 Python 进程曾因 workspace 写权限把真实 SQLite 误报为 readonly；使用受控 elevated runtime 复验后，SQLite 文件和目录写入探针均通过，随后真实诊断审计写入恢复正常：

```text
/api/health                         200
/api/agent/diagnostics/bundle       200
/api/agent/data/safety/integrity    200
```

正常数据库健康响应为 `database_path=djm.db`、`startup_restore.applied=false`；诊断包不包含 Profile/Job/Resume 内容、凭据或请求 headers；完整性响应为 `ok` 且 foreign-key violations 为 0。正常数据库岗位读取仍返回原有数据规模（463 条），没有被隔离 fixture 污染。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | 100-cycle real backend proposal path 无错误；Automation Event 的真实执行/幂等、重启和 provider failure 全矩阵仍缺 |
| R35 CareerTask lifecycle | PARTIAL | 本轮 10 次 UI proposal boundary 成功；Reliability-01 已有 100 worker cycle，跨进程 mixed worker/RSS 仍缺 |
| R36 Restart Recovery | PARTIAL | 本轮隔离 backend 可停止并恢复正常 workspace；没有把 soak 误报成 running task force-stop recovery |
| R62 Soak Test | PARTIAL | 100 个真实 HTTP 混合周期、0 错误；运行时长短于 2 小时，且 Agent/Automation 为待确认 proposal，完整 Public soak 未通过 |
| R63 Memory / Resource Leak | PARTIAL | warm-up 后 RSS 增长 3.01%，低于 20% 门槛；仅 110 个采样、约 15.3 秒，不足以声明长期无 leak |
| R74 Duplicate Mutation | PARTIAL | post-run 计数无意外重复 Resume/Interview/Observation/Proposal；本轮未注入 double-click/network retry，全部 mutation matrix 仍缺 |
| R79 Full Test Gate | NOT_VERIFIED | 本轮是运行测量，不替代 backend/frontend/browser/desktop full verification |

## Explicit non-claims

本报告不证明：

- 2 小时 endurance、生产 bundle 性能或五项 UI Performance SLO；
- Automation Event/CareerTask 在用户确认后的完整 worker 执行、cancel/retry/resume 和跨进程 exactly-once；
- Resume/Application/Interview answer/Memory review 的 double-click、network retry、crash recovery 全矩阵；
- live Provider、浏览器 Golden Path、Packaging、Security residual 或 Public Release readiness。

## Next autonomous work

1. 继续 Reliability：用隔离库完成 Resume/Application/Interview answer/Memory review 的重复点击、网络重试和 restart mutation matrix；
2. 再运行 artifact/capability canary 与 Rust advisory、权限 diff、logging/PII、privacy/consent residual；
3. 保持 normal `djm.db` backend 可用，不把受控 elevated runtime 误当成产品代码修复。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-05",
  "target_scope": "real-backend-mixed-workload-rss",
  "evidence_date": "2026-08-31",
  "observed_checkout": "f2fa8f1",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "100_real_http_cycles",
    "zero_workload_errors",
    "rss_growth_below_20_percent",
    "sqlite_integrity_ok",
    "zero_foreign_key_violations",
    "normal_database_restored",
    "normal_diagnostic_write_verified"
  ],
  "partial_subchecks": [
    "proposal_boundary_not_worker_completion",
    "short_duration_not_endurance",
    "no_full_duplicate_mutation_matrix",
    "no_full_browser_or_provider_matrix"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-mutation-matrix-and-security-residual"
}
```
