# AGENTS.md

给在这个仓库里写代码的 Agent 看的。产品和设计以 `docs/PRD.md`、`docs/DESIGN.md`、`docs/PLAN.md` 为准，`docs/archive/` 只作参考。

## 产品

OfferU 是本地优先的求职工具，用户是国内校招生和实习生。主线只有：今天待办、岗位和投递状态、邮箱同步（识别投递回执、笔试和面试邀约，回写投递状态和待办）、档案和简历、官网投递助手、面试复盘。邮箱只读不发，凭据留在本机。不做 BOSS、统计、插件市场、海投、绕反爬。

## 架构

- 所有读写都走 `backend/app/core/tools.py`（数据在 `core/store.py` 的 SQLite）。HTTP `/api/tools/*`、MCP `/mcp`、命令行 `offeru tool` 只是入口，不写业务逻辑。
- 写操作直接生效，记一条 change，可以撤销。不加确认流程；只有对外发送和批量删除需要用户点头。
- 新功能优先用现有 5 种 type（profile / memory / job / event / doc）和现有工具表达。工具总数不超过 15 个，Skill 不超过 4KB。
- 前端页面只通过 `frontend/src/lib/core.ts` 调工具。

## 写代码

- 现在没有真实用户，旧代码和旧数据可以直接删，不写迁移和兼容层。
- 不写防御性代码和只为覆盖率的测试。每个新工具一条走真实 HTTP / MCP 的端到端测试。
- 改界面要在干净数据目录下用 Playwright 点一遍主线并截图。视觉：黑白灰；字号和间距弹性适配不同设备（字号走 CSS 变量 + clamp()，正文约 13–15px，间距用 em / rem，不写死 px）；不用徽章、统计卡、彩色按钮、网格背景、超大衬线标题。
- 提交前：后端 `pytest tests`，前端 `tsc --noEmit`、`vitest run`、`vite build`。没跑或失败的要如实写出。
- PR 正文写：做了什么、删了什么、怎么验收、截图。不要合并 PR。
- 完成一个 PR 时更新 `docs/PLAN.md` 的状态和 `docs/DESIGN.md` 对应章节。
