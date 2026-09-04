# Public Release Reliability 14 — Cross-process failure recovery

日期：2026-09-02

## Scope

新增 `backend/scripts/e2e/test_public_release_failure_recovery.py`，在一个临时 SQLite 数据库中由独立 Python 子进程验证：

```text
provider-shaped auth failure
→ durable blocked state
→ cross-process retry
→ completed

provider-shaped network timeout
→ durable failed state
→ cross-process retry
→ completed

running task
→ owner process terminated
→ new process recovery
→ retry
→ completed
```

脚本使用确定性 fault injection 和 Replay provider，不连接真实外部 Provider，不把模拟结果当成 live Provider 证据。所有任务通过现有 `CareerTask` service，未直接修改业务状态或使用正常工作区数据库。

## Acceptance contract

- 认证错误只投影为 `provider authentication failed`，不会把 canary 写进 task view 或事件结果；
- 网络超时投影为可读、可重试的 `failed` 状态；
- 认证/超时初次 attempt 均为 1，跨进程 retry 后 attempt 为 2 且只产生一个完成事件；
- 被终止进程留下的 `running` task 由新进程 recovery 为 `blocked`，随后 retry 完成；
- 运行边界为 isolated SQLite；browser 为 `none`；web URL 为 `not_used`；8080 未使用。

## Verification status

本轮按 `AGENTS.md` 只完成脚本、CI 配置和静态复核，没有执行测试、构建或该子进程矩阵。GitHub workflow 新增独立 `reliability-failure-recovery` job，并使 desktop package / release 依赖它；远程 runner 未执行，因此本报告不把该 Gate 标为 PASS。

## Remaining

仍需在远程 CI 或授权本地环境执行该矩阵，并继续补充真实 Provider/network/restart/cancel/resume 和桌面进程级 evidence；Codex/Gmail/DSH 等凭据 blocker 不由该 fixture 解决。
