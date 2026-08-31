# OfferU Public Release Reliability

更新时间：2026-08-31

## Current verdict

```text
RELIABILITY_NOT_VERIFIED
```

上一 Internal Beta 检查点证明了部分重复保存防护和重启后读取。Reliability-02 又在隔离 SQLite 上覆盖了真实 FastAPI 进程强退/重启、浏览器启动状态恢复和中文 Resume autosave 刷新读取。Reliability-03 进一步验证了 Resume 保存失败可见、编辑内容保留和手动重试成功。Reliability-04 又补齐了 Interview evaluation 中断和完成面试 Learning handoff 的真实启动恢复与重复启动幂等，但仍没有覆盖 Public Release 所需的 soak、资源泄漏和重复业务效果矩阵。

## Reliability 04 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-04](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-04.md)，实现 checkout `ae1445d`。

本轮在隔离 SQLite 和两次真实 backend 进程启动上验证：

- active Interview 保留当前题目和轮次；
- 中断的 running EvaluationRun 变为明确 failed，可重新提交回答；
- completed Interview 缺少 Candidate 时补齐 active Observation 和 pending Memory Proposal，不直接写 Profile；
- 第二次启动不重复生成 Evaluation、Observation 或 Proposal；
- 测试结束后正常 `djm.db` health 与诊断包均为 200。

因此 Interview in progress、Learning Candidate pending 和本地 handoff 重复启动分别推进为 `PARTIAL`，但 Reliability 总 Gate 继续保持 `RELIABILITY_NOT_VERIFIED`。

## Reliability 03 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-03](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-03.md)，实现 checkout `25b6a49`。

本轮在隔离 SQLite 和真实 7410/8765 进程上验证：

- 中文 Resume 编辑 autosave 后刷新内容保留，成功路径只发出 1 次更新；
- 第一次保存被注入为 503 时，页面显示失败状态和“重试保存”；
- 失败期间 draft 内容仍保留，第二次手动重试成功，未出现 JavaScript page error；
- autosave 使用 candidate signature 防止晚到的旧响应覆盖更新后的 draft。

因此 Resume save failure 从 `NOT_VERIFIED` 推进为 `PARTIAL`，但 Reliability 总 Gate 继续保持 `RELIABILITY_NOT_VERIFIED`。

## Reliability 02 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-02.md)，对应当前文档 checkout `05041ee`，实现基线 `485871b`。

本轮在唯一临时 SQLite 和真实 8765/7410 进程上验证：

- force-stop 后重启：running CareerTask 变成 `blocked/retryable`，waiting-for-approval 保留 checkpoint，queued Replay 自动完成；
- queued AutomationEvent 在 startup recovery 中安全处理，未知禁用规则变成 `skipped`；
- backend 不可用时浏览器显示“正在启动 Python 工作台…”，恢复后回到 Today 核心 UI；
- 中文 Resume Workspace 编辑后 autosave 只发出 1 次更新，刷新后摘要完整保留，page errors 为 0；
- 测试结束后正常 `djm.db` backend health 200，未改动真实职业数据。

这些证据将 R34/R35/R36 推进为 `PARTIAL`，但 Reliability 总 Gate 继续保持 `RELIABILITY_NOT_VERIFIED`。Interview/Learning 恢复、保存失败重试、全业务 mutation exactly-once、RSS 和混合用户 soak 仍未验证。

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
| CareerTask running | PARTIAL | Reliability-02 已用真实进程 force-stop/restart 证明 running→blocked/retryable；完整 provider/UI 矩阵仍缺 |
| Waiting for approval | PARTIAL | 真实重启保留 waiting checkpoint；浏览器审批动作恢复仍缺 |
| Resume autosave | PARTIAL | Reliability-03 已验证中文编辑→autosave→reload、503 可见、draft 保留和手动 retry；高频输入、跨标签冲突和 0 lost edit 矩阵仍缺 |
| Interview in progress | PARTIAL | Reliability-04 真实启动恢复保留 active round，并把 running evaluation 标为明确 failed/retryable；live provider/UI transcript 矩阵仍缺 |
| Learning Candidate pending | PARTIAL | Reliability-04 真实启动补齐 pending Observation/Proposal，重复启动不新增；Accept/Reject UI 和全来源矩阵仍缺 |
| Provider timeout/auth | Internal Beta only | Public failure E2E 尚未建立 |
| Backend restart | PARTIAL | Reliability-02 已验证真实 force-stop/restart、durable state 和浏览器启动 overlay/core UI recovery |
| Duplicate click/retry | PARTIAL | CareerTask/AutomationEvent 与 Interview Learning handoff repeated startup 已通过；Resume/Application/Interview answer/Memory review 全矩阵仍缺 |
| Save failure | PARTIAL | Reliability-03 注入 503 后内容保留、失败可见、手动 retry 成功；真实网络抖动、错误关联和全 mutation 矩阵仍缺 |

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

正式 RC 执行至少 2 小时或 100 representative cycles，覆盖 read、candidate write、accept/reject、job navigation、resume edit、automation、agent task、short interview。当前已完成 100 个 Replay CareerTask cycles，Resume 单次成功/失败重试已补证，但尚未覆盖上述混合用户工作负载。

通过条件：0 crash、0 corrupted DB、0 duplicate mutation、0 unbounded queue growth；warm-up 后 100 cycles RSS growth <20%。当前 task/event/worker 计数满足局部条件，但未测量 RSS，也未完成混合工作负载；超出时必须区分设计缓存与实际 leak，并提供证据。

## Evidence retention

失败保存最小脱敏 trace、screenshot、console、network summary、structured events 和 DB integrity outcome；成功不保存大量无意义 trace。所有正式结果进入当前 commit 对应的 `docs/evals/reports/`，临时脚本或终端摘要不能单独构成 PASS。
