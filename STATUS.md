# OfferU Public Release Status

更新时间：2026-08-31

## Current release phase

```text
AUTONOMOUS_PRODUCTION_READINESS
```

## Current verdict

```text
OFFERU_PUBLIC_RELEASE_NOT_READY
```

`RESUME_WORKSPACE_BETA_READY` 是上一阶段的 Internal Beta 检查点，不是 Public Release 结论。当前仓库没有 signed installer、clean-machine、upgrade、migration、backup/restore、security、soak、live runtime 或 10/10 E2E 的正式 Release 证据，因此不得宣称 Public Release Ready。

## Current Gate

```text
SECURITY_02_RESIDUAL
full artifact canary → Rust advisory → permission diff → logging/PII → privacy/consent
```

状态：`NOT_VERIFIED`

原因：`DATA_SAFETY_03` 已通过结构化导出完整性、递归敏感字段排除、Demo Reset scope 和隔离 Settings 浏览器路径。`SECURITY_02` 已补齐 error ID、脱敏 diagnostic bundle、validation 输入隔离、确认的原始错误路径修复、Python/npm dependency 和浏览器 feedback canary；但完整 artifact canary、Rust advisory、权限 diff、全量 logging/PII、历史行 scrub、privacy/consent 仍未验证。Reliability 的真实进程/浏览器强退、RSS 与全业务 mutation 矩阵也未完成。Public Release 继续保持 `NOT_READY`。

## Release dashboard

| Gate | Status | Current evidence |
| --- | --- | --- |
| Core Product | NOT_VERIFIED | Internal Beta Replay/Fixture 路径曾通过；没有 Public RC 级 10/10 与 50-run 证据 |
| Data Safety | PASS | R43–R49、R76 已由 `data-safety-01`、`data-safety-02`、`data-safety-03` 报告覆盖 |
| Security | NOT_VERIFIED | [Security 01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-01.md) + [Security 02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)；error/diagnostic/Python/npm 子项已有 PARTIAL 证据，完整 artifact canary、Rust、权限、logging/PII 和 privacy/consent 仍缺 |
| Reliability | NOT_VERIFIED | [Reliability 01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-01.md) + [Reliability 02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-02.md)；真实 restart/browser/Resume autosave 已有 PARTIAL 证据，Interview/Learning/RSS/全 mutation 仍缺 |
| Packaging | FAIL | Tauri release launcher 仍依赖 repo 与 `.venv312`，无可发布 sidecar/installer |
| Live Runtime | NOT_VERIFIED | Replay 可用；没有至少一个真实 Agent Runtime `LIVE_PASS` |
| E2E | NOT_VERIFIED | 无当前 commit 的正式 Eval baseline、10/10 critical path 或 50-run report |

## Last passing checkpoint

```text
RESUME_WORKSPACE_BETA_READY
scope: isolated SQLite + Replay/Fixture Internal Beta
date: 2026-08-30
```

上一检查点记录了 Onboarding、Job preparation、Resume Workspace、Interview、Learning、失败可见、重复防护和重启持久化的本地内测结果，并记录了后端 `265 passed`、前端 typecheck/build 通过。其浏览器脚本与部分证据位于临时目录，且没有与当前 commit 对应的正式 Eval report，因此只作为实现线索，不能作为 Public Release PASS 继承。

## Completed DATA_SAFETY_01 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-01.md)

本轮已在隔离数据库上完成并验证：

- SQLite Online Backup API 一致性快照；
- SQLite、受管 uploads/artifacts、版本 manifest 和逐文件 hash；
- `PRAGMA integrity_check` 与 foreign-key 检查；
- restore staging、确认门、取消、启动前恢复、pre-restore 备份和失败自动回滚；
- Operation Registry、CLI Doctor、Settings UI 和浏览器 restart/cancel 路径；
- 三次 backup → mutate → restore → restart 循环，以及恢复后的真实 Profile/Job 查询。

因此当前将 R43、R44、R45、R46、R49、R76 标记为 PASS；这不改变 Public Release 总结论。

## Completed DATA_SAFETY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-02.md)

本轮已在隔离的 old-schema A/B fixtures 和正常本地启动路径验证：

- `PRAGMA user_version` 的 v1/v2 编号迁移路径；
- migration 前 verified Online Backup API 备份；
- migration 后 integrity、foreign-key 和 required-table smoke；
- migration 失败释放 ORM 引擎、恢复 pre-migration snapshot 并停止启动；
- future schema version fail-closed；
- 正常 `djm.db` 启动从 version 0 到 2，`integrity_check=ok`，Doctor migration `ready`。

因此 R43、R44 现标记为 PASS；R47/R48 仍是 Data Safety 的剩余验收项。

## Completed DATA_SAFETY_03 slice

正式报告：[2026-08-31-codex-offeru-core-v1-data-safety-03](docs/evals/reports/2026-08-31-codex-offeru-core-v1-data-safety-03.md)

本轮已在隔离数据库、真实 Settings UI 和正常运行库上完成并验证：

