# OfferU Internal Beta Status

更新时间：2026-08-29

## 当前判定

```text
INTERNAL_BETA_READY_WITH_EXTERNAL_BLOCKERS
```

核心 Career OS 可以在本地 Replay/Fixture 路径完成内测闭环。Codex OAuth、Gmail OAuth、真实外部岗位研究和 DeepSeek Harness 仍需要额外凭据或独立环境，不阻塞核心路径。

## 已验证环境

- 前端：`http://127.0.0.1:7410`
- 后端：`http://127.0.0.1:8765`
- 验收数据库：`.tmp/internal-beta-20260829/e2e-final3.db`
- Runtime：Replay；真实用户数据库 `backend/offeru.db` 未用于 Golden Path 写入

## 验收证据

| Gate | 结果 | 证据 |
| --- | --- | --- |
| Startup / Doctor | PASS | `/api/health` 返回 200，包含 version/build mode/database path/runtime mode；Doctor 报告 Python backend、前端地址、4 个 Provider 和可选集成；Operation Registry 235 项 |
| Onboarding | PASS | `C:\temp\offeru-internal-beta-golden.js` 从 Welcome、画像问答、跳过 Provider、快速建档走到首个岗位 |
| Job automation | PASS | 保存岗位后自动创建 Role Intelligence / CareerTask，并生成可审核材料候选 |
| Role Intelligence | PASS | Fixture benchmark 展示样本数、公司数、数据模式、Delta、Evidence Gap 和来源；统计由 Runtime 产生 |
| Resume | PASS | 浏览器完成 Candidate → 接受 → Resume Version；未静默覆盖正式简历 |
| Today / Pipeline / Job | PASS | 读取同一 Job/Application/Event 投影；目标岗位不会伪装成已投递；无 console error |
| Interview | PASS | `offeru-interview-golden.js` 提交 5 个真实 UI 回答并生成 Debrief；Interviewer/Coach 分离 |
| Learning / Profile | PASS | `offeru-memory-accept.js` 完成 Learning Candidate → 接受 → Profile career hypothesis 回流 |
| Provider failure | PASS | Codex 认证失败进入 blocked；Job Detail 显示原因和 Fixture action；Today 显示失败任务 |
| Duplicate prevention | PASS | 重复保存同一岗位后 Job、Event、CareerTask 数量保持不变 |
| Restart persistence | PASS | 重启后 ready 岗位、blocked 任务和已完成 Interview 仍可读取 |
| Data safety | PASS | 设置页导出 JSON；敏感键脱敏；SQLite 备份和恢复步骤写入 `QUICKSTART.md` |
| Feedback | PASS | Settings 可下载包含当前页面、版本、构建模式和用户描述的本地诊断包，不自动上传 |
| Plugin boundary | PASS | `test_job_search_plugin.py` 与 `test_byok_directory_skills.py` 共 17 项通过 |

浏览器脚本全部通过，相关输出保存在本轮临时终端结果和 `C:\temp` 脚本中；最终验收不依赖直接改数据库跳过 UI 步骤。

## 最终验证命令

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m pytest tests -q

Set-Location ..\frontend
npm run typecheck
npm run build
```

结果：后端 `262 passed, 9 warnings, 1 subtests passed`；前端 typecheck/build 已通过。警告为既有 Pydantic 字段命名和 `datetime.utcnow()` 弃用提示，不影响本轮闭环。

## External blockers

- Codex：本机 OAuth 未完成，状态为 `BLOCKED_EXTERNAL_AUTH`。
- Gmail：需要使用者授权，当前不自动同步真实邮件。
- DeepSeek Harness：保留 Adapter，标记 experimental。
- 实时网页研究：Provider、网络和登录墙可使任务 blocked；可用明确标记的 Fixture/Replay 验证产品链。

## 不阻塞内测的限制

- 默认仍是本地单人 SQLite，没有云同步、多人协作、计费或社区 Feed。
- 数据恢复目前是停服后的文件级恢复，不提供云端恢复服务。
- Showcase 是独立的虚构 IndexedDB 展示模式，不能替代 Python backend 的真实验收。
- 真实外部提交申请、发邮件和联系第三方始终需要用户明确操作。
