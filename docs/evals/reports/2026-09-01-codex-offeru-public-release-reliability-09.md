# OfferU Public Release Reliability 09 — real CareerTask worker matrix

日期：2026-09-01  
范围：隔离 SQLite、真实 `8765` FastAPI backend、Replay provider

## 目的

补充 Reliability-05 的 100-cycle HTTP workload 与 Reliability-08 的浏览器重复边界，直接验证长任务控制面在真实 backend 进程中的连续执行：

```text
POST Job ingest
→ JOB_SAVED AutomationEvent
→ CareerTask worker
→ Role Intelligence Replay
→ durable lifecycle events
→ completion projection
```

每个周期使用唯一 Job、batch 和 hash key；所有周期串行执行，避免把并发压力与业务幂等结论混在一起。测试使用全新隔离 SQLite，未读取或写入正常工作区 `backend/djm.db`。

## 执行

```text
python backend/scripts/e2e/test_public_release_worker_soak.py
```

脚本通过公开 HTTP 路径创建岗位并读取验收结果，不直接修改数据库。每个 CareerTask 必须完成，并且必须具有 `task.queued`、`task.started`、`task.completed` 三类持久化生命周期事件。

## 结果

```json
{
  "status": "PASS",
  "cycles_requested": 100,
  "cycles_completed": 100,
  "unique_jobs": 100,
  "unique_tasks": 100,
  "unique_automation_events": 100,
  "task_statuses": ["completed"],
  "task_attempts": 1,
  "database_integrity": ["ok"],
  "foreign_key_violations": [],
  "elapsed_seconds": 62.872,
  "runtime_provider": "replay"
}
```

未发现：

- worker task 失败、阻塞或取消；
- 自动化事件重复分发；
- CareerTask 重复创建；
- 单个周期多次 attempt；
- 缺少 queued/started/completed 生命周期事件；
- SQLite integrity 或 foreign-key violation。

## 发布映射

| Requirement | Status | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | 100 个真实 backend AutomationEvent → CareerTask worker 周期全部完成且事件唯一；provider timeout、跨进程 retry/cancel/resume 仍缺 |
| R35 CareerTask lifecycle | PARTIAL | 100/100 durable task lifecycle 完成；waiting approval、worker force-stop/restart 和完整多 Provider matrix 仍缺 |
| R62 Soak Test | PARTIAL | 100 个真实 worker cycles、0 error、integrity 通过；运行约 63 秒，不等价于 2 小时 endurance |
| R63 Memory / Resource Leak | PARTIAL | 本报告增加连续 worker workload；RSS 长时测量仍由 Reliability-05 的短时 3.01% 证据覆盖，未升级为长期 PASS |
| R74 Duplicate Mutation | PARTIAL | 本报告确认 100 个唯一 Job/task/event；浏览器 double-click/transport retry 见 Reliability-08，完整并发 worker retry 矩阵仍缺 |
| R79 Full Test Gate | NOT_VERIFIED | 本报告是运行 workload，不替代 full backend/frontend/desktop release verification |

## 限制与非声明

本报告不证明 2 小时 endurance、并发 worker 压力、backend force-stop 后任务恢复、真实 Provider 网络超时、签名 installer、clean-machine 或 Public Release Ready。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "reliability-09",
  "target_scope": "real-backend-career-task-worker-100-cycles",
  "evidence_date": "2026-09-01",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "100_real_http_worker_cycles",
    "100_unique_jobs",
    "100_unique_career_tasks",
    "100_unique_automation_events",
    "all_tasks_completed_once",
    "durable_lifecycle_events_present",
    "sqlite_integrity_ok",
    "zero_foreign_key_violations",
    "isolated_database"
  ],
  "partial_subchecks": [
    "short_duration_not_two_hour_endurance",
    "serial_not_concurrent_worker_stress",
    "no_cross_process_restart_matrix",
    "replay_provider_only"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-long-duration-and-cross-process-reliability-verification"
}
```
