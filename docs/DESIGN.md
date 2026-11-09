# OfferU 系统设计

> 2026-10 重写，和重构 PR 同步更新。产品需求见 [PRD](./PRD.md)。

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
          内置 Agent（app/core/agent.py → app/agent 循环）   后台 Codex（app/core/handoff.py）
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
| job | 岗位和投递状态 | company, title, status（saved / applied / test / interview / offer / rejected / closed）, url, city, jd, notes, applied_at, source（来源站点）, images（页面图片链接）, tags（最多 12 个，每个 1–20 字，不重复；list 可用 tag 参数筛）, auto_tags（tags 里 Agent 自动打的：招聘类型、城市由代码定，方向和公司属性是模型推断；重拆 JD 只换这部分）, tags_muted（用户删掉的 Agent 标签，重拆不再加回）；截止日期不放这里，存 event kind=deadline |
| event | 待办和日程 | title, kind（todo / deadline / test / interview）, at, done, job_id, notes |
| doc | 长文本 | kind（resume / apply_chat / review / research / note）, title, body（Markdown）, job_id, template；kind=review 另有 questions 数组 |

为什么这样设计：

- 字段会频繁变（Agent 也会写新字段），JSON 不需要迁移；SQLite 的 `json_extract` 足够做筛选。
- 简历、网申对话、复盘、调研都是「挂在某个岗位下的一篇 Markdown」，用一种 doc 表示，界面按 kind 渲染。
- 网申对话存成 doc：`body` 是 Markdown，每道题一个 `## 题目` 段落，回答放在代码块里，界面把代码块渲染成可复制的块；同一题的多个版本就是多个代码块。
- 面试复盘存成 doc（kind=review）：题目放在 `questions` 数组（最多 60 条，每条只允许 REVIEW_QUESTION_KEYS 里的四个键，值都是字符串，save 时校验）。旧复盘表的数据在第一次 list / get / 查卡住的题时一次性迁入，按 legacy_review_id 去重，actor=迁移；`/api/interviews` 的接口形状不变。

## 4. 写入与撤销

- `save(type, data, id?)`：没有 id 就新建；有 id 就合并更新，值为 `null` 表示删掉这个字段。每次写入在同一个事务里追加一条 change，保存改动前后的完整 data。
- `delete(type, id)`：删记录，change 里保留 before。
- `undo(change_id)`：把记录恢复到 before（删除的记录会重新插回原 id），并标记 `undone_at`。撤销本身也记一条 change，所以「撤销撤销」也行。
- 同一个人对同一条记录连续做同一种修改（比如在编辑器里打字），10 分钟内合并成一条 change，撤销时回到第一次修改之前。
- 界面不做确认弹窗。误操作的成本由撤销承担。

**需要点头的动作**（PRD §4）不通过工具直接执行：工具只生成草稿（比如网申最终答案、邮件正文），真正「发出去」的按钮在界面上，由用户点。批量删除（一次超过 3 条）返回「需要确认」，由界面弹一次确认。

## 5. 工具清单

现在 21 个（`GET /api/tools` 可查）。✓ 表示已实现。

