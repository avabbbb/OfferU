# OfferU 系统设计

> 2026-10 重写，和重构 PR 同步更新。产品需求见 [PRD](./PRD.md)。

## 1. 目标与非目标

**目标**

- 一套工具，人（网页）、内置 Agent、外置 Agent（Codex / Claude Code）、浏览器插件都调用它，读写同一份数据。
- 所有写操作直接生效，留一条改动记录，可以撤销。
- 后端核心代码少到一个人一下午能读完。

**非目标**

- 不做权限审批流、提案队列、Run 生命周期、Operation Registry。旧版的这些设计已归档。
- 不做多用户；不在服务器上存用户数据。网页版部署在 Cloudflare Worker 上，但 Worker 只发静态文件和转发模型请求（见 [DEPLOY-CLOUDFLARE](./DEPLOY-CLOUDFLARE.md)）。跨设备同步只用用户自己的 S3 / R2 存储桶，端到端加密（见 10.1 和 [sync.md](./sync.md)）。
- 不为每种 Agent 宿主写适配层，外置 Agent 只走命令行（`offeru tool`）。MCP 于 2026-11-24 移除：每次会话要把全部工具 schema 塞进上下文，还要在每个宿主各注册一次；命令行按需 `--help`，装上 Skill 就能用。

## 2. 总体结构

> 2026-11 起后端是 TypeScript：规则在 `packages/core`，HTTP 应用是 `backend-ts/src/app.ts` 的 `createApp(deps)`，同一份代码跑在浏览器页面里（网页版）、Node 伴侣里（桌面版）。运行形态、能力矩阵和代码位置见 [ARCHITECTURE](./ARCHITECTURE.md)。下面各节的工具语义、数据模型、撤销规则不变；提到的 `core/*.py` 是已删除的 Python 版里的对应实现（tag `python-backend-final`），TS 版在 `packages/core/src/` 的同名领域目录。

```text
 网页（Vite + React）  浏览器插件     Codex / Claude Code       内置 Agent
        │ fetch /api/*     │ HTTP          │ offeru tool（命令行）      │
        └─────────┬────────┴───────────────┴────────────┬───────────────┘
                  ▼                                     ▼
   createApp(deps)（Hono）  /api/tools/{name}  /api/agent/*  /api/config  …
                  │
                  ▼
   packages/core  ← 唯一的工具层：参数校验、枚举、overview 规则、撤销、Agent 循环
                  │ CoreStore
       ┌──────────┴───────────┐
       ▼                      ▼
 IndexedDB（网页版，页面内）   SQLite offeru.db（桌面伴侣）：records + changes
```

谁调用的工具，就记谁的名字（actor）：网页是「你」，命令行取 `--actor`（看板装 Skill 时按 Agent 填好，如 codex），没有就 `OFFERU_ACTOR`，再没有是 agent；内置 Agent 是「助手」。

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
| event | 待办和日程 | title, kind（todo / deadline / test / interview）, at, done, job_id, notes, mail_stage（邮件同步写的同一阶段事项，用来把改期信并到原事项）。岗位进 rejected / closed 后，它未完成的事项不再进今天页 |
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
| evaluate_jobs | 评估岗位：每个岗位出评估报告（岗位下的 evaluation 文档，重评覆盖），0–100 分和三句理由写回 job.score / reasons（每步一条 change）。一次最多评 limit 个（默认 3），返回 remaining，大于 0 就再调一次；网页走 `/api/jobs/evaluate` 的 SSE 看进度 | ✓ |
| apply_answer | 官网网申问答：用 JD、该岗位的定制简历、档案和记忆回答问题，问答追加到岗位下的 apply_chat 文档（每问一条 change） | ✓ |
| draft_email | 邮件投递草稿：从 JD / 备注拆投递邮箱和标题、附件要求，写标题正文、导简历 PDF，存为 email 文档；不发送，用户在邮件客户端确认后自己发。只有真导出了附件才写「简历见附件」；返回 job_id / resume_id / ready / missing（缺附件、标题占位段等），草稿文档也记 resume_id / missing | ✓ |

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
| 命令行 | `offeru tool <name> '<json>'` | 外置 Agent 的唯一入口，Skill 由 Agent 看板「连接」装进 Agent 的 Skill 目录（见 7.1）。渐进披露：`offeru tool` 每个工具一行（`--json` 给机器读），`offeru tool <name> --help` 给完整说明和 schema，`offeru recipe <id>` 给常用流程。参数也可以写 @文件路径（UTF-8 JSON）或 -（标准输入），避开 PowerShell 吞引号。 |

