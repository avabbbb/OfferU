# OfferU Public Release Performance Evidence — 2026-09-01

## Scope

本报告来自 `.tmp/public-release-performance-baseline.json`。测量的是 production Vite preview 与真实隔离 FastAPI backend，不是 Vite HMR 开发页；浏览器为 Playwright Chromium headless。

## Reference environment

```text
OS: Windows 11 Pro Workstation, 10.0.26200
CPU: 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz, 12 logical processors
RAM: 16,800,157,696 bytes
Node: v24.14.0 / npm 11.9.0
Frontend: Vite production preview on 127.0.0.1:7410
Backend: isolated SQLite runtime on 127.0.0.1:8765
Browser: Playwright Chromium headless, 1440x1000
Samples: 5 per cached route
Database: isolated release E2E fixture; job_id=1, resume_id=1
```

## Measurements

| Metric | Target | Measured | Result |
| --- | ---: | ---: | --- |
| Cold startup → usable core UI | ≤ 8,000 ms | 993.239 ms | `PASS` |
| Cold page navigation | informational | 467.888 ms | observed |
| Warm renderer startup | ≤ 5,000 ms | 1,071.201 ms | `PASS` |
| Cached navigation p95 — all measured routes | ≤ 1,500 ms | 339.558 ms | `PASS` |
| User edit → immediate feedback | ≤ 200 ms | 35.123 ms | `PASS` |
| Background progress visible | ≤ 1,000 ms | 661.186 ms | `PASS` |

Cached route p95：

```text
Today              47.838 ms
Pipeline           22.662 ms
Profile            35.747 ms
Job Detail        287.384 ms
Resume Workspace  840.963 ms
```

## Runtime diagnostics

```json
{
  "console_errors": [],
  "page_errors": [],
  "bad_responses": [],
  "slo_checks": {
    "cold_start": true,
    "cached_navigation": true,
    "user_action_feedback": true,
    "background_progress_visible": true,
    "runtime_clean": true
  }
}
```

## Verdict and limits

本次固定参考环境的五项性能门通过，R59/R60 可记为 `PASS`。它不替代：

- 真正 Tauri production WebView 在 clean machine 上的性能；
- 2 小时长时资源稳定性；
- 大规模真实用户资料和大量岗位的负载基线；
- live Provider 响应时间。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-performance-2026-09-01",
  "verdict": "PASS",
  "cold_start_ms": 993.239,
  "warm_start_ms": 1071.201,
  "cached_navigation_p95_ms": 339.558,
  "user_action_feedback_ms": 35.123,
  "background_progress_visible_ms": 661.186,
  "runtime_diagnostics_clean": true,
  "public_release": "NOT_READY",
  "residual": ["tauri-clean-machine-performance", "long-duration-soak"]
}
```