| 工具 | 作用 | 状态 |
| --- | --- | --- |
| overview | 今天页的全部数据：阶段、下一步、分组待办、岗位、最近改动 | ✓ |
| search | 跨类型全文搜索 | ✓ |
| list / get | 按类型 / 状态 / 岗位列出，取全文 | ✓ |
| save / delete | 写入、删除 | ✓ |
| undo / changes | 撤销、最近改动 | ✓ |
| fetch_page | 抓公开网页的文字（岗位链接） | ✓ |
| read_file | 读本地 PDF / Word / txt / md 的文字（导入简历） | ✓ |
| find_files | 找本机文件：列目录，或按文件名 / 正文文字筛（带片段） | ✓ |
| web_search | 搜公开网页，返回标题、链接、摘要；没配搜索服务就报错 | ✓ |
| export_resume_pdf | 简历 doc → PDF 文件 | ✓ |
| ask | 交给内置 Agent 处理一句话（Ctrl+K） | PR3 |
| handoff | 把长任务交给后台 Codex，返回任务 id | PR5 |
| handoff_status | 看后台任务进度 | PR5 |
| email_sync | 邮箱状态 / 同步：拉新邮件，识别回执和邀约，直接回写岗位状态和事项（可撤销） | ✓ |
| tailor_resume | 按岗位 JD 改写简历（参考岗位评估）：岗位简历原地改；主简历写进该岗位的定制简历（没有就新建），主简历不动（一条 change，可撤销）。流程：起草（流式，JD 原文进 prompt，噪声由模型忽略）→ 审稿（独立一次模型调用，只读 JD、档案、原简历、初稿和 Playwright 按导出 HTML 量的页数，输出 {old, new, reason, category} 修改和四类意见）→ 按 old 精确替换（找不到 / 不唯一就跳过，改坏格式整轮作废），审 1 轮（2026-11-05 由 2 轮砍到 1 轮，省一次模型调用），最后写一次库。判断都交给模型，代码只量页数、做替换。返回 pages、rounds、notes、grounding（因找不到出处被改掉的内容，前端可一键存进档案）、asks（第 1 轮审稿挑出只写了动作、没写结果的句子，最多 3 条，存进 doc.pending_asks；先出一版再问用户）。review_only=true 不起草，只对已有定制简历跑审稿（档案补了新成果后再改一下）。用户的回答整理成记忆草稿走工作台专用路由 POST /api/resume/impact（只出草稿不写库；不是工具；外部 agent 自己整理后 save memory，带 quote 和 said_at），用户点「存进档案」才写入 | ✓ |
| split_resume | 把旧简历原文拆成一条条 memory 写进档案（可整次撤销） | ✓ |
| add_job | 贴岗位链接或 JD：抓正文、拆公司 / 岗位 / 城市 / JD，截止日另存 deadline 事项；抓不到正文就报错不存 | ✓ |
| evaluate_jobs | 评估岗位：每个岗位出评估报告（岗位下的 evaluation 文档，重评覆盖），0–100 分和三句理由写回 job.score / reasons（每步一条 change） | ✓ |
| apply_answer | 官网网申问答：用 JD、该岗位的定制简历、档案和记忆回答问题，问答追加到岗位下的 apply_chat 文档（每问一条 change） | ✓ |
| draft_email | 邮件投递草稿：从 JD / 备注拆投递邮箱和标题、附件要求，写标题正文、导简历 PDF，存为 email 文档；不发送，用户在邮件客户端确认后自己发 | ✓ |

工具的说明文字就是 Agent 看到的全部文档。每个工具的说明写清字段和枚举，Skill 只讲「什么时候用哪个工具」，不超过 4KB。

## 6. 简历渲染

- 简历是 doc（kind=resume）：结构化的 resume（basics + sections / items / bullets，见 core/resume_model.py）是唯一事实源，style 是排版（模板、字体、字号、行距、间距、边距、主题色、证件照、校徽）；body 由结构派生。
- core/resume.py 从结构直接渲染 HTML，每个可编辑元素带 data-path（如 sections.1.items.0.bullets.2），预览里点哪儿就定位到左侧表单哪儿。
- 正文和要点存轻量标记：双星号粗体、单星号斜体、方括号文字接圆括号链接、行首每 2 个空格缩进一级、{center} / {right} / {justify} 对齐、减号或「1.」开头的列表。前端 lib/richMarkup.ts 和后端渲染一一对应。
- 预览（POST /api/resume/render）和 PDF（GET /api/resume/{id}/pdf、export_resume_pdf）用同一个渲染函数和同一份模板 CSS，所以纸面就是导出的样子。
- PDF 用 Playwright 驱动本机的 Chrome 或 Edge 打印，不随安装包带浏览器。
- 证件照和导入的文件存在数据目录的 `files/`，档案里只存文件名（`POST /api/files` 上传）。