两个入口最后都调用 `tools.call(name, args, actor=)`，没有各自的业务逻辑。

### 7.1 Agent 看板（设置 > 我的 Agent）

- 一行一个 Agent：内置宿主（codex / claude / opencode / pi / omp / gemini / codebuddy / dsh）加使用者自己添加的。数据在数据目录的 agent_board.json，字段 custom / hidden / memory / checks / calls。
- 在线 = 正在运行 且 最近 10 分钟内有对话调用过 OfferU。Skill 文件在磁盘上、旧的 nonce 回读都不算。
  - 正在运行：每次列看板扫一次进程表（Windows 用 Get-CimInstance Win32_Process，其他系统用 ps），缓存 5 秒；命令行按空白、斜杠、引号切成词，匹配内置表里的名字（如 gemini-cli、oh-my-pi），自定义 Agent 匹配 id 和启动命令名。
  - 调用过：命令行取 `--actor` / OFFERU_ACTOR（无状态 HTTP 取 User-Agent），映射到看板上的 Agent 后记一条 calls（时间、客户端、对话提示、thread）。没有对话提示的普通调用同一个 Agent 30 秒最多写一次；记账失败不影响工具调用。
- 摘要行（在线 · 运行中 · Skill 已安装 · 需处理）由前端按当前显示的行计算，所以和看到的行永远一致；后端不返回汇总。
- 打开对话：POST /api/agent-board/{id}/launch，和确认动作一样要工作台的 Authorization，在用户目录下开一个新终端窗口运行 Agent 的交互式 CLI。命令只来自内置表或自定义 Agent 保存的裸命令名，从不来自请求。只在工作台里操作，没有对应的命令行。
- 看板不改 Agent 的设置或记忆文件。

## 8. 内置 Agent（PR3）

