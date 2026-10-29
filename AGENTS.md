# AGENTS.md

给在这个仓库里写代码的 Agent 看的。产品以 `docs/PRD.md` 为准，架构以 `docs/DESIGN.md` 为准；`docs/archive/` 只作考古，不覆盖当前文档。

## 产品

OfferU 是本地优先的求职工具，用户是国内校招生和实习生。主线只有：今天待办、岗位和投递状态、邮箱同步（识别投递回执、笔试和面试邀约，回写投递状态和待办）、档案和简历、官网投递助手、面试复盘。邮箱只读不发，凭据留在本机。不做 BOSS、统计、插件市场、海投、绕反爬。

## 架构

- 所有读写都走 `backend/app/core/tools.py`（工具表是其中的 `TOOLS`，数据在 `core/store.py` 的 SQLite）。HTTP `/api/tools/*`、MCP `/mcp`、命令行 `offeru tool` 只是入口，不写业务逻辑。
- 数据只有 5 种 type：profile / memory / job / event / doc。新功能优先用它们和现有工具表达；工具总数不超过 15 个，Skill 不超过 4KB。
- 写操作直接生效，记一条 change，可以撤销。不加确认流程；只有对外发送和批量删除需要用户点头。
- 前端页面只通过 `frontend/src/lib/core.ts` 调工具。
- 内置 Agent 的循环和 provider 在 `backend/app/agent/`，保留。
- `app/ops.py`、`app/services/`、`app/agents/`、`app/routes/` 是旧架构，还没删完：可以改 bug、可以删，不要往里加新功能。

## 本地运行

- 前端端口 7410（在 `frontend/` 里 `npm run dev`），后端端口 8766（`backend/run_server.py`），都只听 127.0.0.1。
- 后端用 `backend/.venv`，不是根目录的 `.venv`。装依赖用 `backend/.venv/Scripts/python.exe -m pip install ...`，装完要重启后端进程才生效。
- 开发机是 Windows + Git Bash。`git status` 里 `integrations/dsh/dsh-home /` 的 warning 是本地一个带尾空格的目录，不用管。

## 写代码

- 现在没有真实用户，旧代码和旧数据可以直接删，不写迁移和兼容层。
- 不写防御性代码和只为覆盖率的测试。每个新工具一条走真实 HTTP / MCP 的端到端测试。
- 视觉：黑白灰；字号走 CSS 变量 + clamp()，正文约 13–15px，间距用 em / rem，不写死 px；不用徽章、统计卡、彩色按钮、网格背景、超大衬线标题。
- 改了界面，说清楚改了哪里、怎么点能看到。用户说自己验收时就不跑 Playwright。

## 提交和合并

- 提交前：后端 `backend/.venv/Scripts/python.exe -m pytest tests`，前端 `tsc --noEmit`、`vitest run`、`vite build`。没跑或失败的要如实写出。
- 一件事一个分支、一个 PR，用 squash 合并，合并后删分支。PR 正文写：做了什么、删了什么、怎么验收。
- `main`：不需要 review，但 Backend tests、Frontend typecheck and build、Browser extension typecheck, test and build、Agent runtime install and audit 4 项必须全绿。不要用 `--admin` 强合，除非用户明确要求。
- `test`：没有保护，不用等 CI，可以直接合进去试。
- 用户在对话里同意合并后再合；合完同步本地 `main`。
- 不要碰用户自己没提交的改动；需要干净工作区时用 `git worktree`。

## 文档

- 当前文档只有 `docs/PRD.md` 和 `docs/DESIGN.md`。改了架构或工具，同一个 PR 里更新 `DESIGN.md` 对应章节。
- 不新增计划、迭代记录之类会过期的文档；不写会过期的数字（测试数量、commit 号、模型名）。
- `docs/RELEASE_CHECKLIST.md` 和 `docs/KNOWN_ISSUES.md` 由 CI 里的发布审计脚本读取，不能挪走或改格式。
- 过时文档移到 `docs/archive/<年-月>/`，并在 `docs/archive/README.md` 记一笔。