## 7. 三个入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| HTTP | `GET /api/tools`、`POST /api/tools/{name}` | 网页、插件、小球都用这个。请求头 `x-offeru-actor` 指定 actor。 |
| MCP | `/mcp`（Streamable HTTP）和 `offeru mcp`（stdio） | `offeru connect` 自动执行 `codex mcp add` / `claude mcp add`。 |
| 命令行 | `offeru tool <name> '<json>'` | MCP 连不上时的备用，也方便脚本和测试。参数也可以写 @文件路径（UTF-8 JSON）或 -（标准输入），避开 PowerShell 吞引号。 |

三个入口最后都调用 `tools.call(name, args, actor=)`，没有各自的业务逻辑。

### 7.1 Agent 看板（设置 > 我的 Agent）

- 一行一个 Agent：内置宿主（codex / claude / opencode / pi / omp / gemini / codebuddy / dsh）加使用者自己添加的。数据在数据目录的 agent_board.json，字段 custom / hidden / memory / checks / calls。
- 在线 = 正在运行 且 最近 10 分钟内有对话调用过 OfferU。Skill 文件在磁盘上、旧的 nonce 回读都不算。
  - 正在运行：每次列看板扫一次进程表（Windows 用 Get-CimInstance Win32_Process，其他系统用 ps），缓存 5 秒；命令行按空白、斜杠、引号切成词，匹配内置表里的名字（如 gemini-cli、oh-my-pi），自定义 Agent 匹配 id 和启动命令名。
  - 调用过：MCP 取客户端名（无状态 HTTP 取 User-Agent），命令行取 OFFERU_ACTOR，映射到看板上的 Agent 后记一条 calls（时间、客户端、对话提示、thread）。没有对话提示的普通调用同一个 Agent 30 秒最多写一次；记账失败不影响工具调用。
- 摘要行（在线 · 运行中 · Skill 已安装 · 需处理）由前端按当前显示的行计算，所以和看到的行永远一致；后端不返回汇总。
- 打开对话：POST /api/agent-board/{id}/launch，和确认动作一样要工作台的 Authorization，在用户目录下开一个新终端窗口运行 Agent 的交互式 CLI。命令只来自内置表或自定义 Agent 保存的裸命令名，从不来自请求。命令行对应 offeru agent launch <id>。
- 看板不改 Agent 的设置或记忆文件。

## 8. 内置 Agent（PR3）

- 设置里填 OpenAI 兼容的 base_url、key、模型名，存在本机配置文件里。
- `/api/agent` 接收一句话 + 当前页面（比如正在看的岗位 id），用 function calling 调同一套工具，最多 6 步，流式返回。
- 并发：每个 Run 独占一个 Worker（按 run_id 放在进程内池子里），不同对话、同一对话的多次发送都可以同时跑，不再抢占旧 Run，也不排队、不 steer。上限是设置里的「Agent 最大并发数」（默认 3，1–10，保存后对新任务立即生效）；超出时启动直接返回中文提示。Run 结束、中止或启动失败都释放名额；前端每次发送是独立的 turn（各自的 AbortController、流式文字和工具进度），运行中仍可继续输入。
- 循环、流式和 provider 复用现有的 `app/agent/`（`run_agent_loop`），`app/core/agent.py` 把全部 core TOOLS 包成 `LoopTool`（`loop_tools()`），每次经 `asyncio.to_thread(tools.call, ...)` 执行，actor=助手，最多 6 步，工具报错作为文本回给模型。宿主里的 skill router 和 guardian 暂时仍走旧 OPERATIONS，PR5 删除。
- 改写简历：网页仍走 SSE；工具 tailor_resume 同步返回，内部用 `_await` 把协程交给主事件循环（`run_coroutine_threadsafe`，lifespan 里设 `MAIN_LOOP`）。在事件循环线程里同步调用会直接报错，要用 `asyncio.to_thread`。HTTP 的 `POST /api/tools/{name}` 在线程池里跑、MCP 经 `anyio.to_thread`，都不会死锁。
- 系统提示词只有三件事：今天日期和 overview 摘要、工具说明、规则（不编造经历；对外的事只写草稿；长任务调用 handoff）。
- 没配模型时，Ctrl+K 只做本地解析不了的提示：「先在设置里填模型，或者在 Codex 里说这句话」。

