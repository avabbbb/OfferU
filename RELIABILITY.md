# OfferU Public Release Reliability

更新时间：2026-08-31

## Current verdict

```text
RELIABILITY_NOT_VERIFIED
```

上一 Internal Beta 检查点证明了部分重复保存防护和重启后读取，但没有覆盖 Public Release 所需的强制退出、等待审批、自动保存、面试中断、恢复、soak、资源泄漏和重复业务效果矩阵。

## Reliability 01 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-01.md)，对应 commit `f0de8cb`。

本轮已通过隔离 SQLite/Replay 证实：

- 8 路并发 CareerTask start 只产生 1 条任务，重复请求复用同一任务；
- 8 路并发 AutomationEvent 只产生 1 条信号，重复请求复用同一结果；
- queued/running/waiting_for_approval 的 CareerTask 恢复状态分别正确重排、blocked 可 retry、保留审批；
- queued AutomationEvent 可在启动恢复路径中重新处理；
- cancel 与晚到 provider 结果竞争时，cancelled 保持终态；重复 retry 不会再排第二次任务；
- 100 个 Replay 任务循环产生 100 个 completed task、500 个生命周期事件、0 个 live worker；
- 当前 commit 全量后端套件 `297 passed, 10 warnings, 1 subtest passed`。

这些是控制面和确定性 Replay 证据，不等价于浏览器/进程强退恢复、所有业务 mutation 的 exactly-once、RSS 或 Public Release 通过。

## Reliability invariants

- 失败 visible、accurate、recoverable；不得伪造 success；
- 关键 mutation 在 duplicate event、double click、refresh、network retry 和 restart 下只产生一次 business effect；
- running/waiting task、resume autosave、interview in progress、candidate pending 在重启后无 corrupted state、phantom completion 或 duplicate commit；
- 超过 2 秒的任务展示 status、stage/progress、cancel 和 failure；
- Optional Provider 不可用不拖垮核心路径；
- 所有用户可见错误尽可能有 `error_id`，可关联 run_id、task_id、operation_id 和 sanitized diagnostic events。

## Restart / failure matrix

| Scenario | Status | Release proof |
| --- | --- | --- |
| CareerTask running | NOT_VERIFIED | 隔离恢复 harness 已证明 running→blocked/retryable；真实强制退出/重启仍缺 |
| Waiting for approval | NOT_VERIFIED | 隔离恢复已保留 waiting 状态；浏览器审批恢复仍缺 |
| Resume autosave | NOT_VERIFIED | 0 lost edit，旧 Proposal stale |
| Interview in progress | NOT_VERIFIED | transcript/round 状态准确恢复或明确终止 |
| Learning Candidate pending | NOT_VERIFIED | 候选不丢失、不静默接受 |
| Provider timeout/auth | Internal Beta only | Public failure E2E 尚未建立 |
| Backend restart | NOT_VERIFIED | queued/running/waiting 控制面 harness 已通过；真实进程/浏览器恢复仍缺 |
| Duplicate click/retry | NOT_VERIFIED | CareerTask/AutomationEvent 已通过；Resume/Application/Interview/Memory 全矩阵仍缺 |
| Save failure | NOT_VERIFIED | 用户内容保留、可重试、错误可关联 |

## Performance SLO

在固定 Reference Environment 测量：

| Metric | Target | Status |
| --- | ---: | --- |
| Cold startup → usable core UI | ≤ 8s | NOT_VERIFIED |
| Warm startup | ≤ 5s | NOT_VERIFIED |
| Cached navigation p95 | ≤ 1.5s | NOT_VERIFIED |
| Immediate action feedback | ≤ 200ms | NOT_VERIFIED |
| Background progress visible | ≤ 1s | NOT_VERIFIED |

报告必须记录 OS、CPU、RAM、disk、build mode、database fixture、sample count 和 measurement method，不能用开发热加载结果替代 production bundle。

## Soak and resource gate

正式 RC 执行至少 2 小时或 100 representative cycles，覆盖 read、candidate write、accept/reject、job navigation、resume edit、automation、agent task、short interview。当前已完成 100 个 Replay CareerTask cycles，但尚未覆盖上述混合用户工作负载。

通过条件：0 crash、0 corrupted DB、0 duplicate mutation、0 unbounded queue growth；warm-up 后 100 cycles RSS growth <20%。当前 task/event/worker 计数满足局部条件，但未测量 RSS，也未完成混合工作负载；超出时必须区分设计缓存与实际 leak，并提供证据。

## Evidence retention

失败保存最小脱敏 trace、screenshot、console、network summary、structured events 和 DB integrity outcome；成功不保存大量无意义 trace。所有正式结果进入当前 commit 对应的 `docs/evals/reports/`，临时脚本或终端摘要不能单独构成 PASS。
