# AGENTS.md

给在这个仓库里写代码的 Agent 看的。产品以 `docs/PRD.md` 为准，架构以 `docs/ARCHITECTURE.md`（代码位置、运行形态、能力矩阵）和 `docs/DESIGN.md`（数据模型、工具语义）为准，**新增/迁移 UI 的视觉与交互以 `docs/design/visual-system.md` 为准**；`docs/archive/` 只作考古，不覆盖当前文档。

## 产品

OfferU 是本地优先的求职工具，用户是国内校招生和实习生。主线只有：今天待办、岗位和投递状态、邮箱同步（识别投递回执、笔试和面试邀约，回写投递状态和待办）、档案和简历、官网投递助手、面试复盘。邮箱发送之前需要得到用户的确认，凭据留在本机。

## 架构（TypeScript 后端是主线）

- **规则只在 `packages/core`**：工具表（`tools/index.ts` 的 `ALL_TOOL_SPECS`）、校验、overview、改动记录与撤销、简历渲染、内置 Agent 循环、`/api/config` 规则。纯 TypeScript，不 import React、DOM、`node:*`；存储、文件、网络、模型都从参数注入。
- **HTTP 只在 `backend-ts`**：`src/app.ts` 的 `createApp(deps)` 是唯一的 Hono 应用，路由在 `src/routes/<领域>.ts`，和 Python 同路径同形状。路由只解析输入、调 core、回 JSON；预期错误抛 `CoreError(message, code)`。
- **三种运行形态**，同一个 app：
  - 网页版（`VITE_OFFERU_MODE=local-web`）：`frontend/src/lib/local/backend.ts` 在页面里跑 `createApp`，数据在 IndexedDB；
  - Cloudflare Worker（`backend-ts/src/worker.ts`）：只发静态文件和转发模型请求（`/llm-proxy`，主机白名单），**不存任何用户数据**，不加 D1 / KV / DO / R2；
  - 桌面伴侣（`backend-ts/src/server.ts`，Node，SQLite，与 Python 同表结构）：唯一有本机能力的地方。
- **本机专属（companion-only）**：本机文件、Playwright PDF、poppler、BOSS 登录、Agent 看板、配置文件等只放 `backend-ts/src/routes/companion/`，在 `server.ts` 注入。浏览器和 Worker 永远不 import 它们；那里缺的能力回 501，不假装成功。
- **加工具 / 路由**：core 写规则 → 工具表登记（HTTP / MCP / CLI / 内置 Agent 自动可用）或 `routes/` 加模块并在 `routes/index.ts` 加一行 → 新依赖加到 `AppDeps` 并在 `server.ts` 和 `lib/local/backend.ts` 各自接上或明确不接 → **每个工具 / 路由一条和 Python 对照的契约用例**（`backend-ts/test/fixtures/` 由 Python 生成）+ 一条走 HTTP 的测试。步骤见 `docs/ARCHITECTURE.md` §5。
- 数据只有 5 种 type：profile / memory / job / event / doc。新功能优先用它们和现有工具表达。
- 写操作直接生效，记一条 change，可以撤销。不加确认流程；只有对外发送和批量删除需要用户点头。
- 前端页面只通过 `frontend/src/lib/core.ts` 调工具。
- **Python 后端（`backend/`）是回滚路径**：可以修 bug，不加新功能；还没迁的领域（邮箱同步、HTTP `/mcp`、面试等，见 `docs/backend-ts-migration.md`）暂由它提供。删除 Python 代码前，TS 版必须有同样的数据、错误、恢复行为并通过备份往返测试。

## 本地运行

