# OfferU Public Release Reliability 08 — browser duplicate submit and transport retry

日期：2026-09-01  
范围：隔离 SQLite、真实 `8765` backend、真实 `7410` frontend、Playwright managed Chromium

## 目的

补齐 Public Release Goal 的 Golden Path D 中最容易被服务层测试遗漏的用户边界：

1. 用户双击“保存并开始准备”；
2. 后端已经提交业务写入，但客户端收到一次传输层 `503` 后重试同一表单；
3. 最终 Job、AutomationEvent 和 Role Intelligence CareerTask 都只能产生一次业务效果。

测试使用全新隔离 SQLite，未使用或修改正常工作区 `backend/djm.db`。

## 执行

```text
python backend/scripts/e2e/test_public_release_smoke.py
```

脚本只使用用户可见 UI 完成 onboarding、Profile、Job 保存和 Job Detail；API 只用于读取验证结果。浏览器运行使用 Playwright 管理的 Chromium，不依赖个人浏览器路径。

## 结果

```text
status: PASS
first job: 1
first role task: completed / replay
retry job: 2
retry role task: completed / replay
transport attempts: 2
expected transport failure: 503 /api/jobs/ingest
page errors: 0
unexpected browser errors: 0
```

### 双击提交

在新用户保存岗位时对提交按钮执行真实 `dblclick`：

```text
matching Job rows: 1
matching role_intelligence CareerTask rows: 1
CareerTask status: completed
```

前端保存中的 guard 与后端 `manual:<normalized-input-hash>` 幂等键共同生效。

### 已提交后传输失败再重试

第二个岗位的第一次 `/api/jobs/ingest` 由浏览器路由先执行真实上游请求，再将客户端可见响应改为 `503`。UI 显示“模拟网络错误”，表单仍可重试；第二次相同 payload 返回后：

```text
ingest attempts: 2
matching Job rows: 1
matching role_intelligence CareerTask rows: 1
CareerTask status: completed
```

唯一的 `503` 和对应 console message 被记录为预期故障证据；没有其它 HTTP、console 或 page error。

## 代码变化

- `frontend/src/components/jobs/AddJobModal.tsx`：保存进行中直接忽略重复提交。
- `backend/scripts/e2e/test_public_release_smoke.py`：加入双击、已提交后 503、可见错误、重试和最终唯一性断言；Job Detail 对异步 Role Intelligence 使用显式可见数据等待，避免把投影交接延迟误判为成功。

## 发布映射

| Requirement | Status | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | PARTIAL | 浏览器双击和已提交后传输重试没有重复 Job/task；完整 Automation/CareerTask worker 跨进程矩阵仍缺 |
| R62 Soak Test | PARTIAL | 增加真实浏览器重复/重试场景；仍不是 2 小时 endurance |
| R68 Browser E2E Philosophy | PASS (local) | 只操作可见 UI，结果读取只用于验收，managed Chromium 隔离运行 |
| R73 Golden Path C — Failure | PARTIAL | 503 可见、可重试并恢复；Provider/auth/backend 全失败矩阵仍缺 |
| R74 Golden Path D — Duplicate | PARTIAL | 双击与 transport retry 真实浏览器 PASS；完整 worker/provider/network 矩阵仍缺 |
| R77 Critical Repeatability | PASS (local) | 本次 smoke 的两个重复边界均完成；10/10 composite 证据见 Public Release E2E 报告 |

## 限制

本报告不宣称 Public Release Ready。它没有替代远程 CI、clean-machine、签名 installer、previous-release upgrade、真实 Provider 或完整 worker/browser/network reliability matrix。

```json
{
  "report": "public-release-reliability-08",
  "status": "PASS",
  "isolated_database": true,
  "managed_chromium": true,
  "duplicate_submit": {"attempt": "dblclick", "jobs": 1, "role_tasks": 1},
  "transport_retry": {"attempts": 2, "injected_status": 503, "jobs": 1, "role_tasks": 1},
  "task_status": "completed",
  "page_errors": 0,
  "unexpected_browser_errors": 0
}
```
