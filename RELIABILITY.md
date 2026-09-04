# OfferU Public Release Reliability

更新时间：2026-09-02

## Current verdict

```text
RELIABILITY_PARTIAL
```

上一 Internal Beta 检查点证明了部分重复保存防护和重启后读取。Reliability-02 至 -07 又在隔离 SQLite、真实 FastAPI 进程和浏览器上覆盖了强退/重启、中文 Resume autosave、保存失败重试、Interview/Learning handoff、关键 mutation retry/restart、100-cycle backend workload 和邮箱测试隔离。2026-09-01 的 Public Release E2E 又通过了 10/10 组合旅程、50/50 first-run、Resume 冲突/版本/PDF 和保存/PDF 失败路径；Reliability-08 至 -11 补了浏览器重复/传输重试、100 个真实 CareerTask worker、CareerTask 跨进程 claim 和 AutomationEvent 跨进程 claim；Reliability-12 按 Goal 的“2 小时或 100 个代表性 task cycles”确认 R62/R63 的当前门槛；Reliability-13 又验证 Provider auth/timeout 在 durable task control plane 中明确失败、可重试且不泄露 canary；启动恢复可观测性又统一了核心/可选服务的 health/diagnostics 状态；性能基线也通过。Reliability 仍为 `PARTIAL`：完整 provider/network/restart fault matrix 和 live provider 全矩阵仍缺，2 小时是未执行的等价 endurance 方式。

## Reliability 13 current evidence

当前报告：[Public Release Provider Failure Matrix](docs/evals/reports/2026-09-02-codex-offeru-public-release-reliability-13.md)。

- `401 invalid_api_key` 持久化为 `blocked`，错误摘要固定为 `provider authentication failed`，保持 retryable 并写入 `task.blocked`；
- Provider network timeout 持久化为 `failed`，保留 bounded timeout message、retryable 和 `task.failed`；
- 两个场景都只执行一次 attempt，认证 canary 不进入 task view 或事件 payload；
- 定向隔离测试为 `1 passed in 5.04s`。

这是 deterministic failure contract，不等价于真实外部网络断开、live Provider 或跨进程 failure/restart matrix。

## Public Release E2E current evidence

当前报告：[Public Release E2E](docs/evals/reports/2026-09-01-codex-offeru-public-release-e2e.md)。

本轮在隔离数据库和真实 7410/8765 进程上完成：

- 10/10 次 New User → Resume Workspace → Interview/Learning 组合旅程；
- 50/50 次独立 first-run，50/50 integrity `ok`、FK 0；
- 保存 503 后失败可见、draft 保留、手动 retry 成功；PDF 503 显示可理解错误；
- Resume stale proposal、手动编辑、版本、重排、隐藏 bullet、模板切换和 PDF export 进入重复性路径；
- 授权本地工作区当前后端全量 `362 passed, 19 warnings, 1 subtests passed in 329.19s`。

这些是 Replay/Fixture 与浏览器故障注入证据，不等价于真实用户网络、live Provider 或 clean-machine 人工验收；100 个代表性 task cycles 已满足当前 Goal 的 soak alternative，2 小时只是未执行的等价时长验证。

## Reliability 06 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-06](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-06.md)，实现仍在当前工作树，尚待提交。

本轮在全新隔离 SQLite 和真实 backend 上验证：

- identical Resume payload 重试不再推进 `workspace_revision`，也不新增 ResumeSection；
- Application auto-write 与 legacy Application create 重试各只产生一次 business effect；
- 相同 legacy status、Memory accept 和 Memory reject 重试均返回可识别的 duplicate 成功结果；
- 两个并发 Replay Interview answer 只产生一个 EvaluationRun、两条消息、一条 Observation 和一条 Proposal；
- backend 停止并重启后再次提交同一 Interview answer 返回 `duplicate=true`，没有新增持久化结果；
- 隔离 backend 停止后，正常 `djm.db` health、诊断包、integrity 和 463 条岗位读取均恢复正常。

因此 R74 的关键服务层 mutation 子项和部分浏览器 failure/retry 子项为 `PARTIAL`，但 Reliability 总 Gate 继续保持 `RELIABILITY_PARTIAL`：真实浏览器 double-click/network fault、完整 provider/network/restart matrix 和 clean-machine recovery 仍缺。

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
- 真实 backend 在隔离 SQLite 上完成 100 个串行混合 HTTP 周期，覆盖读取、Resume 写入、Candidate 接受/拒绝、Job navigation、Automation/CareerTask proposal 和 10 次 Replay short interview；0 HTTP error、SQLite integrity `ok`、foreign-key violations 为 0；
- 该 workload warm-up 后 RSS 从 `127,422,464` 增至 `131,256,320` bytes，增长 `3.01%`，低于当前 `20%` 资源阈值；
- 测试结束后正常 `djm.db` backend health 200，未改动真实职业数据。

