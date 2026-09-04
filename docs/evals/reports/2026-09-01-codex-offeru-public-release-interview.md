# OfferU Public Release Interview Learning E2E — 2026-09-01

## Scope

本报告覆盖一个全新隔离 SQLite 工作区中的真实浏览器路径：用户建立 Profile、保存岗位，
等待 Replay Role Intelligence 完成，进入岗位专项 Interview，提交模糊回答触发
Interviewer Mode 追问，再完成 Interview、查看 transcript-backed Debrief，并从 Profile
职业模型页面接受 Learning Candidate。

脚本：

```text
backend/scripts/e2e/test_public_release_interview.py
```

运行时使用 Playwright managed Chromium；没有硬编码个人浏览器路径。Role Intelligence 和
Interview 均明确使用 `replay` fixture，结果不能被解释为 live external provider 证明。

## Exact result

执行：

```text
backend\\.venv312\\Scripts\\python.exe backend\\scripts\\e2e\\test_public_release_interview.py
```

结果：

```json
{
  "status": "PASS",
  "job_id": 1,
  "benchmark_run_id": "role_benchmark_83b09fadd4e94784859eb9412147b01d",
  "interview_id": 1,
  "answers_submitted": 8,
  "interview_status": "completed",
  "focus_plan_visible": true,
  "interviewer_mode_follow_up": true,
  "debrief_visible": true,
  "transcript_message_count": 16,
  "learning_candidate_status": "accepted",
  "report_has_evidence_review": true,
  "console_errors": [],
  "page_errors": [],
  "bad_responses": []
}
```

## Acceptance evidence

- Focus Plan 在岗位上下文中可见，问题由 persisted Role Intelligence 计划生成；
- 第一条短回答触发 `Adaptive follow-up`，追问文案要求事实/责任/结果补充；
- 活跃 Interview 页面展示 `Interviewer Mode`，没有即时评价面板、夸奖或参考答案；
- 完成后报告展示 `Coach after completion` Debrief，并引用实际提交回答的 transcript excerpt；
- API detail 中 candidate message 数量与 UI 提交次数一致，Interview 为 `completed`；
- 完成 Interview 自动生成 pending Learning Candidate，Profile UI 的职业模型收件箱接受后，
  Candidate 变为 `accepted` 并返回 applied Profile section；
- accepted 状态再次反映回 Interview report；
- 全流程没有 HTTP 失败、console error 或 page error。

## Verdict

```text
PASS — fixture/replay browser evidence
```

这不是 Public Release 的 live-provider 通过证据。仍需在真实可发布 Agent/LLM provider、
失败/重启矩阵和陌生用户安装环境上重复验证；Replay 只证明产品控制流和 UI 学习回流没有
依赖开发者手工补状态。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R27 Interview Focus | `PARTIAL` | 隔离浏览器显示岗位 Role Intelligence Focus Plan 并生成专项问题；当前数据模式为 Replay fixture，live Role Intelligence 仍缺 |
| R28 Interviewer Behavior | `PARTIAL` | 首个模糊回答触发追问，Interviewer Mode 无即时夸奖/答案补全/Coach 面板；完整 provider/行为矩阵仍缺 |
| R29 Interview Debrief | `PARTIAL` | 完成报告展开后显示 transcript-backed `评价引用（实际回答）`；当前为 Replay/单条路径，完整报告矩阵仍缺 |
| R30 Interview Learning | `PARTIAL` | Interview completion → pending Learning Candidate → Profile UI accept → applied Profile section 全链通过；完整六态与跨重启仍缺 |
| R31 Memory lifecycle | `PARTIAL` | 本路径证明 pending→accepted 回流；其它状态、冲突/取代/history 矩阵仍缺 |
| R71 New-user Golden Path | `PARTIAL` | 新用户 Interview learning 子路径真实 UI 通过；installer/clean-machine 全旅程仍缺 |
| R73 Failure path | `PARTIAL` | 本次无失败注入且无自然错误；Provider timeout/auth/restart matrix 仍缺 |
| R74 Duplicate path | `PARTIAL` | Interview detail 与 Learning Candidate 回流只产生一次完成事实；专门 double-submit/transport retry 仍由其它 reliability evidence 覆盖 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-interview-learning-2026-09-01",
  "verdict": "PASS_FIXTURE_REPLAY",
  "runtime": "replay",
  "answers_submitted": 8,
  "transcript_message_count": 16,
  "interviewer_follow_up": true,
  "debrief_transcript_citation": true,
  "learning_candidate": "accepted",
  "profile_section_created": true,
  "browser_errors": 0,
  "public_release": "NOT_READY",
  "residual": ["live_provider_matrix", "failure_restart_matrix", "clean_machine_acceptance"]
}
```