- 设置里填 OpenAI 兼容的 base_url、key、模型名，存在本机配置文件里。
- `/api/agent` 接收一句话 + 当前页面（比如正在看的岗位 id），用 function calling 调同一套工具，默认最多 12 步（设置 `agent_max_steps`，1–40；单次请求的 `max_steps` 优先），流式返回。
- 并发（2026-11-23）：不同对话并行，同一对话同一时间只跑一轮（第二条 409，前端插话 / 排队 / 开新对话）。准入 `AgentHost.admit()`：先读设置里的「Agent 最大并发数」（默认 3，1–10，每次准入现读），再在一个同步步骤里检查并占位，新开、恢复、回答续跑共用；对话消息用 `AgentConversations.append` 在一个事务里追加，不整表回写。模型请求另有一份按服务商共享的额度（`ModelCallLimiter`，默认每家 4 个并发请求，`createApp` 包一次 `deps.llm`），Run 里的评估、改写、子任务都排在里面。
- 工具级保存点与恢复：Loop 在「要调工具的 assistant 消息」后、每个工具结果后都存 session；Agent 写入的 change 带 `op = "<run_id>:<tool_call_id>"`。恢复时停在一批工具中间的，没回结果的调用按 op 查改动日志：已提交补 recovered 结果（带 change_ids），没提交补 interrupted，绝不重放（`agent/reconcile.ts`）。取消信号和 tool-call id 经 `bindAgentTools` 传到工具。
- 只读子任务 `delegate_research`（`agent/subagent.ts`）：最多 4 个独立核查并行，子任务只拿只读工具、最多 6 步、返回 {summary, findings, gaps}；一份失败其余照用；父 Run 中止向下传；写入只由父 Agent 做。
- 事务不嵌套（CoreStore 契约）：组合写入用 `saveRecordInTx` / `deleteRecordInTx`；SQLite 遇到嵌套直接报错，网页版所有事务严格排队（独立请求不再加入别人的事务、跟着回滚）。
- 改写简历：网页走 SSE（`POST /api/resume/{id}/tailor`），工具 tailor_resume 在 core 里消费同一个 `runTailor` 生成器，只回摘要。锁按目标岗位（同一主简历可并行给不同岗位改写）；保存时在事务里重读 JD 和目标简历，生成期间被改就不覆盖，error 事件带 conflict 和 draft。
- 系统提示词只有三件事：今天日期和 overview 摘要、工具说明、规则（不编造经历；对外的事只写草稿；长任务调用 handoff）。
- 工具说明渐进披露（`packages/core/src/tools/catalog.ts`，借 Flovart `workflow.node.tool.list`）：每轮只给模型一行简述（`TOOL_BRIEFS`）+ 去掉 title / 长描述的精简 schema（校验仍用工具表原 schema），系统提示里放分组工具索引；要完整字段和规则时模型调只读的 `tool_manual(names=[…])`，常用流程（`role.research` / `evidence.map` / `resume.tailor` / `interview.prepare`）用 `tool_manual(capability=…)` 取步骤，流程只是现有工具的调用顺序，不新增业务逻辑。HTTP 仍列完整说明；CLI 默认只列一行简述，`--help` 才给完整说明。
- 工具报错结构化（`packages/core/src/tools/preflight.ts`）：内置 Agent 拿到的失败一律是 `{ok:false, error:{code, message, retryable, suggestedAction}}`（code：invalid_args / invalid / not_found / conflict / forbidden / unsupported / unknown_tool / upstream_unavailable / aborted / internal；只有 upstream_unavailable 可重试），不再是 `ERROR: …` 文本。执行前先过 schema 校验和预检（引用的岗位 / 记录 / 改动是否存在、简历 id 是不是 resume、改动是否已撤销），预检失败不执行，回修复建议（比如最近几条可用的 id）。HTTP / CLI 的报错形状不变。
- Skill 渐进加载（`packages/core/src/agent/skills.ts`，借 Flovart `agentSkills.ts`）：系统提示只放通用规则（`CORE_RULES`）+ 技能索引；`interview-practice` / `role-research` / `resume-tailoring` / `job-evaluation` / `email-writing` 的方法按需用 `skill_read(id)` 读。用户这条消息或最近 6 条对话命中技能的触发词（如「模拟面试」「第 N 题」「调研」「简历」）时，该技能正文直接放进系统提示，经过评测的模拟面试 / 调研规则（DOGFOOD 2026-11-07，v4）原文搬过去、不改写。技能只是现有工具的用法，不新增业务逻辑。
- 流式可靠性（`packages/core/src/agent/stream-guard.ts`，借 Flovart 内核）：首包 90 秒、空闲 60 秒超时；**还没有任何输出时**遇到 408/429/5xx、网络错误或首包超时最多重试 2 次（间隔 1s、3s），每次重试记一条 `runtime.retry_started`；已经输出文字或工具调用后不重放（避免重复文字和重复写入），空闲超时直接让 Run 失败、可恢复。401/403 等不重试。
- 上下文压缩（`packages/core/src/agent/compaction.ts`，借 Flovart `agentCompaction.ts`，不调模型）：每轮请求前估算「系统提示 + 工具 + 会话」，超过「窗口 − 预留」时，把最近一段（keep-recent）之外的旧工具结果压成摘要——保留记录 / 岗位 / 文档 / 改动 id、错误、remaining / asks 等未完成标记、已确认记忆的正文，去掉网页正文、长 JD / 简历原文；用户目标、消息角色和 tool_call 配对不动。系统提示末尾追加引用清单（岗位 #、文档 #、已确认证据 #、本轮改动 #、未完成）。模型报上下文超长时更狠地压一次再重试本轮。记一条 `runtime.compaction_completed`；`status().features.compaction = true`。
- 上下文窗口（`packages/core/src/llm-context.ts`）：默认 256K（262144）。可在设置里全局配（`agent_context_window`，0 = 默认）或按服务配（`llm_api_configs[].context_window`，优先于全局），范围 4096–2097152，超出视为未配。实际窗口 = min(配置值或 256K, 模型已知上限)：上限表 `KNOWN_CONTEXT_LIMITS` 按去掉网关前缀、转小写后的模型 id 匹配，覆盖全部内置预设模型；未知模型直接用配置值，溢出时仍靠上面的「报超长 → 狠压一次重试」。压缩阈值随窗口按比例走（`compactionPolicyFor`）：预留 = 窗口 × 1/8、原样保留最近 = 窗口 × 1/4（即旧的 64k/8k/16k 比例；256K → 预留 32768、保留 65536，约 229K 开始压）。每个 Run 把实际用的 `context_window` 和 `max_steps` 记在 `llm_runtime`；`GET /api/agent/runtime/models` 每个模型多返回 `context_limit`（已知上限，未知为 null）和 `context_window`（按当前设置算出的实际窗口）。只改设置 JSON，不动 SQLite 表结构。
  - 实际效果（默认 256K 时）：上限 ≥ 256K 的模型拿满 256K——deepseek-v4-flash / v4-pro（1M）、gpt-4.1 / gpt-4.1-mini（1,047,576）、qwen-flash / qwen3.5-plus / qwen3.5-flash / qwen3.6-plus（1M）、gemini-2.5-flash / pro（1,048,576）、kimi-k2 / kimi-k2-turbo-preview（262,144）。被截到模型上限的：glm-5.1 / glm-4.6 → 200,000，anthropic/claude-3.5-sonnet → 200,000，DeepSeek-V3.2（SiliconFlow）→ 163,840，deepseek-chat / deepseek-reasoner（旧别名，保守）→ 131,072，Qwen3-32B / GLM-4.5（SiliconFlow）、llama-3.3-70b / llama-3.1-8b、llama3.1:8b → 131,072，gpt-4o / gpt-4o-mini、glm-4-plus → 128,000，moonshot-v1-32k、qwen2.5:7b → 32,768，gemma2:9b → 8,192。Ollama 实际可用窗口还受服务端 `num_ctx` 限制，比模型上限小时请在该服务上配 `context_window`。