## 9. 后台 Codex 交接（PR5）

- `handoff(task, job_id?)` 在后台启动 `codex exec`，带上 OfferU MCP 和 Skill，工作目录在数据目录下的 `runs/<id>/`。
- 先验证能否无人值守：非交互模式、MCP 是否自动可用、沙箱是否允许访问 127.0.0.1。验证不过就退回「复制这段话到 Codex」。
- 进度只看两样：进程是否还在、它写了哪些 change。完成后今天页的最近改动里出现「codex：……」。
- 同时只跑一个后台任务。

## 10. 邮箱同步

- 工具只加一个 email_sync(action: status | sync, account?)。status 返回已连账号、上次同步时间和结果，不含凭据；sync 拉新邮件并回写，返回处理了哪几封、各写了哪些 change。
- 凭据和模型设置一样存在本机配置文件（Gmail 存 refresh token，IMAP 存 host / user / 授权码），不进 offeru.db、不进 changes、不出现在任何工具返回里。连接和断开在设置页完成。
- 拉取（现在仍在 services/email_sync.py，PR5 移进 core/mail.py）：IMAP 用标准库 imaplib，只用 BODY.PEEK，不改已读状态；Gmail 用 REST，只申请 gmail.readonly。每个账号记 last_uid / history_id，增量拉取。
- 识别：classify(msg) -> {kind: receipt / test / interview / result, company, title, at, link, outcome}。规则优先（发件域名表 + 主题关键词 + 时间正则）；规则返回空且配了模型时调一次内置模型，只给发件人、主题和正文前 2000 字。
- 回写在 core/mail.py 的 apply()，全部走 save()，actor=邮箱，直接写入、不进待确认，误判靠撤销：岗位按公司 + 岗位名匹配，匹配不到新建 status=applied；status 只前进不后退；时间写成 event（kind=test / interview / deadline，job_id 指向岗位），notes 存发件人、主题、链接。每条写入的 data 带 mail_id（Message-ID）。
- 去重：同步前查 records 和 changes（before / after）里出现过的 mail_id，处理过的跳过，所以撤销后下次同步不会写回来。
- 不做：发信、标已读、删信、保存原始邮件。
- services/email_sync.py 只管账号、凭据和游标，每封新信交给 core/mail.apply 写入。旧 Operation Registry 里的邮箱操作（email_connection_status 等）随 PR5 删除。邮箱同步已不再调用 ingest_application_signal；旧候选表 application_progress_candidates 只剩旧 Operation 能读写，前端不展示，随 PR5 连表删除，不做数据迁移。

## 11. 前端

