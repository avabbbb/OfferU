# OfferU Public Release Reliability 10 — cross-process CareerTask claim

日期：2026-09-01  
范围：两个独立 Python worker 进程、同一隔离 SQLite、Replay provider

## 目的

补齐 Reliability-09 仍缺的跨进程执行 claim：进程内 `_LIVE_TASKS` 只能阻止同一 event loop 的重复调度，不能作为两个本地 backend 进程之间的协调机制。本轮将 `queued → running` 改为数据库条件更新，并在两个独立进程同时提交同一 `idempotency_key` 后验证持久化任务只被一个进程执行。

## 执行

```text
python backend/scripts/e2e/test_public_release_worker_concurrency.py
```

脚本创建临时数据库，预先完成 schema 初始化，然后启动两个独立 Python 子进程。两个进程通过同一 CareerTask service 提交同一个 Replay `agent_turn`；结果读取只用于验收，不写入正常工作区 `backend/djm.db`。

## 结果

```json
{
  "status": "PASS",
  "workers": 2,
  "task_id": "career_task_c4c8bd04eae14f119445",
  "task_status": "completed",
  "attempt_count": 1,
  "task_started_events": 1,
  "task_completed_events": 1,
  "elapsed_seconds": 7.209
}
```

验证通过：

- 两个进程返回同一个持久化 `task_id`；
- CareerTask 只完成一次，`attempt_count=1`；
- `task.started` 与 `task.completed` 各只有一条；
- 两个进程共享的隔离数据库初始化、任务执行和结果读取均成功。

## 实现边界

`_claim_task()` 使用 `UPDATE ... WHERE status='queued'` 作为跨进程执行 claim。竞争进程发现条件更新没有命中后退出，不重复运行 Provider。Retry 与 cancel 也改为条件更新，避免同一状态转换由多个进程重复提交。

## 发布映射

| Requirement | Status | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | CareerTask 跨进程 claim 已通过；provider timeout、跨进程 cancel/resume 和完整 AutomationEvent 竞争矩阵仍缺 |
| R35 CareerTask lifecycle | PARTIAL | 两进程共享数据库时 lifecycle 只提交一次；waiting approval、force-stop/restart 和多 Provider 仍缺 |
| R62 Soak Test | PARTIAL | Reliability-09 的 100-cycle worker 与本轮双进程 claim 均通过；2 小时 endurance 仍缺 |
| R74 Duplicate Mutation | PARTIAL | 同一 idempotency key 的两个独立进程只产生一个执行 effect；Job ingest、provider/network 和全部 mutation 并发矩阵仍缺 |
| R79 Full Test Gate | NOT_VERIFIED | 本报告不替代全量 backend/frontend/desktop release verification |

## 限制与非声明

本报告不证明跨进程所有任务类型、Provider 网络超时、进程强退、任务恢复、正式 installer、clean-machine 或 Public Release Ready。SQLite 单机本地应用仍应保持单一受管 backend 进程；本轮验证的是重复调度时的 fail-safe claim，而不是为多进程部署建立 SaaS worker 集群。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "reliability-10",
  "target_scope": "cross-process-career-task-claim",
  "evidence_date": "2026-09-01",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "two_independent_workers",
    "same_idempotency_key_reused",
    "one_task_id",
    "one_attempt",
    "one_started_event",
    "one_completed_event",
    "isolated_database"
  ],
  "partial_subchecks": [
    "not_all_task_types",
    "no_force_stop_matrix",
    "no_provider_network_timeout_matrix",
    "no_two_hour_endurance"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-provider-restart-and-long-duration-reliability-verification"
}
```
