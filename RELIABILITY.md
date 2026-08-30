# OfferU Public Release Reliability

更新时间：2026-08-30

## Current verdict

```text
RELIABILITY_NOT_VERIFIED
```

上一 Internal Beta 检查点证明了部分重复保存防护和重启后读取，但没有覆盖 Public Release 所需的强制退出、等待审批、自动保存、面试中断、恢复、soak、资源泄漏和重复业务效果矩阵。

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
| CareerTask running | NOT_VERIFIED | 强制退出、重启、状态/result/event 一致 |
| Waiting for approval | NOT_VERIFIED | 提案仍可审查，不重复执行 |
| Resume autosave | NOT_VERIFIED | 0 lost edit，旧 Proposal stale |
| Interview in progress | NOT_VERIFIED | transcript/round 状态准确恢复或明确终止 |
| Learning Candidate pending | NOT_VERIFIED | 候选不丢失、不静默接受 |
| Provider timeout/auth | Internal Beta only | Public failure E2E 尚未建立 |
| Backend restart | NOT_VERIFIED | UI 可见恢复、无 phantom success |
| Duplicate click/retry | Internal Beta only | 需要跨关键 mutation 的完整矩阵 |
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

正式 RC 执行至少 2 小时或 100 representative cycles，覆盖 read、candidate write、accept/reject、job navigation、resume edit、automation、agent task、short interview。

通过条件：0 crash、0 corrupted DB、0 duplicate mutation、0 unbounded queue growth；warm-up 后 100 cycles RSS growth <20%。超出时必须区分设计缓存与实际 leak，并提供证据。

## Evidence retention

失败保存最小脱敏 trace、screenshot、console、network summary、structured events 和 DB integrity outcome；成功不保存大量无意义 trace。所有正式结果进入当前 commit 对应的 `docs/evals/reports/`，临时脚本或终端摘要不能单独构成 PASS。