- Vite + React + HashRouter，`lib/core.ts` 提供 `tool()`、`useTool()`（SWR）、`write()`（写完全局刷新）。页面只调工具，不调其他接口。
- 页面：今天 `/`、岗位 `/jobs`、岗位详情 `/jobs/:id`、简历 `/resume/:id?`、档案 `/profile`（和简历同一个导航项，两个标签）、面试 `/interview`、设置 `/settings`。
- 共用组件：EventList、RecentChanges、JobBoard（今天页投递看板，前端直接 list job 和未完成 event）、TagInput、ChatDoc（PR3）、CommandK（PR3）。简历编辑器：顶栏一行（简历名下拉切换 / 新建 / 改名 / 复制 / 删除 | 排版工具栏，数值是「输入 + 下拉常用值」 | 下载 PDF）；左侧结构化表单，正文是所见即所得编辑框（存轻量标记）；右侧中性浅灰画布上的 A4 预览（只用一层浅阴影托出纸面），悬停模块显示蓝色虚线框，点击定位左侧；第一页分页线是中性灰虚线。简历编辑器配色和岗位页同一套 Notion 式中性色：底色、文字、细线继承全局，卡片纯白、输入框浅灰、标题无衬线、卡片圆角 10px（--radius-card）；彩色只留给蓝色主操作（下载 PDF，和「添加岗位」同色 #2383e2）、聚焦和链接，报错统一用 --primary-red。对齐：顶栏和左栏内边距都是 0.75rem，左栏卡片左缘对齐顶栏内容，卡片顶对齐右侧画布顶部。
- 岗位页 /jobs 是多维表格（参考飞书多维表格，调研见 docs/design/jobs-table-research.md）：视图 tab 表格 / 看板 / 甘特；顶栏有搜索、筛选、分组、排序、字段显隐、行高、重置和添加岗位。表格用 @tanstack/react-table，冻结公司列，悬停行出勾选框和「打开」，勾选后出批量栏，单元格直接改；「打开」进右侧详情抽屉（∧∨ 按当前顺序切换，Esc 关闭，失焦即存）。看板 tab 复用 JobBoard（embedded，不显示标题）。筛选 / 分组 / 排序是 lib/jobView.ts 里的纯函数；视图配置存 localStorage，自动保存。list 结果保留 created_at，给甘特当起点。甘特视图（components/jobs/JobsGantt.tsx，时间计算在 lib/jobGantt.ts，有单测）：左侧冻结岗位列（« / » 可折叠成窄边）、右侧时间轴，周 / 月两档缩放和「今天」按钮，竖红线标今天；条从收藏日画到最后一件事项（进行中的画到今天），颜色跟状态，已结束的变淡；条上菱形是截止 / 笔试 / 面试 / 待办，悬停出事项卡片（标题、类型、时间、备注），拖动按整天改 event.at（保留时刻），工具栏出「撤销」；条是推算的，不能拖。点行内空白处弹小表单，在那天给该岗位加事项（类型 + 标题，回车存、Esc 或失焦取消，表单夹在可视区内）。条整个在可视区外时行内贴边出 ← / →，点了滚到条起点。短条的文字画在条右边；网格按可视宽度往右补满；点条或岗位名打开详情抽屉；筛选 / 分组 / 排序用甘特视图自己的配置。看板列固定 260px，放不下时横向滚动。
- 岗位页视觉照 Notion 数据库：表格白底、无外框、无竖线、无行号，只留淡横线；组头「▸ 状态胶囊 数量」，组末「+ 新建」。状态和单选 / 标签都是 Notion 深色系胶囊：深底 + 浅字 + 左侧亮色小圆点；状态下拉照 Notion 按 待办 / 进行中 / 已完成 分组。顶栏是一排灰色图标（生效的变深并带计数），视图 tab 是浅灰圆角底，搜索点了才展开，最右蓝色「添加岗位」。看板列底统一中性浅灰，颜色只留给列头胶囊；卡片白底 + 浅灰细边 + 小阴影，列底「+ 新建」是灰字，直接在该阶段新建。甘特左列无竖线、网格更淡，条是低饱和圆角色块（不加左边框），今天是细红线加表头小圆点。
- 视觉：黑白灰；字号和间距弹性适配不同设备（字号走 CSS 变量 + clamp()，正文约 13–15px，间距用 em / rem）；不用徽章、统计卡、彩色按钮、网格背景（例外：岗位页照 Notion 用深色胶囊区分状态和标签。状态六色：灰（想投、不投了）、蓝（已投递）、黄（笔试 / 测评）、橙（面试中）、绿（offer）、红（未通过）；单选 / 标签按文字哈希取九色之一（灰、棕、橙、黄、绿、蓝、紫、粉、红），同一个值永远同一色。大面积底色不用彩色：看板列底中性浅灰，甘特条用状态色的低饱和版；蓝色另用于「添加岗位」，红色另用于截止和今天线）。