- 装依赖：`npm --prefix backend-ts install`、`npm --prefix frontend install`（网页版构建会编译 `backend-ts/src`，两边都要装）。Node 24+。
- 网页版开发：`cd frontend && npx vite --mode local-web --port 7410`（不用起后端）。网页版构建：`npm run build:web`（末尾检查浏览器包里没有 Node 内置模块）。
- 连本机后端：前端非网页版构建固定连 `127.0.0.1:8766`。TS 伴侣 `cd backend-ts && OFFERU_TS_PORT=8766 npm run dev`（默认 8767，可和 Python 并排对照）；Python 回滚后端 `backend/run_server.py`，用 `backend/.venv`，不是根目录的 `.venv`。都只听 127.0.0.1，端口被占就换。
- Worker：`cd backend-ts && npm run worker:dev`（本地）、`npm run worker:dry-run`、`npm run deploy`。见 `docs/DEPLOY-CLOUDFLARE.md`。
- 测试和开发不要指向真实数据：伴侣用 `OFFERU_DATA_DIR` / `OFFERU_DB_PATH` 指到临时目录。
- 开发机可能是 Windows + Git Bash。`git status` 里 `integrations/dsh/dsh-home /` 的 warning 是本地一个带尾空格的目录，不用管。

## 写代码

- 测试环境的情况，没有真实用户，旧代码和旧数据可以直接删，不写迁移和兼容层。
- 不写防御性代码和只为覆盖率的测试。每个新工具一条走真实 HTTP / MCP 的端到端测试，迁移的工具再加一条 Python 契约用例。
- 后端改动提交前：`cd backend-ts && npm test && npm run typecheck`；动到 `app.ts` / `routes/` / core 时再跑 `cd frontend && npm run build:web` 和 `cd backend-ts && npm run worker:dry-run`，确认浏览器和 Worker 都还能打包。
- 视觉：参照 `docs/design/visual-system.md`（v3 Glass，2026-11-13 起，参考 Inspora · Bleep App）：冷暖渐变画布（只此一处渐变）+ 磨砂玻璃侧栏 + 半透明白纸面，几乎不用 1px 描边（靠透明度和柔和大阴影分层），大圆角，悬停 / 选中是白胶囊；**墨黑胶囊主按钮**，橙色只表示紧急 / 委托给 Agent，紫色只属于 Agent；状态 / 标签是浅底深字胶囊。新 UI 只用 `frontend/src/styles/design-tokens.css` 的语义 Token（`--ou-bg-*`、`--ou-glass-*`、`--ou-capsule-*`、`--ou-text-*`、`--ou-line-*`、`--ou-tone-*`、`--ou-elev-*`、`--ou-radius-*`），不自行写新色值、字体 px、阴影、圆角或 z-index。正文约 13–15px，文档视图 16px；不用 KPI 卡堆砌、彩色大底、卡片 / 按钮渐变和超大衬线标题。
- **先找参考**：做新界面、改版或新动效之前，先读 `docs/design/DESIGN.md`，再按 `docs/design/references.md` 在 Inspora / Awwwards / GSAP Showcase / Refero 找 2–3 个参考，把链接和「借什么」写进 PR 描述的「参考」一节。动效落地用 CSS + `--ou-motion-*` Token，不随手引入动画库。
- **组件**：新 UI 只组合 `frontend/src/components/ui/`（Button、Field、Select、Menu、Popover、Dialog、Panel、Pill，行为基于 Radix Primitives），规格见 `docs/design/components.md`。缺组件就先在 `components/ui` 加组件并写进 components.md，再在页面里用；禁止裸 `<select>`、手写菜单 / 弹层 / 阴影（`design:audit` 的 `raw-control` 规则会拦）。容器层级按 L0–L4，页面宽度用 `.ou-page-reading / -default / -wide`。
- 新 UI 首先明确任务、状态、主操作和渐进式披露；对照 `visual-system.md` 检查窄窗口、中文长文本、侧栏、浮层、IME、键盘焦点与错误恢复。改了界面要提供验证路径；有稳定测试夹具时跑 Playwright，用户明确要求手工验收时也要说明未覆盖的自动化项。
- 自动化测试（Playwright、脚本请求）只用公开的官方招聘页（如飞书招聘）。
- 公开版不碰 BOSS 直聘、小红书等风控平台：不自动打招呼、不后台爬取、不绕反爬。这类页面由用户在自己登录的浏览器里手动操作；插件只做当前页/选中文字的「存为岗位」。
- 官网网申表单的填写助手可以做（飞书招聘、Moka、北森等公开官网）：逐字段灰色预览、一键填入、批量填写、回读和撤销；提交按钮永远由用户点，不填密码/证件号/文件上传。
- 仓库里可能有未跟踪的本地实验目录（如 `internal/`），不要用 `git add -f` 把它们推上来；公开版能力以本文件和 PRD 为准。

