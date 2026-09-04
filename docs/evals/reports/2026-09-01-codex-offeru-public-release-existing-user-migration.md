# OfferU Public Release Existing User Migration E2E

日期：2026-09-01  
结论：`PASS`（隔离 previous-release schema v1 fixture）

## 范围

本次验证把一个模拟 previous release 的 schema v1 SQLite 数据库交给正式后端启动流程，确认迁移完成后用户仍能从真实浏览器 UI 读取核心职业状态。数据库、运行时数据目录和浏览器状态均位于临时目录，未触碰正常 `backend/djm.db`。

夹具包含：

- 1 个 Profile、1 份主简历和 1 个目标方向；
- 5 个岗位；
- 2 个 legacy Application 和 2 个现代 ApplicationAttempt；
- 1 个 active Interview 与 1 个 upcoming CalendarEvent；
- legacy `triage_status=screened`，用于验证 v2 标准化。

## 实际命令

```text
backend\.venv312\Scripts\python.exe ..\.tmp\public-release-existing-user-migration-e2e.py
```

## 结果

```json
{
  "status": "PASS",
  "database": "isolated previous-release schema v1 fixture",
  "migration": {
    "user_version": 2,
    "integrity": "ok",
    "triage_values": ["picked"]
  },
  "seed": {
    "profile_id": 1,
    "resume_id": 1,
    "job_ids": [1, 2, 3, 4, 5],
    "attempt_ids": [1, 2]
  },
  "ui": {
    "today": true,
    "pipeline": true,
    "job_detail": true,
    "profile": true,
    "console_errors": [],
    "page_errors": [],
    "bad_responses": []
  }
}
```

## 浏览器路径

```text
v1 fixture
→ backend startup migration
→ Today reads migrated jobs/interview
→ Pipeline reads both application attempts
→ Job Detail reads migrated target job
→ Profile reads migrated user/profile content
```

所有步骤通过用户可见页面执行；测试只使用隔离数据库和本地 fixture，不调用真实邮箱、外部岗位站点或真实投递。

## 限制

- 这是 previous-release schema fixture，不是历史安装包到当前安装包的完整 installer upgrade；该 Gate 仍需可分发的上一版本安装器和 clean machine。
- 面试和日历数据是确定性夹具，不代表真实 Provider 或第三方 OAuth 验收。
- 这条证据证明迁移后的读取与页面投影可用，不改变签名、隐私法律决定、实时 Role Intelligence 和独立陌生用户验收的发布结论。