- 岗位证据账（`packages/core/src/research/evidence-ledger.ts`，DOGFOOD 2026-11-09）：`buildJobEvidenceLedger(store, jobId)` 按需从已有数据拼出一张账——JD 要求（评估文档「逐条匹配」，没有评估时用 posting 的 hard_reqs / soft_reqs / responsibilities，标 jd_official / jd_community / evaluation 和来源链接）→ 对应记忆 id 和缺口；当前简历每条要点 → 支撑它的记忆（按标题或数字追溯，复用 resume/verify 的数字匹配）以及是否全部已确认；待问用户的问题（缺口、数字无出处、未确认记忆）；JD 摘要 sha256，并从改动日志判断 JD 是否在评估之后改过。不新建表、不落库。`validateTailoredResume` 在 tailor 校验阶段对比改写前后，输出 `checks.ledger`（只提示、不拦截）：`unconfirmed_claim`（新句子只能追到未确认记忆，或数字找不到出处）、`confirmed_dropped`（用户确认过的要点或其中的事实被删）、`self_score_as_achievement`（评估分 / 匹配度写成用户成果）、`jd_changed`（JD 在建账或评估之后改过，先重新 evaluate_jobs）。回归用例在 `backend-ts/test/evidence-ledger.test.ts` 和 `agent-bench.test.ts`，共用脱敏数据 `test/helpers/dogfood.ts`。
- 没配模型时，Ctrl+K 只做本地解析不了的提示：「先在设置里填模型，或者在 Codex 里说这句话」。

