# OfferU Public Release Reliability 11

日期：2026-09-01  
范围：跨进程 `JOB_SAVED` AutomationEvent claim 与任务投影一致性

## 结论

在隔离 SQLite 上启动两个独立 Python 进程，同时提交同一个 `JOB_SAVED` 信号。数据库原子 claim 使只有一个进程进入分发；重复提交只产生一条 AutomationEvent、一条 CareerTask 和一个 Inbox projection。

本轮还修复了一个真实取消竞态：CareerTask 已完成后，后续自动化投影被进程取消时，不再把已完成任务改写为 `blocked`。

## 实际验证

命令：

```text
backend\\.venv312\\Scripts\\python.exe backend\\scripts\\e2e\\test_public_release_automation_concurrency.py
```

结果：

```json
{
  "status": "PASS",
  "workers": 2,
  "event_status": "completed",
  "task_status": "completed",
  "attempt_count": 1,
  "inbox_items": 1,
  "task_started_events": 1,
  "task_completed_events": 1,
  "elapsed_seconds": 8.864
}
```

定向回归：`tests/test_reliability.py` 为 `12 passed in 72.75s`；其中包含投影取消、投影失败可见性和 processing 重启回收测试，确认完成事实不会被回写为 `blocked`，投影异常会进入 failed AutomationEvent/Inbox。

## 代码边界

- `AutomationEvent` 增加数据库驱动的 `queued → processing` 原子 claim；
- terminal event update 只接受当前 processing owner，任务完成后的投影允许从 `dispatched` 收敛到 `completed`；
- Inbox 主键冲突在并发恢复时复用已提交行，不将重复投影报告成假失败；
- 自动化投影异常会记录为 failed AutomationEvent 和 Inbox 项，同时保留 completed CareerTask；
- `CareerTask` 取消异常只对非 terminal 状态建立 `blocked`，保护已持久化的完成事实；
- `ListAutomationEvents` 的 status contract 暴露内部 processing 状态，便于 Doctor/诊断识别卡住的分发。

## Goal 映射

- R34 Automation Reliability：补跨进程 AutomationEvent claim、唯一任务和唯一 Inbox 证据；
- R35 CareerTask lifecycle：补任务完成后投影取消竞态回归；
- R36 Restart Recovery：处理重启前处于 processing 的信号并重新进入幂等分发；
- R62 Soak / R74 Duplicate：增加两个独立进程的真实 duplicate signal 验证；
- R79 Full Test Gate：新增定向回归与 CI job step。

## 未覆盖

这不是完整 provider/network/restart matrix，也不替代 2 小时 endurance、远程 CI 执行、真实 OAuth、签名安装包或陌生用户 clean-machine 验收。
