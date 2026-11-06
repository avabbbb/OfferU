# AGENTS.md

给在这个仓库里写代码的 Agent 看的。产品以 `docs/PRD.md` 为准，架构以 `docs/DESIGN.md` 为准；`docs/archive/` 只作考古，不覆盖当前文档。

## 产品

OfferU 是本地优先的求职工具，用户是国内校招生和实习生。主线只有：今天待办、岗位和投递状态、邮箱同步（识别投递回执、笔试和面试邀约，回写投递状态和待办）、档案和简历、官网投递助手、面试复盘。邮箱发送之前需要得到用户的确认，凭据留在本机。

## 架构

- 所有读写都走 `backend/app/core/tools.py`（工具表是其中的 `TOOLS`，数据在 `core/store.py` 的 SQLite）。HTTP `/api/tools/*`、MCP `/mcp`、命令行 `offeru tool` 只是入口，不写业务逻辑。
- 数据只有 5 种 type：profile / memory / job / event / doc。新功能优先用它们和现有工具表达；
- 写操作直接生效，记一条 change，可以撤销。不加确认流程；只有对外发送和批量删除需要用户点头。
- 前端页面只通过 `frontend/src/lib/core.ts` 调工具。
- 内置 Agent 的循环和 provider 在 `backend/app/agent/`，保留。
- `app/ops.py`、`app/services/`、`app/agents/`、`app/routes/` 是旧架构，还没删完：可以改 bug、可以删，不要往里加新功能。

## 本地运行

- 前端端口默认 7410（在 `frontend/` 里 `npm run dev`），后端端口 8766（`backend/run_server.py`），都只听 127.0.0.1。如果打不开需要切换没被占用的接口
- 后端用 `backend/.venv`，不是根目录的 `.venv`。装依赖用 `backend/.venv/Scripts/python.exe -m pip install ...`，装完要重启后端进程才生效。
- 开发机是 Windows + Git Bash。`git status` 里 `integrations/dsh/dsh-home /` 的 warning 是本地一个带尾空格的目录，不用管。

## 写代码

- 测试环境的情况，没有真实用户，旧代码和旧数据可以直接删，不写迁移和兼容层。
- 不写防御性代码和只为覆盖率的测试。每个新工具一条走真实 HTTP / MCP 的端到端测试。
- 视觉：黑白灰；字号走 CSS 变量 + clamp()，正文约 13–15px，间距用 em / rem，不写死 px；不用徽章、统计卡、彩色按钮、网格背景、超大衬线标题。
- 改了界面，说清楚改了哪里、怎么点能看到。用户说自己验收时就不跑 Playwright。
- 自动化测试（Playwright、脚本请求）只用公开的官方招聘页（如飞书招聘）。小红书、BOSS 直聘等风控严的平台不要用自动化浏览器或脚本访问，哪怕只是测试：会连累用户的 IP 和账号。这类平台由用户在自己登录的浏览器里手动点一次验证。

## 提交和合并

- `main`：review之后可以提交
- `test`：没有保护，不用等 CI，可以直接合进去试。
- 用户在对话里同意合并后再合；合完同步本地 `main`。
- 不要碰用户自己没提交的改动；需要干净工作区时用 `git worktree`。

## 文档

- 时刻注意文档的时效性，过时文档移到 `docs/archive/<年-月>/`，并在 `docs/archive/README.md` 记一笔。
- 辅助用户真实求职时，遇到工具 / agent runtime 卡点，或用户给出偏好、纠正，当轮在 docs/DOGFOOD.md 记一行；改提示词、工具和评测前先看它。真实数据先脱敏再进 Regression。