## 9. 后台 Codex 交接（PR5）

- `handoff(task, job_id?)` 在后台启动 `codex exec`，带上 OfferU Skill（命令行），工作目录在数据目录下的 `runs/<id>/`。
- 先验证能否无人值守：非交互模式、`offeru` 命令是否可用、沙箱是否允许访问 127.0.0.1。验证不过就退回「复制这段话到 Codex」。
- 进度只看两样：进程是否还在、它写了哪些 change。完成后今天页的最近改动里出现「codex：……」。
- 同时只跑一个后台任务。

## 10. 邮箱同步

- 工具只加一个 email_sync(action: status | sync, account?)。status 返回已连账号、上次同步时间和结果，不含凭据；sync 拉新邮件并回写，返回处理了哪几封、各写了哪些 change。
- 凭据和模型设置一样存在本机配置文件（Gmail 存 refresh token，IMAP 存 host / user / 授权码），不进 offeru.db、不进 changes、不出现在任何工具返回里。连接和断开在设置页完成。
- 拉取仍在 services/email_sync.py（账号、凭据、游标）；每封新信交给 core/mail.classify 和 core/mail.apply。不再写 application_progress 的候选进展和阶段事件，旧表只作历史数据保留。
- 识别：core/mail.classify 先跑关键词规则（rejected / offer / interview_hr / interview_2 / interview_1 / written_test / assessment / applied），配了模型时再调一次只给发件人、主题和正文前 6000 字的模型抽取机构和岗位；模型置信度 ≥0.7 时阶段以模型为准，规则永远保底。模型失败只降级为规则，不阻断同步。
- 回写在 core/mail.py 的 apply()，全部走 save()，actor=邮箱，直接写入、不进待确认，误判靠撤销：岗位按公司 + 岗位名匹配（没抽出公司时按唯一的同名岗位兜底），匹配不到新建并带上阶段；status 只前进不后退；时间写成 event（kind=test / interview / deadline，job_id 指向岗位，带 mail_stage），同一岗位同一阶段还没到的事项再来一封信就改期而不是重复新建。notes 存发件人、主题、链接。每条写入的 data 带 mail_id（Message-ID）。
- 去重：同步前查 records 和 changes（before / after）里出现过的 mail_id，处理过的跳过，所以撤销后下次同步不会写回来。
- 不做：发信、标已读、删信、保存原始邮件。
- services/email_sync.py 只管账号、凭据和游标，每封新信交给 core/mail.classify / apply 写入。旧 Operation Registry 里的候选进展操作（ingest_application_signal、list / review_application_progress 等）已下线，不再暴露给外置 Agent；旧候选表 application_progress_candidates 只剩历史数据，没有写入方，前端不展示，随 legacy 清理一起删表。邮箱同步已不再调用 ingest_application_signal。

### 10.1 云同步（S3 / R2）

- 引擎在 `packages/sync`（`@offeru/sync`，只用 fetch + WebCrypto，浏览器 / companion / Worker 共用），注入 CoreStore、BlobStore（S3 SigV4）和本机状态存储。格式、合并规则、威胁模型和 CORS 见 [sync.md](./sync.md)。
- 远端是 dejavu 式的内容寻址快照：objects（加密块，id = HMAC）、indexes（快照索引）、refs/latest（If-Match 比较交换）、lock（带过期）。只上传桶里没有的块。
- 合并以本机上次同步的快照为 base，逐条记录三方合并、字段级合并；真冲突按 updated_at 后写赢，输的版本存成一篇冲突文档；修改赢过并发删除。结果在一个事务里写回，每条一行 change（actor「同步」），可撤销。
- companion 路由 `GET /api/sync/status`、`POST /api/sync/{configure,now}`；设置 › 数据 › 云同步。凭据和口令只存在本机。

## 11. 前端

