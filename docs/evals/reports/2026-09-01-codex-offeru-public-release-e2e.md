# OfferU Public Release E2E Evidence — 2026-09-01

## Scope and verdict

本报告固化当前工作树的 Public Release 浏览器与重复性证据。它不是最终发布结论：主要核心链使用 Replay/Fixture，且没有在真正 clean OS 上完成陌生用户验收。

| Field | Value |
| --- | --- |
| Observed checkout | 当前工作树（包含未提交 Release 工程改动） |
| OS | Windows 11 10.0.26200 |
| Browser | Playwright Chromium headless |
| Frontend | Vite production preview `http://127.0.0.1:7410` |
| Backend | 隔离 SQLite FastAPI runtime `http://127.0.0.1:8765` |
| Data isolation | 每次 E2E 使用独立 SQLite；未使用正常 `backend/djm.db` |
| Runtime mode | Replay/Fixture，除单独 live Provider 报告外不宣称真实外部 Agent |
| Verdict | `PARTIAL` |

## Critical repeatability

`.tmp/public-release-repeatability-10.json` 记录了 10 次完整组合运行。每次使用新的 `public-release-repeat-f-{n}.db`，并连续执行：

```text
new-user golden path
→ Resume Workspace
→ Interview / Debrief / Learning
```

结果：

```text
10 / 10 PASS
0 failed iteration
每次均使用独立数据库
```

`.tmp/public-release-first-run-50.json` 和 `public-release-first-run-integrity.py` 进一步记录新用户首条路径：

```text
50 / 50 PASS
50 / 50 SQLite integrity_check = ok
50 / 50 foreign_key_check = 0
```

该路径由真实 UI 操作建立 Profile、保存岗位、等待自动准备、查看 Today/Job Detail 和 Application Packet；fixture 结果在 UI 中保留本地测试来源说明。

## Failure path

当前工作树上真实浏览器执行 `.tmp/public-release-failure-path-e2e.py`：

```text
保存接口第一次返回 HTTP 503       → 页面显示“保存失败”，draft 保留
点击重试                         → 保存成功
PDF 接口返回 HTTP 503             → 页面显示可理解的导出失败信息
page errors                       → 0
```

预期的 503 网络响应被记录，未被伪装成成功；这证明了失败可见性和安全重试路径，但不是所有 Provider/网络/桌面崩溃组合的完整证明。

## Current full backend regression

```text
backend/.venv312/Scripts/python.exe -m pytest tests -q
352 passed, 19 warnings, 1 subtests passed in 320.12s
```

Warnings 为既有 Pydantic 字段命名与 `datetime.utcnow()` deprecation，不构成本轮失败，但应在后续维护窗口处理。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R71 Golden Path A — New User | `PASS` for isolated Replay/Fixture browser path | 50/50 first-run and 10/10 composite runs |
| R73 Golden Path C — Failure | `PARTIAL` | Resume save/PDF 503 visible + retry; full failure matrix remains open |
| R74 Golden Path D — Duplicate | `PARTIAL` | Service-layer mutation/restart evidence exists; full browser double-click and transport retry matrix remains open |
| R75 Golden Path E — Resume Conflict | `PASS` for current isolated Resume Workspace path | 10/10 composite includes stale proposal, manual edit, version and export assertions |
| R77 Critical Repeatability | `PASS` | 10/10 complete composite iterations |
| R78 Extended Stability | `PASS` for the defined first-run replay suite | 50/50 isolated first-run iterations; this is not a 2-hour soak |
| R79 Full Test Gate | `PARTIAL` | Backend full suite passes; frontend/build/desktop evidence is in packaging report; CI and clean-machine UI remain unverified |
| R108 Final Human Acceptance | `NOT_VERIFIED` | No independent non-developer on a clean machine yet |

## Explicit non-claims

- Replay/Fixture E2E 不等于 live Role Intelligence 或 live Agent Provider；
- 50 次 first-run 不等于 2 小时 endurance；
- 临时脚本使用的 Chromium executable path 不是安装包内置浏览器承诺；
- 该报告不证明 migration upgrade、签名 installer、自动更新或真实 OAuth；
- 不把测试输出中的岗位、简历和面试文本作为真实用户数据结论。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-e2e-2026-09-01",
  "verdict": "PARTIAL",
  "critical_repeatability": {"passed": 10, "total": 10},
  "first_run_stability": {"passed": 50, "total": 50, "integrity_ok": 50, "foreign_key_clean": 50},
  "backend_full_suite": {"passed": 352, "warnings": 19, "subtests": 1},
  "runtime": "replay_fixture",
  "public_release": "NOT_READY",
  "residual": ["clean_machine_human_acceptance", "full_failure_duplicate_matrix", "live_provider_claim_scope"]
}
```