### 11.1 Agent 侧栏组件规范

先定层级，再谈装饰。每个元素先归到一层，层级只靠字号、字重、颜色和留白区分；边框、阴影、圆角只用来表达 L4 容器，不用来制造层级。

| 层 | 元素 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- | --- |
| L1 主内容 | Agent 回复正文、用户消息、提问卡的问题 | --agent-fs | 400（提问卡问题 600） | --foreground |
| L2 次要信息 | 对话标题、工具摘要行（已执行 N 步）、工具步骤、提问选项、输入框占位符 | --agent-fs-sm（对话标题用 --agent-fs 500） | 400 | --foreground-muted |
| L3 辅助控件 | 图标按钮、模型按钮、步骤状态（完成）、步数和秒数、历史列表时间 | --agent-fs-xs | 400 | --foreground-faint，悬停变 --foreground-muted 加 --surface-muted 底 |
| L4 容器 | 侧栏、输入框、提问卡、历史浮层、用户消息气泡 | — | — | 只用底色和阴影表达 |

- 降一层至少同时变颜色，再加字号或字重之一；同层元素不能只靠颜色区分。正文只用三种文字色：--foreground、--foreground-muted、--foreground-faint，L3 不放必须读的信息。
- 留白档位只有 4 / 8 / 12 / 16 / 24px（0.25 / 0.5 / 0.75 / 1 / 1.5rem）。组内用 8，组间用 16，区块之间用 24。顶栏、消息区、输入框外侧共用同一水平边距 12px，所有左边缘对齐。
- 每个视图最多一层带边框的容器。工具步骤之间不画分隔线，用 4px 间距和缩进表达从属。
- 阴影只给浮起的 L4：侧栏左缘柔和阴影（不画平直边线），输入框和提问卡用多层柔和阴影（0 0 0 1px + 0 2px 8px + 大半径淡阴影），历史浮层更深一档。圆角：输入框 16px，其他容器 12px，行和工具按钮 8px，发送按钮 14px。
- 输入框按 Flovart 结构：卡片 16px 圆角、8px 内边距、最小高 148px，多层柔和阴影浮起；上面无边框文本区（13px / 22px 行高），下面一行控件：左侧 28px 高的图标工具按钮（模型等），右侧 40px、14px 圆角的深色发送按钮，底部对齐。

## 12. 浏览器插件（PR4，第四期）

- 在已适配的网申系统上自动读出表单字段（沿用 smartfill-v2 的站点规则）；其他网站点一下插件图标再读。
- 页面右侧开小侧栏，用的是这个岗位的同一份网申对话 doc。
- 每个输入框标题旁边放「填写」：悬停预览，已有内容时变「替换」，填完可撤销。不自动点提交。

## 13. 桌面小球（第四期之后）

pywebview 小窗，随 `offeru start` 打开，轮询 overview；有新的改动或临近的日程时头像动一下；悬停展开今天的待办，可以勾掉。

## 14. 目录（重构完成后）

```text
backend/app/core/   store.py  tools.py  resume.py  tailor.py  templates/  agent.py  handoff.py  mail.py
backend/app/        main.py  mcp_server.py  entry.py
backend/skill/      SKILL.md（≤4KB）
frontend/src/       app/  components/core/  lib/core.ts
extension/          smartfill（PR4 改接 /api/tools）
```

PR5 删除：`app/ops.py`、`app/services/`、`app/agents/`、`app/agent/`、旧 `routes/`、旧 Skill 生成器和 `models/models.py` 里的旧表。

## 15. 测试策略

- 后端：`tests/test_core.py` 走真实的 HTTP + MCP + 撤销路径，每个新工具至少一条端到端用例。旧测试随旧代码一起删。
- 前端：每个 PR 用 Playwright 在干净数据目录下把主线点一遍并截图。
- 不写只为提高覆盖率的单元测试，不写防御性分支。
