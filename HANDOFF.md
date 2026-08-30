# OfferU Internal Beta Handoff

当前 Internal Beta 核心路径已完成 Resume Workspace 产品化验收，状态为 `RESUME_WORKSPACE_BETA_READY`。后续工作继续遵守 `STATUS.md` 的验收边界，不重新扩展 Agent 或一级产品模块。

## 稳定主链

```text
TypeScript UI
→ Python FastAPI Career Runtime
→ Operation Registry
→ Replay / Fixture / Pi / Codex Adapter
```

Today、Pipeline、Job Detail 和 Profile 读取同一份职业状态；Memory 是 Profile 更新机制，Agent 不拥有 Career Truth。

Resume 主链：

```text
Career Evidence → Master / source Resume → Job Tailored Workspace
→ Proposal Diff → Manual / AI Review → ResumeVersion
→ Application Packet → Today / Pipeline
```

Workspace 通过 `get_resume_workspace`、`ensure_resume_workspace` 和 `review_resume_proposal_item` 进入 Operation Registry；`workspace_snapshot_hash` 阻止 stale Proposal 覆盖手工修改。PDF 打印页使用 HashRouter 地址，并优先由 Python Playwright + 本机 Chrome 渲染。

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

## 本阶段验证

- 前端三栏 Workspace 已覆盖结构化编辑、实时预览、Proposal Before/After、逐条审核、模板控制、版本历史、撤销、自动保存和 PDF 导出。
- 隔离数据库浏览器路径已验证 Job Detail → Workspace、Accept/Reject、手动修改、stale 阻断、V2、Application Packet 和 PDF。
- Fact Gate blocked Proposal 的单条/全部接受按钮会被禁用；中文/英文混排 PDF 已渲染检查无裁切。
- 后端全量回归 `265 passed`，前端 typecheck/build 通过；正常 lifespan 启动完成。
- Codex OAuth、Gmail、DSH 和 live research 仍是外部/实验性能力，不阻塞本地 Resume Workspace。

## 下一阶段候选

只在有明确用户价值时推进：实时 Provider 验收、取消/重试任务的更细 UX、文件级恢复辅助和基于去标识化 Interview Experience 的未来分享能力。不要重新引入新的一级模块、Automation Agent、Memory 页面或 Python → TypeScript 全量重写。
