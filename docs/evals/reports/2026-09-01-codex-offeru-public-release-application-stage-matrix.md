# OfferU Public Release Application Stage Matrix — 2026-09-01

## Scope

验证 Application 的外部进展阶段是否由同一套确定性规则写入 Timeline，并一致投影到
Pipeline、progress overview 和旧投递工作区状态。测试只使用隔离 SQLite，不接触正常用户库，
不调用真实 LLM 或外部邮箱。

## Deterministic classification

`tests/test_application_progress.py::test_deterministic_signal_keywords_cover_each_external_stage`
覆盖全部外部阶段：

```text
applied
written_test
assessment
interview_1
interview_2
interview_hr
offer
rejected
```

每个样例都由 deterministic keyword rule 命中；`unknown` 与 `prepared` 不被误当作外部信号
阶段。

## Projection matrix

`test_all_external_stages_project_to_timeline_board_and_workspace` 为每个阶段建立独立
Job/ApplicationAttempt/Signal/Candidate，经过真实 `review_application_progress(action=accept)`
后检查：

```text
8 / 8 stage events persisted
8 / 8 previous_stage = applied
8 / 8 workspace status matches stage mapping
8 / 8 Pipeline board current_stage present
8 / 8 progress overview current_stage present
all _STAGE_ORDER entries have a non-empty next_action
```

定向结果：

```text
6 passed, 12 warnings
```

警告来自既有 `datetime.utcnow()` 和 Pydantic field shadowing，不影响本矩阵断言。

## Verdict

```text
PASS — deterministic external stage and timeline projection matrix
```

该报告只证明 Application stage 的确定性后端矩阵；不继承为 Today 全事件投影、真实邮件/日历
接入、浏览器 double-click/network retry 或 Public Release 总 Gate 通过。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R40 Application Pipeline stages | `PASS` | 全部 8 个外部阶段进入 `ApplicationStageEvent`，并投影到 board/overview/workspace |
| R65 Unit / deterministic rules | `PARTIAL` | 本报告补齐 stage classification/projection；其余 Fact Gate、Delta、Today priority、Candidate lifecycle 等仍需完整 mapping |
| R74 Duplicate / state safety | `PARTIAL` | 矩阵使用真实 review path；重复 review 的既有测试继续覆盖，浏览器/transport/worker 矩阵仍缺 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-application-stage-matrix-2026-09-01",
  "verdict": "PASS",
  "stage_count": 8,
  "timeline_events": 8,
  "board_stage_projection": 8,
  "overview_stage_projection": 8,
  "external_provider": false,
  "database": "isolated-temporary-sqlite"
}
```
