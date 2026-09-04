# OfferU Public Release — Reliability Gate Reconciliation

日期：2026-09-01  
范围：隔离 SQLite、真实本地 FastAPI backend、Replay runtime  
结论：`PASS`（针对 Goal 定义的 100 个代表性 task cycles；不宣称 2 小时 endurance）

## Gate interpretation

Public Release Goal 的 Soak Test 要求是：

```text
2 小时
或
100 个代表性 task cycles
```

因此，2 小时不是与 100 个代表性 task cycles 叠加的额外必要条件。本报告把两个已经独立完成的 workload 组合起来复核边界：

```text
Reliability-05
→ 100 个真实 backend 混合 HTTP 周期
→ RSS warm-up 后增长 3.01%

Reliability-09
→ 100 个真实 CareerTask worker 周期
→ 每个 Job / Task / AutomationEvent 唯一且完成一次
```

两套 workload 都使用隔离数据库，不读取或写入正常用户工作区。

## Evidence

### Representative task cycles

`2026-09-01-codex-offeru-public-release-reliability-09.md` 的真实 worker 脚本完成：

```json
{
  "cycles_requested": 100,
  "cycles_completed": 100,
  "unique_jobs": 100,
  "unique_tasks": 100,
  "unique_automation_events": 100,
  "task_statuses": ["completed"],
  "task_attempts": 1,
  "database_integrity": ["ok"],
  "foreign_key_violations": [],
  "runtime_provider": "replay"
}
```

这满足 Goal 的 `100 representative task cycles` alternative，并且没有把短时运行误报为 2 小时 endurance。

### Resource boundary after 100 cycles

`2026-08-31-codex-offeru-core-v1-reliability-05.md` 在 100 个真实 backend 混合周期中记录 110 个 RSS 样本：

```text
rss_growth_ratio_after_warmup = 0.030088
database_integrity = ok
foreign_key_violations = 0
errors = []
```

该增长低于 Goal 的 `20% after 100 cycles` 门槛，因此 Memory / Resource Leak 的当前 Gate 通过。它仍然不证明任意长时间 workload 都没有资源泄漏。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R62 Soak Test | `PASS` | 100 个真实 CareerTask worker cycles 满足 Goal 的替代门槛；SQLite integrity/FK clean；2 小时时长仍是未执行的等价验证方式 |
| R63 Memory / Resource Leak | `PASS` | 100 个真实混合 backend cycles 后 warm-up RSS 增长 `3.01% < 20%`，无 workload error |
| R34 Automation Reliability | `PARTIAL` | worker cycles 通过；provider timeout、全 mutation 并发和跨进程 cancel/resume 仍由其他 Gate 覆盖或待验证 |
| R35 CareerTask lifecycle | `PARTIAL` | 100 个 queued→started→completed worker lifecycle 通过；waiting approval、force-stop/restart 全矩阵仍缺 |
| R79 Full Test Gate | `PARTIAL` | 本报告不替代全量 test/build/desktop/CI 验证 |

## Non-claims

本报告不证明：

- 2 小时 endurance；
- 所有 Provider、网络超时、强制退出和恢复组合；
- 远程 CI runner、签名 installer、clean-machine 人工验收；
- Public Release overall readiness。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "reliability-12-gate-reconciliation",
  "evidence_date": "2026-09-01",
  "verdict": "PASS",
  "soak_gate": "pass_by_100_representative_task_cycles",
  "task_cycles": 100,
  "rss_growth_after_warmup": 0.030088,
  "integrity": "ok",
  "foreign_key_violations": 0,
  "public_release": "NOT_READY",
  "remaining": [
    "two_hour_endurance_is_not_run",
    "full_provider_restart_network_matrix",
    "clean_machine_and_signed_release"
  ]
}
```
