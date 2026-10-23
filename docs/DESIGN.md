# OfferU 系统设计

> 2026-10 重写，和重构 PR 同步更新。产品需求见 [PRD](./PRD.md)，计划见 [PLAN](./PLAN.md)。

## 1. 目标与非目标

**目标**

- 一套工具，人（网页）、内置 Agent、外置 Agent（Codex / Claude Code）、浏览器插件都调用它，读写同一份数据。
- 所有写操作直接生效，留一条改动记录，可以撤销。
- 后端核心代码少到一个人一下午能读完。

**非目标**

- 不做权限审批流、提案队列、Run 生命周期、Operation Registry。旧版的这些设计已归档。
- 不做多用户、云同步、服务端部署。
- 不为每种 Agent 宿主写适配层，只提供 MCP 和命令行两种接入。

## 2. 总体结构

```text
 网页 (Vite + React)      浏览器插件        Codex / Claude Code      桌面小球
        │ HTTP              │ HTTP              │ MCP / offeru tool      │ HTTP
        └──────────────┬────┴───────────────────┴────────────────────────┘
                       ▼
          FastAPI  127.0.0.1:8766
          /api/tools/{name}   /mcp   /api/agent（Ctrl+K）
                       │
                       ▼
          app/core/tools.py   ← 唯一的工具层：参数校验、枚举、overview 规则
                       │
                       ▼
          app/core/store.py   ← SQLite offeru.db：records + changes
                       │
          内置 Agent（app/core/agent.py）   后台 Codex（app/core/handoff.py）
          OpenAI 兼容接口，最多 6 步        codex exec + OfferU MCP
```

谁调用的工具，就记谁的名字（actor）：网页是「你」，MCP 取客户端名（codex / claude），命令行取 `OFFERU_ACTOR`，内置 Agent 是「助手」。

## 3. 数据模型

只有两张表。

```sql
records(id, type, job_id, data JSON, created_at, updated_at)
changes(id, at, actor, summary, type, record_id, before JSON, after JSON, undone_at)
```

`type` 只有 5 种，字段放在 `data` 里，不建列，不做迁移：

| type | 用途 | 主要字段 |
| --- | --- | --- |
| profile | 基本信息，只有一条 | name, school, major, degree, grad_year, phone, email, city, target, stage, about |
| memory | 职业记忆，一条一件事 | kind（experience / project / education / skill / award / preference / note）, title, body, start, end, tags |
| job | 岗位和投递状态 | company, title, status（saved / applied / test / interview / offer / rejected / closed）, url, city, jd, notes, applied_at |
| event | 待办和日程 | title, kind（todo / deadline / test / interview）, at, done, job_id, notes |
| doc | 长文本 | kind（resume / apply_chat / review / research / note）, title, body（Markdown）, job_id, template |

为什么这样设计：

- 字段会频繁变（Agent 也会写新字段），JSON 不需要迁移；SQLite 的 `json_extract` 足够做筛选。
- 简历、网申对话、复盘、调研都是「挂在某个岗位下的一篇 Markdown」，用一种 doc 表示，界面按 kind 渲染。
- 网申对话存成 doc：`body` 是 Markdown，每道题一个 `## 题目` 段落，回答放在代码块里，界面把代码块渲染成可复制的块；同一题的多个版本就是多个代码块。

## 4. 写入与撤销

- `save(type, data, id?)`：没有 id 就新建；有 id 就合并更新，值为 `null` 表示删掉这个字段。每次写入在同一个事务里追加一条 change，保存改动前后的完整 data。
- `delete(type, id)`：删记录，change 里保留 before。
- `undo(change_id)`：把记录恢复到 before（删除的记录会重新插回原 id），并标记 `undone_at`。撤销本身也记一条 change，所以「撤销撤销」也行。
- 同一个人对同一条记录连续做同一种修改（比如在编辑器里打字），10 分钟内合并成一条 change，撤销时回到第一次修改之前。
- 界面不做确认弹窗。误操作的成本由撤销承担。

**需要点头的动作**（PRD §4）不通过工具直接执行：工具只生成草稿（比如网申最终答案、邮件正文），真正「发出去」的按钮在界面上，由用户点。批量删除（一次超过 3 条）返回「需要确认」，由界面弹一次确认。

## 5. 工具清单

目标是不超过 15 个。✓ 表示已在 #134 实现。

| 工具 | 作用 | 状态 |
| --- | --- | --- |
| overview | 今天页的全部数据：阶段、下一步、分组待办、岗位、最近改动 | ✓ |
| search | 跨类型全文搜索 | ✓ |
| list / get | 按类型 / 状态 / 岗位列出，取全文 | ✓ |
| save / delete | 写入、删除 | ✓ |
| undo / changes | 撤销、最近改动 | ✓ |
| fetch_page | 抓公开网页的文字（岗位链接） | ✓ |
| read_file | 读本地 PDF / Word / txt / md 的文字（导入简历） | ✓ |
| export_resume_pdf | 简历 doc → PDF 文件 | ✓ |
| ask | 交给内置 Agent 处理一句话（Ctrl+K） | PR3 |
| handoff | 把长任务交给后台 Codex，返回任务 id | PR5 |
| handoff_status | 看后台任务进度 | PR5 |