> **新增及迁移 UI 规范（唯一有效依据）**：[`docs/design/visual-system.md`](design/visual-system.md)，配套 Tokens 在 `frontend/src/styles/design-tokens.css`。组件规格见 [`docs/design/components.md`](design/components.md)，组件代码在 `frontend/src/components/ui/`（Radix Primitives + `--ou-*` Token）。2026-11-13 起全站旧变量已桥接到色卡 v2；本节描述与 v2 冲突时以 v2 为准。

- Vite + React + HashRouter，`lib/core.ts` 提供 `tool()`、`useTool()`（SWR）、`write()`（写完全局刷新）。页面只调工具，不调其他接口。
- 页面：今天 `/`、岗位 `/jobs`、岗位详情 `/jobs/:id`、简历 `/resume/:id?`、档案 `/profile`（和简历同一个导航项，两个标签）、面试 `/interview`、设置 `/settings`。
- 共用组件：EventList、RecentChanges、JobBoard（今天页投递看板，前端直接 list job 和未完成 event）、TagInput、ChatDoc（PR3）、CommandK（PR3）。简历编辑器：顶栏一行（简历名下拉切换 / 新建 / 改名 / 复制 / 删除 | 排版工具栏，数值是「输入 + 下拉常用值」 | 下载 PDF）；左侧结构化表单，正文是所见即所得编辑框（存轻量标记）；右侧中性浅灰画布上的 A4 预览（只用一层浅阴影托出纸面），悬停模块显示蓝色虚线框，点击定位左侧；第一页分页线是中性灰虚线。简历编辑器配色和岗位页同一套 Notion 式中性色：底色、文字、细线继承全局，卡片纯白、输入框浅灰、标题无衬线、卡片圆角 10px（--radius-card）；主操作（下载 PDF）用墨黑主按钮，和「添加岗位」同一种，报错统一用 --primary-red。对齐：顶栏和左栏内边距都是 0.75rem，左栏卡片左缘对齐顶栏内容，卡片顶对齐右侧画布顶部。
- 岗位页 /jobs 是多维表格（参考飞书多维表格，调研见 docs/design/jobs-table-research.md）：视图 tab 表格 / 看板 / 甘特；顶栏有搜索、筛选、分组、排序、字段显隐、行高、重置和添加岗位。评估未评估的岗位时走 `POST /api/jobs/evaluate`（SSE：start → job_start / job … → done），按钮显示「正在评估 3/7」；工具 evaluate_jobs 仍是同步调用，供 Agent 和命令行用。表格用 @tanstack/react-table，冻结公司列，悬停行出勾选框和「打开」，勾选后出批量栏，单元格直接改；「打开」进右侧详情抽屉（∧∨ 按当前顺序切换，Esc 关闭，失焦即存）。看板 tab 复用 JobBoard（embedded，不显示标题）。筛选 / 分组 / 排序是 lib/jobView.ts 里的纯函数；视图配置存 localStorage，自动保存。list 结果保留 created_at，给甘特当起点。甘特视图（components/jobs/JobsGantt.tsx，时间计算在 lib/jobGantt.ts，有单测）：左侧冻结岗位列（« / » 可折叠成窄边）、右侧时间轴，周 / 月两档缩放和「今天」按钮，竖红线标今天；条从收藏日画到最后一件事项（进行中的画到今天），颜色跟状态，已结束的变淡；条上菱形是截止 / 笔试 / 面试 / 待办，悬停出事项卡片（标题、类型、时间、备注），拖动按整天改 event.at（保留时刻），工具栏出「撤销」；条是推算的，不能拖。点行内空白处弹小表单，在那天给该岗位加事项（类型 + 标题，回车存、Esc 或失焦取消，表单夹在可视区内）。条整个在可视区外时行内贴边出 ← / →，点了滚到条起点。短条的文字画在条右边；网格按可视宽度往右补满；点条或岗位名打开详情抽屉；筛选 / 分组 / 排序用甘特视图自己的配置。看板列宽随窗口流动（`--ou-kanban-column`，16–22rem），放不下时在看板轨道内横向滚动、按列吸附。
- 岗位页视觉照 Notion 数据库：表格白底、无外框、无竖线、无行号，只留淡横线；组头「▸ 状态胶囊 数量」，组末「+ 新建」。状态和单选 / 标签是色卡 v2 浅色胶囊：浅底 + 深字 + 同色 1px 描边 + 小圆点；状态下拉按 待办 / 进行中 / 已完成 分组。顶栏是一排灰色图标（生效的变深并带计数），视图 tab 是浅灰圆角底，搜索点了才展开，最右墨黑主按钮「添加岗位」。看板列底 N3 中性色，颜色只留给列头胶囊；卡片是 L2（白底 + 1px 分隔线 + 小阴影，悬停抬起一级），列底「+ 新建」是灰字。甘特左列无竖线、网格更淡，条用状态色浅底，今天是细红线加表头小圆点。
- 视觉：色卡 v2（Minimal）：暖中性色阶为主、墨黑主按钮、橙色只表示紧急 / 委托、紫色只属于 Agent；字号和间距弹性适配（字号走 Token + clamp()，正文约 13–15px，间距 rem）；页面容器分 reading / default / wide 三种宽度，留白随视口流动；不用徽章、统计卡、彩色按钮、网格背景。状态六色：灰（想投、不投了）、蓝（已投递）、黄（笔试 / 测评）、橙（面试中）、绿（offer）、红（未通过）；单选 / 标签按文字哈希取九色之一，同一个值永远同一色。红色另用于截止和今天线。

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