- UI 提交前在 `frontend/` 执行 `npm run design:audit`、`npm run design:audit:test`、`npm run typecheck`、`npm test`、`npm run build`；`design:audit` 只阻止新增违规，历史报告不等于验收通过。不要通过放宽审计规则来跳过问题。

## 提交和合并

目标：多数 PR 当天合进 `main`，最多一个人参与（可以就是作者自己）；靠小改动、本地验证和快速回滚兜底，而不是靠等。参考 Anthropic Claude Code 团队的做法（claude.dev《How the Claude Code team does code review》，2026-10-15）。

1. **开 PR 前先自证**：Agent 自己跑完相关检查并贴出结果（前端 `npm run typecheck` + `npm run design:audit` + 相关 vitest；后端 `backend-ts` 的 vitest + typecheck，动了 Python 回滚后端才跑 pytest；UI 改动附截图或写明怎么看），再用新上下文做一次自审（只看 diff：有没有 bug、能不能更简单）。
2. **PR 要小**：一天内能合完的大小。大功能拆小、新行为先放在开关后面合进去。
3. **按风险分档，看改动不看人**（写进 PR 模板的「风险」）：

   | 档 | 典型改动 | 合并方式 |
   | --- | --- | --- |
   | 低 | 文档、文案、样式 / Token、`docs/design`、测试、开关后面的新增功能 | required checks 绿了就合（开 auto-merge），不等人 |
   | 中 | 普通前后端功能和修复 | 作者自审后自己合，合完自己盯 |
   | 高 | `.github/workflows/`、打包与自动更新（`frontend/src-tauri/`、安装包脚本）、BOSS 登录 / keyring / 凭据、`security_redaction`、数据库迁移与删除数据、发布脚本 | **必须等 @avabbbb 在对话或 PR 里点头** |

   拿不准就往高一档算。
4. **required checks**（`.github/workflows/build.yml`，按改动路径触发，一般 1–3 分钟）：`Backend tests`、`Frontend typecheck and build`、`Browser extension typecheck, test and build`、`Agent runtime install and audit`。红了先修，不绕过，不直接 push `main`。
5. **重活不挡合并**：Windows / macOS 安装包、安装后冒烟、跨进程恢复每天 05:00 CST 跑一次（`schedule`），打 `v*` tag 和手动触发时也跑；成功后发布 rolling nightly。nightly 红了，第二天第一件事是修或 revert。
6. **你合的你负责**：合进去出问题，作者优先修；修不了就直接 revert（`git revert` 走低档 PR），不追责。
7. `test` 分支：没有保护，不用等 CI，可以直接合进去试。
8. 不要碰用户自己没提交的改动；需要干净工作区时用 `git worktree`。合完同步本地 `main`。

## 文档

- 时刻注意文档的时效性，过时文档移到 `docs/archive/<年-月>/`（不删），在该目录的 README 和 `docs/archive/README.md` 记一笔。`docs/` 默认被 `.gitignore` 忽略，新的现行文档要加进白名单。
- 辅助用户真实求职时（同时在优化 OfferU 的 agent），当轮把卡点和偏好记进 docs/DOGFOOD.md，不用先问：
  - 工具卡点：OfferU 工具或 agent runtime 报错、缺参数、结果不对、超过 60s、要人工绕路、多跑一轮。写日期 | 工具 / 环节 | 现象 | 影响 | 待办。
  - 用户偏好：用户说要 / 不要、以后都…，或纠正了产出。尽量用原话，不放大成「总是」；写日期 | 场景 | 偏好 | 落到哪。
  - 同一问题更新原行不重复加；修好在行尾标「→ 已修 <commit>」。只写事实，原因不确定写「待查」；不写手机、邮箱、token、JD 或简历原文，岗位用 #id。
  - 改提示词、工具、评测前先读它；做法和已记录偏好冲突先问用户。真实数据先脱敏再进 Regression。
