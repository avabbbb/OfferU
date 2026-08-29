# OfferU Internal Beta Handoff

当前目标已经从“完成某个功能切片”切换为 `INTERNAL_BETA_READY_WITH_EXTERNAL_BLOCKERS`。后续工作应继续遵守 `GOAL.md` 的 Core Loop 和 `STATUS.md` 的验收边界。

## 稳定主链

```text
TypeScript UI
→ Python FastAPI Career Runtime
→ Operation Registry
→ Replay / Fixture / Pi / Codex Adapter
```

Today、Pipeline、Job Detail 和 Profile 读取同一份职业状态；Memory 是 Profile 更新机制，Agent 不拥有 Career Truth。

## 复现内测

```powershell
Set-Location <OfferU>
backend\.venv312\Scripts\python.exe backend\run_server.py
npm --prefix frontend run dev
```

打开 `http://localhost:7410`，第一次使用选择快速建档，再保存岗位并选择“本地准备（推荐）”。完整浏览器脚本见 `C:\temp\offeru-internal-beta-golden.js`、`offeru-interview-golden.js`、`offeru-memory-accept.js`、`offeru-failure-golden.js`。

## 数据与进程边界

- `backend\offeru.db` 是用户本地数据库，任何验收请使用新的 `.tmp\internal-beta-*` SQLite 文件。
- 本轮隔离后端应在交付前停止；不要把临时 `DATABASE_URL` 留给用户环境。
- 备份、恢复和隐私说明见 `QUICKSTART.md`；本地数据导出入口在 Settings。
- Codex、Gmail、DSH 失败只能保留为明确的 blocked/optional 状态，不能伪造成功或阻塞 Replay 核心路径。

## 下一阶段候选

只在有明确用户价值时推进：实时 Provider 验收、取消/重试任务的更细 UX、文件级恢复辅助和基于去标识化 Interview Experience 的未来分享能力。不要重新引入新的一级模块、Automation Agent、Memory 页面或 Python → TypeScript 全量重写。