### 11.2 ⌘K 命令面板：不只会搜，还能直接办事

参考 Apple HIG（键盘可达、平台修饰键符号、即时反馈、尊重减少动态效果 / 增强对比度）。实现：`components/workbench/CommandPalette.tsx`，数据模型和过滤是 `lib/commandPalette.ts` 的纯函数（有单测）。

- 两种模式，顶部分段控件切换，`Tab` 也能切：**搜索**（页面 + 「让 OfferU 办」动作）和 **问 OfferU**（输入即问题）。
- 搜索输入非空时，结果末尾永远兜底一条「问 OfferU：<输入>」，回车总有事可做。
- 选中动作或提问：通过 `composeToAgent` 交给右侧 Agent，立刻开一个 Run，右栏切到 OfferU；当前行图标变 ✓、提示变「已交给 OfferU」，约 420ms 后关闭（减少动态效果时立即关闭）。
- 键盘：`↑↓` 首尾循环、`↵` 执行、`Tab` 切模式、`Esc` 逐级返回（先清输入 → 回到搜索 → 关闭）；中文输入法选词时不响应回车。macOS 显示 `⌘K`，其他平台 `Ctrl K`（侧栏入口同步）。
- 无障碍：dialog + combobox/listbox/option，`aria-activedescendant` 跟随当前项，键盘移动时滚动到可视区。
- 视觉：一个浮起容器，14px 圆角，半透明白 + `saturate(180%) blur(24px)` 材质，多层柔和阴影；分组标题 L3，条目 L1/L3；不用彩色。
- Agent 工具步骤画成时间线：圆形节点 + 节点间细竖线 + 右侧 `n/N`，不画分隔线。
- 全局：键盘焦点统一 `:focus-visible` 2px 环；`prefers-contrast: more` 时边框和弱文字加深一档；选区和滚动条改用中性墨色，不再混入蓝灰。

## 12. 浏览器插件（PR4）：官网表单填写助手

只作用于飞书招聘、Moka、北森等公开官网的网申/招聘表单。BOSS 直聘、小红书等风控平台不做自动操作，只保留用户手动「存为岗位」。

### 12.1 页面交互

