# OfferU Development Guide

本文件只面向源码开发与隔离测试，不是 Public Release 用户安装说明。陌生用户发布路径必须由 installer 完成，不得要求 Python、Node、repo 或终端。

## Environment

当前主要开发环境是 Windows：Python 3.12、Node.js 22+、npm；只有运行桌面壳时需要 Rust/Tauri toolchain。

```powershell
Set-Location <OfferU>
py -3.12 -m venv backend\.venv312
backend\.venv312\Scripts\python.exe -m pip install --upgrade pip
backend\.venv312\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
```

`backend/.env` 与 `backend/config.json` 可能包含本地 Provider 配置，不得提交或放入日志、trace、诊断包和公开 Issue。

## Browser development

终端 A：

```powershell
Set-Location <OfferU>\backend
.\.venv312\Scripts\python.exe run_server.py
```

终端 B：

```powershell
Set-Location <OfferU>
npm --prefix frontend run dev
```

前端固定为 <http://localhost:7410>，后端固定为 <http://127.0.0.1:8765>。出现 `Failed to fetch` / CORS 时，先检查 Windows 用户环境变量 `CORS_ORIGINS`；系统环境变量优先于 `backend/.env`，必须包含 `http://localhost:7410,http://127.0.0.1:7410`。

## Desktop development

```powershell
npm --prefix frontend run tauri -- dev
```

桌面开发壳会启动自己的前端与后端，不要同时保留浏览器开发的两个进程。当前 release 壳仍依赖源码仓库与 `.venv312`，只能用于开发，不能当作 production sidecar 或 clean-machine installer。

## Internal Beta fixture journey

1. Welcome 选择快速创建或导入简历；
2. 补充至少一条可核对经历；
3. 在 Opportunity 保存岗位并粘贴 JD；
4. 选择明确标记的 Replay/Fixture 本地准备；
5. 从 Job Detail 查看情报、证据缺口、材料和面试；
6. 在 Resume Workspace 审核 Proposal、手动编辑、保存 Version、导出 PDF；
7. 在 Today/Pipeline 查看同一 Career Truth 的投影；
8. 完成 Interview → Debrief → Learning Candidate → Profile review。

Replay/Fixture、合成公司和比较岗位不代表实时市场数据。Showcase 使用独立 IndexedDB 虚构数据，不能作为 Python Runtime 验收。

## Development data isolation

真实 `backend/offeru.db` 不得用于自动化写入验收。为每次 E2E 设置新的隔离 `DATABASE_URL`、workspace 和 browser state，并确认没有把临时环境变量留给用户环境。

停服后手工复制 SQLite 文件只能用于开发期应急副本，不是 Public Release Backup Gate。正式备份必须使用 SQLite Online Backup API，包含 DB、相关资产和版本 manifest；正式恢复必须经过 staging、完整性检查、重启与失败回滚。当前权威状态见 [`STATUS.md`](./STATUS.md)。

Settings 的 JSON export 用于可读数据携带，不等于完整备份，也不能原样恢复 Provider 凭据或全部本地资产。

## Suggested verification commands

项目级 `AGENTS.md` 要求实现 Agent 不执行这些命令，由使用者或明确授权的验收阶段运行：

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m pytest tests -q

Set-Location ..\frontend
npm run typecheck
npm run build
```

单个命令通过不代表 Public Release Ready。正式证据还必须覆盖 migration、backup/restore、security、desktop packaging、clean install、live provider、failure E2E、10/10 critical journey、50-run stability 与 soak。

## Current facts and goals

- Internal Beta 历史路径：[`INTERNAL_BETA.md`](./INTERNAL_BETA.md)
- 唯一最终目标：[`GOAL.md`](./GOAL.md)
- 当前 Gate：[`STATUS.md`](./STATUS.md)
- Release matrix：[`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md)
