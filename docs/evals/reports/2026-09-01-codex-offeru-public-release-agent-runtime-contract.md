# OfferU Public Release Agent Runtime Contract — 2026-09-01

## Scope

验证 Provider-neutral Runtime 的低层协议与 UI 事件规范：启动、thread/turn、事件流游标、
tool 事件、approval/reject、cancel、resume、shutdown/restart，以及失败/blocked 事件的
标准化映射。

## Result

使用 deterministic `ReplayAgentRuntimeProvider` 运行真实 provider interface 调用，并遍历
全部 `CANONICAL_AGENT_RUN_EVENT_TYPES`：

```text
16 passed, 2 warnings
```

覆盖：

```text
start → create_thread → start_turn → events(after=cursor)
approval response is explicit and non-successful for unsupported replay approval
reject
cancel
resume_turn
result
shutdown → restart
canonical tool/assistant/task/run/approval event types
failed / blocked / unknown provider event mapping
```

本轮测试还捕获并修复了一个标准事件回放缺陷：已是 `tool.started`、`tool.completed` 或
`tool.failed` 的事件此前会被错误降级为 `reasoning.status`，现在会保持 canonical type。

## Verdict

```text
PASS — deterministic Agent Runtime contract
```

该报告不代表 Codex OAuth、DSH、live Role Intelligence、真实网络超时或所有 Provider 的
live E2E 已通过；这些仍由外部凭据和 Provider release gates 管理。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R37 AgentRuntimeProvider UI seam | `PARTIAL` | provider-neutral interface 与 canonical events 已测；完整 build/所有 UI 入口长期 contract 仍缺 |
| R38 Minimum Live Agent | `PASS` | packaged/source Pi staged live evidence 另有报告 |
| R67 Agent Contract Tests | `PASS` | Replay interface 与 canonical event full matrix 通过 |
| R73 Failure path | `PARTIAL` | failed/blocked event mapping 通过；live provider/task/browser failure matrix 仍缺 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-agent-runtime-contract-2026-09-01",
  "verdict": "PASS",
  "canonical_event_types": 15,
  "provider": "replay",
  "live_provider": false,
  "database": "not_required"
}
```