这些证据将 R34/R35/R36 推进为 `PARTIAL`，并为 R62/R63 提供后续 `PASS` 所需的 100-cycle alternative 证据；Reliability 总 Gate 继续保持 `RELIABILITY_PARTIAL`。本轮只证明短时真实 backend workload；Interview/Learning 恢复、保存失败重试、全业务 mutation exactly-once 和完整浏览器/Provider 矩阵仍未验证。

## Reliability 01 current evidence

当前报告：[2026-08-31-codex-offeru-core-v1-reliability-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-01.md)，对应 commit `f0de8cb`。

本轮已通过隔离 SQLite/Replay 证实：

- 8 路并发 CareerTask start 只产生 1 条任务，重复请求复用同一任务；
- 8 路并发 AutomationEvent 只产生 1 条信号，重复请求复用同一结果；
- 两个独立进程同时处理同一个 `JOB_SAVED` 时，AutomationEvent 原子 claim 只产生 1 条 CareerTask 和 1 个 Inbox projection，任务 attempt 为 1；
- queued/running/waiting_for_approval 的 CareerTask 恢复状态分别正确重排、blocked 可 retry、保留审批；
- queued/processing AutomationEvent 可在启动恢复路径中重新处理；
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
| Provider timeout/auth | PARTIAL | Reliability-13 验证 401/timeout 在 durable CareerTask 中分别为 blocked/failed、可 retry 且不泄露 canary；packaged sidecar 真实 401/model-unavailable 可见；完整 UI Provider failure/retry matrix 仍缺 |
| Backend restart | PARTIAL | Reliability-02 已验证真实 force-stop/restart、durable state 和浏览器启动 overlay/core UI recovery |
| Duplicate click/retry | PARTIAL | Reliability-06 已验证 Resume、Application、Interview answer、Memory review 的服务层重复请求和 Interview restart retry；Reliability-08/09/10/11 补浏览器 double-click/transport retry、100-cycle worker、CareerTask 与 AutomationEvent 跨进程 claim；完整 provider/network fault 和全部 mutation 并发矩阵仍缺 |
| Save failure | PARTIAL | Reliability-03 加当前浏览器 503 路径证明内容保留、失败可见、手动 retry 成功；真实网络抖动、错误关联和全 mutation 矩阵仍缺 |

## Performance SLO

在固定 Reference Environment 测量：

| Metric | Target | Status |
| --- | ---: | --- |
| Cold startup → usable core UI | ≤ 8s | PASS — 1,448.903ms |
| Warm startup | ≤ 5s | PASS — 1,071.201ms renderer restart against warm backend |
| Cached navigation p95 | ≤ 1.5s | PASS — 348.685ms all-route p95 |
| Immediate action feedback | ≤ 200ms | PASS — 24.231ms |
| Background progress visible | ≤ 1s | PASS — 729.715ms |

详细测量：[Public Release Performance](docs/evals/reports/2026-09-01-codex-offeru-public-release-performance.md)。

报告必须记录 OS、CPU、RAM、disk、build mode、database fixture、sample count 和 measurement method，不能用开发热加载结果替代 production bundle。

## Soak and resource gate

正式 RC 执行至少 2 小时或 100 representative cycles，覆盖 read、candidate write、accept/reject、job navigation、resume edit、automation、agent task、short interview。Reliability-05 已在真实 backend 完成 100 个短时混合 HTTP cycles；Reliability-06 又在真实 backend 完成关键 mutation retry/restart matrix；Reliability-09/10/11 增加真实 CareerTask worker、CareerTask claim 和 AutomationEvent claim；Public Release 又完成 50 次 first-run 和 10 次完整组合浏览器运行；Reliability-12 依据 Goal 明确以 100 个真实 CareerTask worker cycles 满足 alternative。

通过条件：0 crash、0 corrupted DB、0 duplicate mutation、0 unbounded queue growth；warm-up 后 100 cycles RSS growth <20%。Reliability-05 的 100-cycle short workload 满足无错误、integrity、RSS 局部条件，Reliability-06 的关键服务层 mutation matrix 满足幂等子项，Reliability-08/09/10/11 补了浏览器/worker/跨进程 claim，当前 50/50 E2E 数据库也通过完整性检查；因此 R62/R63 按 100-cycle alternative 通过，但总 Gate 仍为 `PARTIAL`，原因是完整 provider/network/restart matrix 尚缺。2 小时 endurance 可作为额外信心证据；超出时必须区分设计缓存与实际 leak，并提供证据。

## Evidence retention

失败保存最小脱敏 trace、screenshot、console、network summary、structured events 和 DB integrity outcome；成功不保存大量无意义 trace。所有正式结果进入当前 commit 对应的 `docs/evals/reports/`，临时脚本或终端摘要不能单独构成 PASS。