工具的说明文字就是 Agent 看到的全部文档。每个工具的说明写清字段和枚举，Skill 只讲「什么时候用哪个工具」，不超过 4KB。

## 6. 简历渲染

- 简历是 doc（kind=resume）：`body` 是 Markdown，`template` 是 single / compact / photo。
- `core/resume.py` 用 markdown-it 把 Markdown 转成 HTML，套 `core/templates/` 里的 CSS。`### A | B | 时间` 渲染成左右两端对齐的一行。
- 预览（`POST /api/resume/render`）和 PDF（`GET /api/resume/{id}/pdf`、`export_resume_pdf`）用同一份 HTML，所以预览就是导出的样子。
- PDF 用 Playwright 驱动本机的 Chrome 或 Edge 打印，不随安装包带浏览器。
- 证件照和导入的文件存在数据目录的 `files/`，档案里只存文件名（`POST /api/files` 上传）。

## 7. 三个入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| HTTP | `GET /api/tools`、`POST /api/tools/{name}` | 网页、插件、小球都用这个。请求头 `x-offeru-actor` 指定 actor。 |
| MCP | `/mcp`（Streamable HTTP）和 `offeru mcp`（stdio） | `offeru connect` 自动执行 `codex mcp add` / `claude mcp add`。 |
| 命令行 | `offeru tool <name> '<json>'` | MCP 连不上时的备用，也方便脚本和测试。 |

三个入口最后都调用 `tools.call(name, args, actor=)`，没有各自的业务逻辑。

## 8. 内置 Agent（PR3）

- 设置里填 OpenAI 兼容的 base_url、key、模型名，存在本机配置文件里。
- `/api/agent` 接收一句话 + 当前页面（比如正在看的岗位 id），用 function calling 调同一套工具，最多 6 步，流式返回。
- 系统提示词只有三件事：今天日期和 overview 摘要、工具说明、规则（不编造经历；对外的事只写草稿；长任务调用 handoff）。
- 没配模型时，Ctrl+K 只做本地解析不了的提示：「先在设置里填模型，或者在 Codex 里说这句话」。

## 9. 后台 Codex 交接（PR5）

- `handoff(task, job_id?)` 在后台启动 `codex exec`，带上 OfferU MCP 和 Skill，工作目录在数据目录下的 `runs/<id>/`。
- 先验证能否无人值守：非交互模式、MCP 是否自动可用、沙箱是否允许访问 127.0.0.1。验证不过就退回「复制这段话到 Codex」。
- 进度只看两样：进程是否还在、它写了哪些 change。完成后今天页的最近改动里出现「codex：……」。
- 同时只跑一个后台任务。

## 10. 前端

- Vite + React + HashRouter，`lib/core.ts` 提供 `tool()`、`useTool()`（SWR）、`write()`（写完全局刷新）。页面只调工具，不调其他接口。
- 页面：今天 `/`、岗位 `/jobs`、岗位详情 `/jobs/:id`、简历 `/resume/:id?`、档案 `/profile`（和简历同一个导航项，两个标签）、面试 `/interview`、设置 `/settings`。
- 共用组件：EventList、RecentChanges、ChatDoc（PR3）、CommandK（PR3）。简历编辑器就是一个 textarea + 预览 iframe。
- 视觉：黑白灰，13px 正文，不用徽章、统计卡、彩色按钮、网格背景。

## 11. 浏览器插件（PR4，第四期）

- 在已适配的网申系统上自动读出表单字段（沿用 smartfill-v2 的站点规则）；其他网站点一下插件图标再读。
- 页面右侧开小侧栏，用的是这个岗位的同一份网申对话 doc。
- 每个输入框标题旁边放「填写」：悬停预览，已有内容时变「替换」，填完可撤销。不自动点提交。

## 12. 桌面小球（第四期之后）

pywebview 小窗，随 `offeru start` 打开，轮询 overview；有新的改动或临近的日程时头像动一下；悬停展开今天的待办，可以勾掉。

## 13. 目录（重构完成后）

```text
backend/app/core/   store.py  tools.py  resume.py  templates/  agent.py  handoff.py
backend/app/        main.py  mcp_server.py  entry.py
backend/skill/      SKILL.md（≤4KB）
frontend/src/       app/  components/core/  lib/core.ts
extension/          smartfill（PR4 改接 /api/tools）
```

PR5 删除：`app/ops.py`、`app/services/`、`app/agents/`、`app/agent/`、旧 `routes/`、旧 Skill 生成器和 `models/models.py` 里的旧表。

## 14. 测试策略

- 后端：`tests/test_core.py` 走真实的 HTTP + MCP + 撤销路径，每个新工具至少一条端到端用例。旧测试随旧代码一起删。
- 前端：每个 PR 用 Playwright 在干净数据目录下把主线点一遍并截图。
- 不写只为提高覆盖率的单元测试，不写防御性分支。
