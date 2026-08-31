# OfferU Core v1 Reliability 01 Evidence

日期：2026-08-31  
Observed commit：`f0de8cb` (`fix: harden task and automation recovery`)  
范围：CareerTask / AutomationEvent 控制面可靠性，不代表 Public Release Ready。

## Verdict

```text
RELIABILITY_NOT_VERIFIED
```

本轮完成了一个可复核的后端可靠性切片，但没有把局部 SQLite/Replay 证据扩展成整个产品的 Public Release 结论。

## 本轮实现

- CareerTask 创建在进程内按创建路径串行化，并以数据库唯一幂等约束作为跨进程兜底；唯一约束竞争会回读已提交 winner，不把重复请求报告成失败。
- AutomationEvent 的 dedupe key 采用相同的数据库约束兜底；同一 queued event 在进程内由处理锁串行执行，重复请求复用既有事件结果。
- 后端启动恢复 queued AutomationEvent；JOB_SAVED 的重放继续依赖 CareerTask 幂等键和 Inbox upsert，不重复创建业务任务。
- CareerTask 重启恢复区分 `queued`、`running` 和 `waiting_for_approval`：queued 重排，running 明确 blocked 且可 retry，waiting 保留审批状态。
- 取消在同一 task lock 下检查并提交；晚到的 provider 结果不能把 `cancelled` 反写成 `completed`。
- retry 在 task lock 下完成状态迁移；已经 queued/running/waiting/completed 的重复 retry 返回 `reused=true`，不会再排第二次任务。
- 收紧手机号脱敏边界，避免误删字母数字相邻的业务 ID，同时保留日志/审计的敏感信息保护。

## Verification evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Reliability isolated suite | PASS | `backend/.venv312/Scripts/python.exe -m pytest tests/test_reliability.py -q` → `7 passed in 81.98s` |
| Concurrent CareerTask | PASS | 8 concurrent starts → 1 row, 1 creator, 7 reused, 1 completed task |
| Concurrent AutomationEvent | PASS | 8 concurrent signals → 1 row, 1 creator, 7 reused, 1 processed event |
| CareerTask recovery | PASS | queued/running/waiting matrix; queued completed, running blocked/retryable, waiting preserved |
| Late-result cancellation | PASS | cancelled terminal state won; no `task.completed`, one `task.cancelled` |
| Duplicate retry | PASS | one retry transition, one reused response, final attempt count bounded at 2 |
| Queued AutomationEvent recovery | PASS | startup-style recovery processed one queued signal without false success |
| 100-cycle deterministic soak | PASS | 100 replay task cycles, 100 completed tasks, 500 lifecycle events, 0 live workers, no duplicate rows |
| Affected Agent/automation/application regression | PASS | `31 passed, 4 warnings` |
| Full backend suite | PASS | `297 passed, 10 warnings, 1 subtest passed in 615.41s` |

## Release mapping

The current evidence strengthens, but does not complete, these requirements:

- R34 Automation Reliability: backend duplicate event and queued-event recovery are covered; provider timeout and all business-mutation exactly-once paths remain open.
- R35 CareerTask lifecycle: start, event stream, completion, cancel, retry and recovery are covered in isolated backend tests; full UI and process lifecycle remain open.
- R36 Restart Recovery: durable queued/running/waiting transitions are covered by a recovery harness; an actual process kill/restart and browser-visible recovery report remain open.
- R62 Soak Test: 100 representative AgentTask cycles pass; the required mixed read/candidate/resume/interview/automation browser workload is not covered.
- R63 Memory / Resource Leak: no RSS measurement was produced; this requirement remains open.

## Explicit non-claims

This report does not prove:

- force-kill recovery of the real desktop/backend process;
- Resume autosave recovery, Interview transcript recovery, or pending Learning Candidate recovery;
- exactly-once behavior across every Resume/Application/Interview/Memory mutation;
- browser E2E artifacts, error correlation, or user-visible progress/cancel behavior for every long task;
- warm-up-to-100-cycle RSS growth or a 2-hour soak;
- Public Release, installer, clean-machine, live Provider, privacy/consent, or signing readiness.

## Remaining next work

Return to the higher-priority Security residual (full canary/data-flow coverage, Python/Rust audit tooling, diagnostic correlation), then build process-kill/browser recovery and resource measurements before changing the Reliability verdict.