- content script 扫描当前页字段，Shadow DOM 覆盖层在每个控件旁显示灰色只读预览：「将填写：张三 · 档案」+「填入」；已有值时「将替换：李四 → 张三」；低置信度「待确认」；没有依据「档案里没有，点这里补充」。
- 点单项或「填写本页」才写入；批量条只做「填写本页 / 撤销」，不做提交。
- 提交、下一步、发送永远由用户点。密码、证件号、隐藏字段、文件上传不自动填。
- 覆盖层挂在 `all: initial` 的 Shadow DOM 宿主上，不往表单 DOM 插节点；用 `getBoundingClientRect` 定位，`scroll / resize / ResizeObserver` 更新，`IntersectionObserver` 只渲染可视区。

### 12.2 字段与标签

- 字段：input 的 text/search/email/url/tel、textarea、select、radio/checkbox、`contenteditable=true`；跳过 password/hidden/readOnly/disabled/file。
- 开放 shadow root 递归扫描；同源 iframe 注入，跨域 iframe 标「需手动」。
- 标签解析顺序：`label[for]` → 包裹 label → `aria-labelledby` → `aria-label` → placeholder → `name/id` → 最近的文本块；radio/checkbox 按组去重。
- 字段指纹用 label + name + DOM 路径，不用索引；MutationObserver、URL 变化、pageshow 触发 debounce 重扫。

### 12.3 plan / fill

- plan：只把字段描述（label / type / required / options / 当前值）发给本机后端，后端用 profile、已确认记忆和岗位定制简历生成 `{ref, value, source, confidence}`。确定性映射优先，模型只补歧义；不编造，没有依据进 `needs_user`。
- fill：React/Vue 受控组件用原型链原生 setter + `input/change`；`contenteditable` 用 `execCommand("insertText")`，失败再合成 paste；select/radio/checkbox 用原生 change/click。填完回读，不一致进 mismatch，不谎报成功。
- 每个字段记录 before/after 支持逐字段撤销；填写 session 只存在扩展本地，不写 offeru.db，除非用户点「记录这次投递」。

### 12.4 Agent 联动

- 扩展是唯一执行器；Agent 通过 `browser` 工具的 `snapshot / plan / fill / readback / undo` 调同一套消息，不另开 CDP 或 Playwright 路径。没有扩展时明确报错，不静默降级到脚本爬取。
- Agent 先 `plan` 把计划给用户看，用户批准后才 `fill`；UI 和 Agent 共用同一个 plan 实现。
- 站点适配沿用 smartfill-v2 的规则；飞书 / Moka / 北森的自定义组件走站点适配器，通用页 fallback。

### 12.5 安全边界

- 只发字段描述，不发整页 HTML；页面内容视为不可信输入，不把页面指令当提示词。
- 不自动提交网申、不自动点下一步；不对 BOSS / 小红书做自动操作或后台抓取。
- 参考沉浸式翻译的「就地可见、不打断操作」和 KISS Translator 的 Shadow DOM / 输入框回填 / 规则引擎；实现代码在 `extension/`，表单 plan 的后端接口只读 profile，不写库。

## 13. 桌面小球（第四期之后）

pywebview 小窗，随 `offeru start` 打开，轮询 overview；有新的改动或临近的日程时头像动一下；悬停展开今天的待办，可以勾掉。

## 14. 目录

见 [ARCHITECTURE §2](./ARCHITECTURE.md#2-代码在哪)。Python 后端已删除（tag `python-backend-final`）。

## 15. 测试策略

- 后端：`backend-ts/test/` 用 `createApp(deps).request()` 走完整 HTTP 管线，伴侣端到端测试起真实服务；每个工具 / 路由有一条契约用例（`test/fixtures/` 的期望最初由 Python 版生成）。
- 页面内后端：`frontend/src/lib/local/backend.test.ts` 在 jsdom 里跑同一个 app。
- 前端：vitest；改界面时用 Playwright 在干净数据目录下把主线点一遍并截图。
- 不写只为提高覆盖率的单元测试，不写防御性分支。命令见 [DEVELOPMENT](./DEVELOPMENT.md)。
