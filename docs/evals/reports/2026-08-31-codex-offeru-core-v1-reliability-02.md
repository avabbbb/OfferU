# OfferU Core v1 Reliability 02 Evidence

日期：2026-08-31  
Observed checkout：`05041ee` (`docs: record security 02 evidence`)  
实现基线：`485871b` (`fix: close security diagnostics residuals`)  
范围：真实 FastAPI 进程强退/重启、浏览器启动状态恢复和 Resume Workspace autosave；不代表 Public Release Ready。

## Verdict

```text
PARTIAL
```

本轮把 Reliability-01 的隔离控制面证据扩展到了真实本地进程和浏览器边界，并验证了 Resume 编辑器的持久化路径。Interview、Learning Candidate、全部业务 mutation exactly-once、RSS 和混合用户 soak 仍未完成，因此 Reliability 总 Gate 继续保持 `RELIABILITY_NOT_VERIFIED`。

## Environment and isolation

- OS/shell：Windows、PowerShell、Asia/Hong_Kong；
- Python：3.12 via `backend/.venv312/Scripts/python.exe`；
- backend：真实 `run_server.py` / FastAPI，固定端口 8765；
- frontend：真实 Vite 页面，固定端口 7410；
- 所有新任务和简历内容写入唯一临时 SQLite；测试结束后恢复正常 `djm.db` backend；
- 未删除、覆盖或迁移真实职业数据。

## Real process recovery

测试序列：

```text
start isolated backend
↓
health 200
↓
force-stop real Python process
↓
seed running / waiting_for_approval / queued CareerTask + queued AutomationEvent
↓
start same backend with same SQLite
↓
query durable state and lifecycle events
```

结果：

| Durable record | Observed result |
| --- | --- |
| `recovery-process-running` | `blocked`, `retryable=true`，单条 `task.blocked`，错误为 backend restart；未伪造完成 |
| `recovery-process-waiting` | 保持 `waiting_for_approval`，`checkpoint.approval_id=approval-process-1` 保留 |
| `recovery-process-queued` | 自动重排并完成 Replay；事件为 `task.recovered → task.started → runtime.ready → runtime.events_collected → task.completed` |
| `recovery-process-event` | 未知且禁用的自动化规则安全变成 `skipped`，没有伪造业务写入 |
| backend health | 初始化和恢复启动均为 HTTP 200；测试结束后正常 `djm.db` health 200 |

这是真实进程强退/重启证据，但只覆盖 CareerTask/AutomationEvent 控制面；它不证明 Resume、Interview、Learning 或所有 Operation 的跨进程 exactly-once。

## Browser outage and recovery

真实 7410 页面在 backend 停止后 reload：

```json
{
  "outage_overlay": true,
  "has_core_ui": false,
  "visible_message": "正在启动 Python 工作台…"
}
```

backend health 恢复后再次 reload：

```json
{
  "title": "OfferU | 求职工作台",
  "outage_overlay": false,
  "has_core_ui": true,
  "today_visible": true,
  "page_errors": 0
}
```

故障窗口产生的 `ERR_CONNECTION_REFUSED` 仅来自 backend 已停止期间的请求；恢复后页面回到 Today，未出现白屏或 JavaScript page error。该结果是浏览器可见恢复证据，不等于所有后台长任务 UI 都已完成恢复矩阵。

## Resume autosave recovery

在同一隔离 SQLite 中创建最小中文 Resume，真实浏览器路径为：

```text
open #/resume/1
↓
edit summary
↓
wait for “已保存”
↓
reload
↓
read summary
```

结果：

```json
{
  "workspace_visible": true,
  "saved_value_matches": true,
  "reloaded_value_matches": true,
  "update_requests_before_reload": 1,
  "update_requests_total": 1,
  "page_errors": []
}
```

这证明当前中文编辑、autosave debounce、刷新后的读取链路在一次隔离样本上闭环；未证明 0 lost edit 的高频输入矩阵、保存失败重试、浏览器崩溃前最后一击、Proposal stale 与 Resume/Application/Packet 全链路 exactly-once。

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | 真实重启验证 queued AutomationEvent 恢复；provider timeout 与全业务 mutation exactly-once 仍缺 |
| R35 CareerTask lifecycle | PARTIAL | 真实进程验证 running/queued/waiting 状态边界；完整 UI lifecycle、provider failure 和 approval action 仍缺 |
| R36 Restart Recovery | PARTIAL | 真实 Python force-stop/restart、durable state 与浏览器启动 overlay 已验证；五场景完整矩阵仍缺 |
| R62 Soak Test | NOT_VERIFIED | 仍只有 Reliability-01 的 100-cycle Replay，不是混合用户 workload |
| R63 Memory / Resource Leak | NOT_VERIFIED | 本轮未产生 warm-up RSS growth 证据 |
| R79 Full Test Gate | NOT_VERIFIED | 本轮是隔离运行时验收；全产品 full test、desktop artifact 和正式 E2E 仍未完成 |

## Explicit non-claims

本报告不证明：

- Interview transcript 中断恢复或 Learning Candidate pending 恢复；
- Profile、Application、Artifact、Candidate、Event 全部 mutation 的跨进程 exactly-once；
- 保存失败后的用户内容保留与安全重试；
- 50-run、2-hour mixed soak 或 warm-up 后 RSS 增长小于 20%；
- live Provider、安装包、clean machine、签名、privacy/consent 或 Public Release readiness。

## Next autonomous work

1. 为 Resume 保存失败/重试与 Interview/Learning pending 建立隔离恢复矩阵；
2. 安装 `psutil` 后对真实 backend 和代表性工作负载记录 warm-up RSS 与 worker/queue 计数；
3. 扩展 Resume/Application/Interview/Memory 的 duplicate click/retry/restart 证明，再回收 Security permission/artifact residual。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-02",
  "target_scope": "real-process-browser-resume-recovery",
  "evidence_date": "2026-08-31",
  "observed_checkout": "05041ee",
  "implementation_commit": "485871b",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "real_backend_force_stop_restart",
    "career_task_durable_recovery",
    "automation_event_startup_recovery",
    "browser_backend_outage_overlay",
    "browser_core_ui_recovery",
    "resume_chinese_autosave_reload"
  ],
  "not_verified": [
    "interview_transcript_recovery",
    "learning_candidate_recovery",
    "all_business_mutation_exactly_once",
    "save_failure_retry",
    "rss_growth",
    "mixed_user_soak"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-reliability-recovery-and-resource-gates"
}
```