- JSON structured export 包含 Profile、Job、Application、Resume、Interview 及 CareerArtifact 等核心集合，并保留可读记录与 counts；
- 嵌套 metadata 中的 `api_key`、`api_token` 等凭据字段会递归排除；
- Demo Reset 只匹配 `source=offeru-demo` 且 `batch_id=offeru-demo-v1` 的合成 Job；
- 明确确认门、子记录清理、重复 reset no-op，以及真实 Profile/未标记 Job 保留；
- 浏览器路径从 2 条 Job 重置到 1 条真实 Job，Settings 成功提示可见，console errors 为 0；
- 正常 `djm.db` 已恢复，HTTP health 200，Doctor 报告 schema 2/2、integrity `ok`、FK violations 0。

因此 R47、R48 现标记为 PASS，Data Safety domain 完整通过；这不改变 Public Release 总结论。

## Completed RELIABILITY_01 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-01](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-01.md)

本轮在隔离 SQLite/Replay 和当前 commit `f0de8cb` 上完成并验证：

- 并发 CareerTask/AutomationEvent 的 exactly-once 创建与复用；
- queued、running、waiting_for_approval 的 CareerTask 恢复；
- queued AutomationEvent 的启动恢复；
- cancel 与晚到结果的终态保护，以及重复 retry 的复用；
- 100 个 Replay task cycles：100 completed、500 lifecycle events、0 live workers；
- 当前 commit 后端全量 `297 passed, 10 warnings, 1 subtest passed`。

这只证明控制面和确定性后端切片；Reliability domain 仍为 `NOT_VERIFIED`，因为真实进程强退/浏览器恢复、Resume/Interview/Learning 恢复、全业务 mutation exactly-once、RSS 和混合用户 soak 尚未完成。

## Completed SECURITY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-security-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-security-02.md)

本轮已在当前 checkout 和隔离 canary 上完成并验证：

- HTTP、Starlette 404、validation、未处理异常与前端 request/SSE 的 error ID 关联；
- Registry-backed 脱敏 diagnostic bundle 与 Settings 浏览器反馈下载；
- API validation、diagnostic、browser feedback、durable Agent/Audit/export canary；
- Profile/Resume/Doctor/database migration/scraper 已确认的原始异常路径收口；
- Python `pip-audit`、`pip check`、JobSpy markdown conversion 与 npm production audit；
- 后端全量 `298 passed, 10 warnings, 1 subtest passed`，前端 typecheck/build 通过。

Security 仍保持 `NOT_VERIFIED`：Rust advisory DB、完整 release artifact matrix、权限 diff、全量 logging/PII、历史 Agent Run scrub、privacy/consent 和签名未完成。

## Completed RELIABILITY_02 slice

正式报告：[2026-08-31-codex-offeru-core-v1-reliability-02](docs/evals/reports/2026-08-31-codex-offeru-core-v1-reliability-02.md)

本轮在隔离 SQLite、真实 backend 进程和真实 7410 浏览器页面完成：

- force-stop/restart 后 running CareerTask blocked/retryable、waiting checkpoint 保留、queued Replay 完成；
- queued AutomationEvent startup recovery 安全处理；
- backend outage 时显示启动状态，恢复后 Today 核心 UI 回来；
- 中文 Resume 编辑 autosave 后刷新内容保留，单次更新请求，page errors 为 0；
- 测试后正常 `djm.db` health 200，真实职业数据未被修改。

Reliability 仍为 `NOT_VERIFIED`：Interview/Learning 恢复、保存失败重试、全业务 mutation exactly-once、RSS 与混合用户 soak 未完成。

## Evidence policy

- `PASS`：当前可定位 commit 的权威证据覆盖整个 Gate；
- `FAIL`：已知实现或运行事实违反 Gate；
- `BLOCKED_EXTERNAL`：仅限签名证书、本人 OAuth、法律/隐私决策或第三方生产账号；
- `PRE_EXISTING_FAILURE`：已确认在本 Release 改动前存在，但仍需在 Release 前处理；
- `NOT_VERIFIED`：没有足够证据；不得按 PASS 计算。

临时终端输出、`C:\temp` 脚本、历史聊天结论、单次测试和静态代码存在性不能单独证明 Release Gate。

## Next action

```text
1. 继续 Reliability：Interview/Learning pending 恢复、Resume 保存失败重试、全业务 mutation exactly-once、RSS 和混合用户 workload。
2. 并行收口 Security 02 residual：完整 artifact canary、Rust advisory、权限 diff、logging/PII、privacy/consent。
3. 再继续 Packaging、Live Runtime 和 E2E 最高 blocker。
```

## External requirements (not yet the current blocker)

- Windows/macOS 合法代码签名证书；
- 若选择 Codex/Gmail 等生产集成，需要使用者完成对应 OAuth；
- 隐私披露、数据处理与公开发布策略需要产品所有者最终确认；
- 实时第三方研究若作为正式 claim，需要真实 Provider 账号/配额。

这些外部事项当前不构成停止理由，因为仓库内仍有大量可以自主完成的 Data Safety、Security、Reliability、E2E 和 Packaging 工作。
