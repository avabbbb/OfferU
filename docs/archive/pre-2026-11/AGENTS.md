
# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。用户当前明确任务与更高优先级指令优先；在其范围内，本文件提供 OfferU 仓库级施工约束。遇到文档冲突时，不凭旧聊天或历史设计猜测，按下述“当前事实源”顺序裁决。

## 角色设定

已确定的产品定义直接实施，不重新发起定位或受众问卷。仅在答案会改变范围、不可逆行为、外部权限或实施路线时提出一个关键问题。常规编辑、验证、创建授权范围内的 PR 和收尾自主推进，不因准备结束回复而重复索要许可。会变化的宿主 API、SDK 与接入能力核验当前官方文档和真实源码；资料缺失或账号未验收明确标记。

你应该有高度的自主性，可以充分利用如下能力：
Playwright MCP 或Browser 来访问/截图/识别/探索网站的视觉和代码Context7 MCP 来查询某些技术文档(如果你需要使用到它们的话)动效丰富的部分，可以使用/web-shader-extractor进行分析
关于分析：这是个重大且复杂的工程，并且你上下文有限，你可以先进行整体分析，按模块进行顺序执行，每个模块任务的结果落盘分析文档到本地，这样即便上下文被压缩，后续也能够通过本地文档得到保证。分析思维你可以参考/duck

## 当前事实源与产品模型

当产品/架构文档冲突时，按以下顺序（2026-10 文档重构后只有三层）：

```text
docs/README.md + docs/01–09（唯一设计权威：总体、交互、各模块）
  ↓
live code / Registry / Host / generated Skill projections
  ↓
docs/evidence/ 下与当前 commit 对应的验收证据
```

发现文档与代码不一致时，在同一个 PR 里修正其中一方。`docs/archive/**`、旧 dated report、旧 harness/DSH/Pi 方案只作历史证据，不得覆盖当前 authority。文档总数不超过 10 篇，维护规则见 `docs/README.md`。

当前必须保持的产品模型：

- **App-first 是普通用户默认入口**：安装并打开 Desktop → 建立 Profile → 保存 Job → canonical Job Workspace / Today。用户自带通用 Agent 是核心模式，同时覆盖 Coding 与消费级 Agent；Desktop 通过宿主适配发现、安装/更新 runtime-bound Skill 与正式工具连接，以真实只读回读验证。Agent 接入不阻塞首次职业价值；普通用户不复制连接 Prompt、不手工安装 Skill、不启动 Python/Vite/FastAPI 或源码环境。消费级 Agent 仅使用官方开放且实际验收的 Connector/Remote MCP，未支持的能力如实标记。内置 Agent 可以操作同一 Registry、辅助定制简历，作为备用或用户明确选择的推理主体；一个 Run 只有一个推理主体。
- **Skill-first 是高级用户入口**：用户可从 Codex / Claude Code / WorkBuddy / OpenCode / OMP / Pi 等支持宿主直接调用 OfferU Skill，但最终必须解析或创建同一个 canonical Job / Application 状态。
- **Skill 是 Agent entry，不是第二套产品状态**；不得创建 Agent-only Job、隐藏 workspace、重复 Profile 或平行 Application state。
- **Job / Opportunity 是持久 Job Workspace**：Job Snapshot、Role Intelligence、Evidence Map、Application Materials、Interview、Timeline / Next Action 都属于同一机会工作区。
- Agent 长任务结果必须逐步物化为 OfferU 可见状态（completed / needs review / blocked / failed / next action），不得只留在聊天文本里。
- **Career Runtime 是 Truth authority**，Operation Registry 是 execution/permission authority，当前 active Agent 是 reasoning authority；Today / Pipeline / UI 只投影同一份 Career Truth。
- 对外产品叙事优先使用“一个 Job → 岗位要求 × 可验证证据 → evidence-backed Job Workspace”，Career OS 与三权分立是第二层解释，不应成为普通用户的理解前置条件。

## Proactive Career Director 施工约束

涉及“主动 Agent / 自主求职 / Daily / Weekly / Profile 挖潜 / 面试提醒 / 自动投递策略”的实现，必须先读 `docs/08-module-agent-runtime.md` §8 与 `docs/02-interaction-design.md` §4，并遵守：

- **不得新增第二个无限 Agent Loop**。唯一自动化骨架仍是 `AutomationEvent → AutomationRule → CareerTask → Agent/Runtime → Operation`；Career Director 只能在明确事件/日程/状态变化触发时做一次有界判断。
- **Runtime 决定何时唤醒，模型决定当前什么最重要，Operation Registry/Policy 决定什么能执行**。不要把职业判断硬编码成脚本，也不要把权限交给模型。
- 安装、migration、health check、Agent detection 可以用 deterministic script；“用户属于什么求职阶段、Profile 缺什么、今天先做什么、是否值得重新联系旧岗位、面试后该复盘什么”等职业判断必须来自真实 Agent + OfferU Career State / tools，不得用 scripted executor 冒充 Agent。
- Profile “完整度”必须**目标相关**：区分 strong / weak / missing / unknown / under-expressed evidence，不实现没有决策意义的通用百分比分数。
- 至少区分 `campus_search` 与 `experienced_search` Strategy Pack。求职阶段优先根据毕业时间、全职经验、当前就业状态、目标 seniority 等职业证据推断，并允许用户纠正；不得根据年龄等敏感或无关属性猜测。
- 校招侧默认关注探索、招聘窗口、漏斗转化、有限经历中的 Potential Discovery；社招侧默认关注 Market Position、ownership/impact、流程节奏、re-engagement、薪酬/level/谈判。不要把一套固定投递量或通用 Prompt 套给所有用户。
- Proactive 输出必须结构化并物化到 Today / Automation Inbox / CareerTask / Proposal；不得只存在于聊天回复。
- 自主等级必须保持：L0 Observe 可自动；L1 Prepare 可在有界范围自动准备；L2 Career Truth commit 走 Proposal/HITL；L3 外部 submit/send/contact 默认明确用户批准。Career Director 永远不能自行升级权限。
- `DAILY_REVIEW` / `WEEKLY_REVIEW` 是职业状态重新判断触发器，不只是静态 Todo 汇总；建议必须包含 `why_now`，被拒绝/长期忽略的建议必须衰减或改变，不能日复一日重复骚扰。
- 面试邀请、临近面试、面试结束应形成 Prep / Debrief 主动链；Resume materially updated 时只生成有去重/时间窗/未明确拒绝约束的 re-engagement candidates，不自动发消息。
- Job Search Campaign 可以自动发现/去重/评估/准备；未来若开放自动外部动作，必须另外具备显式 opt-in、connector 支持、bounded scope、rate limit、dedupe、audit、pause/kill switch。解决反爬不等于获得自动提交/重复联系权限。
- 第一实现切片限定为：First-run Profile Discovery、Daily Career Brief、Job-saved Assessment Plan、Interview Prep/Debrief、Resume-updated Re-engagement Review。不要一次把所有 AutomationEvent 都接成 Agent。
- 验收关注主动性质量而不是 automation 数量：user-directed task rate、proactive acceptance、useful-first-action、重复/过期建议、用户纠正率，以及 0 次 self-confirm / unreviewed truth write / unauthorized external action。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- OfferU 已进入 Public Release 准备路径，**不得再假设旧数据可以直接丢弃**。涉及 schema / persistence / version 的变更必须按 `docs/09-quality-and-release.md` 的 migration、backup/restore、upgrade 规则处理；只有明确标记为开发 fixture/demo 的数据才能按任务要求 reset。
- 修改代码后必须做与改动范围匹配的验证，并如实报告：后端至少运行相关 pytest；前端改动至少 typecheck + 相关 test，影响构建/路由/依赖时再跑 production build；跨层、release/security/migration 变更按 `docs/09-quality-and-release.md` / CI 对应 gate 扩大验证。文档-only 改动不要求无意义地跑全量构建。**未运行或失败的检查必须明确写出，绝不把“看起来没问题”当 PASS。**
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。
- **前端 dev 端口固定 7410，后端固定 8766**：两个端口均避开 AI/框架常用端口（3000/3300/5173/8000/8080/11434 等）与当前 winnat 动态排除段。winnat 排除段会漂移（曾见 2942-3041，后又出现 4229-4328，4321 因此 EACCES），改端口前必须先执行 `netsh interface ipv4 show excludedportrange protocol=tcp` 确认不在任何段内。改前端端口必须同步 `frontend/package.json` 的 `scripts.dev` / `scripts.start`、`frontend/vite.config.ts`（含 TAURI HMR 端口 7411）、`frontend/src-tauri/tauri.conf.json` 的 `devUrl`、`backend/app/config.py` 默认 CORS、`backend/app/routes/email.py`、`backend/app/routes/resume.py` 的 `FRONTEND_BASE_URL`、`.env.example` 与 `backend/.env`；`frontendDist` 必须继续指向静态目录 `../dist`，不能改成 localhost URL。
- **系统环境变量 `CORS_ORIGINS` 会覆盖 `backend/.env`**：本机 Windows 用户环境变量里存在 `CORS_ORIGINS`（旧值仅 5140/3000），pydantic-settings 环境变量优先级高于 .env，导致 .env 的 CORS 修改不生效、前端（7410）请求后端被拦。出现「浏览器 Failed to fetch / CORS blocked」时先查 `env | grep CORS` 与 `setx CORS_ORIGINS`（含 `http://localhost:7410,http://127.0.0.1:7410`），再改 .env。
- **WorkBuddy 桌面会话变量会污染本地执行器子进程**：在 WorkBuddy 内启动 OfferU 时，桌面版会向进程树注入 `CODEBUDDY_MCP_CONFIG`（指向 `127.0.0.1:12874` 的 MCP 代理）、`CODEBUDDY_GATEWAY_*`（网关口令）、`CODEBUDDY_CONVERSATION_*`、`CODEBUDDY_HOST`、`CODEBUDDY_PROJECT_DIR` 等会话级变量。CodeBuddy Code CLI 继承后会转而连接桌面版网关，卡在启动阶段：**零事件输出（连 `system/init` 都没有），最终表现为 worker 超时**。`coding_agent_runtime._child_environment()` 因此对 `codebuddy` 只放行最小白名单（保留 `CODEBUDDY_CONFIG_DIR` 供 CLI 定位自身凭据）；**不要改回 `dict(os.environ)`，只剔除 `CODEBUDDY_*` 前缀的黑名单同样无效**。复现命令：`python -m app.cli conformance --provider codebuddy --live codebuddy`。
- **本地 CLI 能力探测超时不得低于 20 秒**：`_probe()` 会并发探测全部 provider，Node CLI 冷启动在 5 秒内跑不完 `--version`/`--help`；`_capture()` 的 `TimeoutError` 会被 `except ...: pass` 静默吞掉，导致 codex/opencode/pi/omp/codebuddy 被批量误判为 `incompatible` 且没有任何报错，而 CLI 手动执行完全正常。
- **`Settings.model_config["env_file"]` 必须是绝对路径**：仓库根还有一份历史 `.env`（含 `DATABASE_URL=sqlite+aiosqlite:///./offeru.db`）。若把 `env_file` 改回相对的 `".env"`，任何在仓库根运行 CLI 的外部 Agent 都会**静默连到空的 `./offeru.db`**（2MB）而不是 `backend/djm.db`（110MB），读到空数据却毫无报错。`config.py` 已改用 `runtime_env_file()`，不要回退。
- **前端是 hash 路由，且 Agent context 有两个写入者**：页面 URL 形如 `http://127.0.0.1:7410/#/jobs/458`，直接访问 `http://127.0.0.1:7410/jobs/458` 会被重定向到首页，导致 `entity_id` 为空、误判为上下文丢失。context 写入者有两个：`providers.tsx` 的 `AgentContextReporter`（按路由推导 entity）与 `agentConnection.tsx`（按 selection，为空就写空实体）。二者规则必须一致（`agentConnection` 已加 `entityFromRoute()` fallback），否则后者会把前者的 `entity_id` 覆盖成空。
- **浏览器验收必须无头且隔离**：Playwright 只允许使用 managed Chromium 的 `headless=true`；禁止调用系统 Edge、默认浏览器或任何 `headless=false` 调试脚本。OfferU 网页只使用 `http://127.0.0.1:7410`，`8080` 仅是可选本地 llama.cpp Provider endpoint，不是网页地址；发现脚本试图打开可见浏览器或访问 8080 时，先停止并修正。
- **Public Release E2E 地址必须 fail-closed**：`backend/scripts/e2e/test_public_release_*.py` 的网页/API 地址统一通过 `backend/scripts/e2e/release_endpoints.py` 解析；禁止直接拼接 `OFFERU_E2E_BASE_URL`/`OFFERU_E2E_API_URL`。解析器只接受 `http://127.0.0.1:7410` 和 `http://127.0.0.1:8766`，任何 `8080`、其它端口、外部主机或带 credentials/path/query 的值必须在网络请求或 Playwright 导航前报错。
- **日常诊断不得打开浏览器窗口**：启动、端口/CORS/Provider 排障和代码检查默认只使用 HTTP/进程/日志证据，不调用 Edge、系统默认浏览器、`Start-Process`、`window.open` 或浏览器扩展的网页导航。只有用户明确要求进行网页验收时，才允许使用隔离的 managed Chromium 无头流程；产品里的 `chrome.tabs.create` 只能由真实用户点击触发，不能作为 Agent 的诊断手段。
- **网页导航必须先确认服务就绪**：扩展或其它用户入口在创建 `7410` 网页标签前，必须使用有界超时检查 `http://127.0.0.1:7410`；检查失败、超时或返回错误时只显示提示，不创建浏览器标签。后端 `8766` 和模型 `8080` 永远不能作为网页导航目标。
- **扩展验收同样不得选系统浏览器**：`extension/scripts/` 下的 fixture、smoke 和 E2E 脚本必须使用 Playwright 自带的 managed Chromium、临时隔离 profile 与 `headless: true`；不得扫描或传入 Chrome/Edge 可执行文件路径。
- **仓库内所有自动浏览器脚本都遵守同一边界**：包括根目录临时/历史脚本；统一使用 Playwright managed Chromium 与 `headless: true`，不得保留系统 Chrome/Edge 的 `executablePath`、channel 或可见窗口入口。用户主动触发的授权登录窗口是唯一例外，且不属于自动验收。
- **测试临时空间固定使用 H 盘**：Agent、浏览器、后端、前端和扩展测试产生的工作目录、缓存、隔离 profile、日志与截图统一放到 `H:\tmp\offeru` 或其子目录；不得把测试临时目录写入 C 盘。已安装的 Agent 可执行文件及其原生认证目录只读使用，不搬迁、不清理用户凭据。
- **Agent-native 产品验收不得用 Playwright 代替 Agent 操作**：当验收目标是“本地 Coding Agent 使用 OfferU”时，Coding Agent 必须通过 OfferU Skill → CLI/Bridge → Operation Registry 操作业务能力；Playwright 只能作为独立的前端回归测试，不得充当 Agent。用户可以自行打开可见 OfferU 前端作为观察、编辑和 HITL 确认界面，这不属于自动浏览器验收，也不受 `headless=true` 限制。
- **禁止 scripted executor 冒充 Agent**：预先根据 prompt 关键字写死 Operation 序列的 deterministic executor 只能标为 workflow/smoke，不得标记为 OMP/SWE-2 Agent E2E；Agent E2E 必须保留可验证的模型身份和 model-issued tool calls。

## Agent skills

### Issue tracker

Issues 和 PRD 使用当前 Git remote 对应的 GitHub Issues，统一用 `gh` CLI（`gh issue create --body-file`、`gh issue view <n> --comments`、`gh issue list`、`gh issue comment`、`gh issue edit --add-label`、`gh issue close`）。多行正文用临时 body 文件。Pull Request 只承载代码评审，不进入需求分诊。

### Triage labels

每个 Issue 使用一个状态标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。不创建同义标签；状态变化由证据或明确决策驱动。`ready-for-agent` 任务至少写明：用户可见结果、允许修改的范围、相关术语（`docs/01-overall-design.md` §10）、现状证据、验收映射、明确不做的事。

### Domain docs

领域术语与不变量见 `docs/01-overall-design.md`；交互规则见 `docs/02-interaction-design.md`；各模块规则见 `docs/03`–`docs/08`。新概念若是实际领域缺口，先补对应文档，不新建 ADR 文件。

## 实现 Agent 准则

- 实现阶段先按“当前事实源”读取 `docs/01-overall-design.md`、`docs/02-interaction-design.md`，再按任务读取对应模块文档与 live code。评审意见、聊天总结、历史报告与当前 authority 冲突时，以当前 authority + live code/evidence 为准。
- 一次只实现一个边界明确、可独立验收的纵向切片。不要同时铺开多个模块，也不要把数据库、API、前端分别做成长期未闭环的横向工程。
- 实现 Agent 负责落地，不重新进行产品问卷或自行新增架构。只有遇到 ADR 冲突、必须扩大文件范围、会改变领域模型或需要新外部权限时，才停止并提出一个阻塞问题。
- 开工前先读取与任务直接相关的代码和文档，用不超过 10 行复述目标、修改范围和验收映射；没有真实阻塞时立即实施。
- 修改范围由当前任务目标决定，不要求用户预先枚举每个文件。Agent 可修改完成该纵向切片**直接必要**的相邻文件与测试，但不得借机做无关重构、历史清理或创建无关 ADR/PRD/Issue；若必须扩大到新的领域边界或外部权限，再提出阻塞问题。
- GUI、CLI、TUI、斜杠 Skill 和本地 Coding Agent 都必须通过同一 Operation Registry；不得复制业务逻辑、直接写数据库、执行隐藏 shell 或绕过 dry-run、确认、审计和数据授权。**Skill-first 与 App-first 的结果必须落到同一 canonical Job Workspace / Profile / Pipeline。**
- 本地 Coding Agent 只承担可审计重任务。CLI 参数和能力必须通过 capability probe 判断，不能把某个 Codex、Claude 或其他 CLI 版本的 argv 永久写死。
- Agent 推断、面试反馈、简历建议和投递信号不能直接成为职业事实；必须遵循学习观察、事实门、候选进展和使用者确认规则。
- 当前产品仅为本地单人版；不要引入 SaaS、多租户、`workspace_id`、组织、计费、登录或为未来需求预埋兼容层。
- 保持最小实现，优先复用成熟库和现有结构。不得用固定假分、伪造 JSON、静默降级或“返回成功但实际未执行”掩盖失败。
- 完成后按“修改文件、验收映射、已执行检查及结果、未执行检查、剩余风险”报告。能在当前环境执行的相关自动检查应由 Agent 自己执行；只有环境/凭据/平台限制导致无法运行时，才把命令留给用户，并说明原因。

### 复杂迁移与多代理交付约束

以下规则来自 Proposal v2 施工中的返工与交付延迟，适用于跨持久化、授权、Agent 和 UI 的迁移。它们规定施工顺序，不减少用户已授权的最终范围，也不降低 `docs/09-quality-and-release.md` 的安全、迁移与发布要求。

- **首个集成门必须是完整业务链路**：开工时在已有任务文档中明确最小切片、完成断言和交付位置。涉及审批时，首切片至少包含提案准备 → 实际界面展示 → 独立授权 → Registry 执行 → 持久状态与 Audit/Receipt → 原 Run 续跑 → 重启回读。必要的授权、防重与恢复随切片一起实现；首切片未闭环前，不铺开其他业务域、通用效果框架或无关兼容层。模拟批准只能证明自动回归；真人边界按实际条件另记。
- **尽早验证整个任务，不只验证第一个动作**：实现最小生产接缝后立即运行跨层用例，集成失败先修复再扩大范围。多组 Plan 必须从第一组跑到最后一组，并断言真实持久结果、批准次数、逐节点 Audit、重复请求及续跑；必须覆盖前组修改来源版本后后组的行为。仅有分组数量正确、首组成功或单模块测试通过，不能称整份 Plan 可用。失败保留最小复现，禁止放宽摘要、版本或权限校验来换取绿灯。
- **先核对既有业务语义，再决定新增抽象**：修改执行边界前，逐项核对当前 Registry 的 schema、L1/L2 分类、确认要求、幂等和实际提交方式，不能根据名称或旧聊天假设某操作需要批准。效果核验先覆盖首切片使用的确切操作；异步、批量 DML、文件和外部效果分别列明支持状态。返回 `ok` 不等于提交证据，普通异常也不等于没有副作用；未覆盖的动作必须明确受限，不能静默放行或伪装整体迁移完成。
- **并行前冻结最小共同契约**：仅在任务允许并行时委派。在已有设计文档中写清共享 DTO/字段、状态转换、版本与摘要、授权/效果/尝试身份、Receipt 与 continuation 接口，并指定唯一维护者。先做最小跨模块契约检查，再派发独占文件；子代理不得自行改共享 schema 或重试语义。契约变化由主代理统一修订并通知所有依赖方，禁止复制出多套状态枚举或接口解释。
- **子代理交付与主代理集成分开验收**：使用隔离工作树或等价隔离；主代理记录文件所有权、依赖和集成顺序。子代理交付包含 commit SHA、改动文件、已执行/未执行检查和遗留风险，不夹带其他代理或复制来的依赖修改。主代理收到一个可集成工作包就审查并运行其直接依赖检查，不等全部模块写完才首次集成；子代理的“完成”消息不构成集成 PASS。全量测试、构建及大量缓存生成由主代理协调，避免并发争抢资源。
- **宿主限制改变调度，不能导致实现失控**：记录宿主实际并发限制、请求的模型以及可核验身份；额度中断时保存已完成提交、未提交差异和未完成清单。优先集成已有切片、恢复原文件 owner 的返修；主代理接手必须说明具体文件和原因，不能同时重写多个模块或偷偷替换用户指定模型。仍可安全推进的工作自主继续；真实模型/权限选择冲突才询问用户。
- **连续返修必须重新定位卡点**：同一卡点连续两轮返修仍未解决，立即记录最小失败用例、当前证据、已排除原因、影响范围和下一步验证，并向用户报告；先排查共同契约、实际事务和权威路径，避免连续添加特判。修复失败原因后再做针对性复测；已通过且未受后续修改影响的检查不反复运行。必要的最终集成、安全和发布检查不得省略。
- **构建前核对资源与测试身份**：大型构建或浏览器安装前检查 H 盘可用空间、构建产物预期和并发进程，资源不足先调整当前任务调度，不清理用户数据或凭据。记录命令、工作目录、源码版本及未提交差异；优先使用项目已有工具，避免在错误目录自动下载同名工具。SQLite fixture 必须显式关闭连接和句柄；端口与浏览器继续遵守本文件现有边界。
- **每个集成门都要形成可交付结果**：首切片通过其适用检查后，及时提供可审查差异及明确的合回步骤；在已授权范围内安全合回，不因无关失败长期滞留隔离目录。合回前比较原工作区当前内容与开工快照，保留后续用户改动；不得合入包含用户改动的整份基线快照。阶段性交付不代表整体完成：仍需继续覆盖剩余授权范围，不能用切片通过替代完整迁移验收。
- **进度必须说明用户现在能用什么**：每个集成门、实质阻塞或交付路径变化时，明确代码在哪个目录/分支、是否已合回原项目、运行的 App/安装包是否包含最新代码、下一项可验证结果是什么。分别报告隔离实现、自动集成、原项目交付、真人 Desktop 和安装升级状态；旧版本测试与构建不得作为最新版本证据。未到人工边界时，不得把延迟归因于等待用户批准，也不能用文件数、提交数或累计测试数量代替交付结果。

### 阻塞处理与真实内测节奏

以下规则适用于所有功能实施，目的是避免长时间排障却没有可用交付；不降低必需验收门，也不缩减用户已授权的目标。

- **先区分失败归属**：每次失败先标明产品错误、验证脚本错误、环境/凭据限制或证据不足。保留确切命令、工作目录、源码/验收物身份和最小失败证据；脚本用错 API、字段或 Run 时先修脚本，不把它算产品失败或修改产品迎合脚本。
- **同一阻塞最多三条独立路径**：每条必须包含假设、新证据、修改与复测。没有新证据时禁止重复同一命令、无限重启/找临时文件、不断延长 timeout 或反复同一 workaround。三条仍未解决则记录 BLOCKED 子项、尝试、最可信原因、影响范围与解锁条件，立即继续不依赖它的工作；单点失败不得自动暂停整个 Goal。
- **未确认历史故障不能无限扩大门槛**：历史错误无法复现或退出证据缺失时明确保留残余风险，不能宣称已经修复；当前正式验收物通过的项目按实际范围记账。必需 gate 未通过仍不能记 PASS，但不得让历史未知项阻断已获授权、无依赖的业务实现与内测，也不得自行跳过安全边界。
- **先验证验收脚本，再跑完整批次**：先用最小案例核对实际 API 路由、响应层级、Run ID、runtime/provider 与 session 状态；不能把 created/starting、对象存在或另一个竞争 Run 当成模型执行证据。隔离 Career DB 与 WebView/浏览器缓存并回读真实路径；记录启动、就绪、退出、PID/端口和安全脱敏错误证据，保留首个失败现场。
- **代码、验收物与报告必须对得上**：每个切片记录 HEAD/分支、未提交差异、数据根与验收物 hash。多工作树不得只报一个 HEAD 或混用成果；安装包是否包含修改必须由 build identity 验证。相关修改完成后统一构建和验收；仅在新改动、新失败、覆盖不足或必需发布 gate 时扩大/重复检查，不反复跑未受影响的绿测。
- **按真实用户结果收尾**：每个能力分开记录 Source/code exists、Product path reachable、Real owner acceptance；源码/单测/fixture 成功不等于真人 PASS，S0 启停/reset 通过不等于 Profile/BOSS/Interview 闭环完成。首条可用链路应及时接真实 Provider、获授权的真实输入和 Desktop 审核，按原范围持续补齐，不能只交文档、组件、测试数或“以后可以接上”。
- **缺输入不等于停止施工**：先完成不依赖输入的工作，到实际依赖时一次 Ask 缺失项；已有地址、授权和偏好不重复确认，密钥只走正式 vault 配置。仅在凭据/真实数据授权、账号登录/验证码、真实发送/提交、破坏用户数据或无法推断的产品偏好处要求人工；普通工程选择自主决定，额度受限按已有多代理交付规则调整调度。

### 本地分支预算与归档

- **分支 Guard 优先服务开发速度，真人验收才 fail-closed**：开始一轮开发前运行 `python backend/scripts/dev/branch_guard.py --mode start`；集成 worker 前运行 `--mode integrate`；任何真人/Desktop/安装包验收前必须运行 `--mode owner-test`。start / integrate / pr 模式下，落后 main、dirty worktree、命名分支超预算只输出 warning，不阻止施工；只有 owner-test 要求最新 baseline、clean worktree 与精确运行物身份。详细规则以 `backend/scripts/dev/branch_guard.py` 为准。
- **子代理默认只用 detached worktree，不创建永久 worker 分支**：主代理先记录唯一 integration baseline SHA，再用 `git worktree add --detach <H:/tmp/offeru/...> <integration-sha>` 隔离；子代理提交后返回 commit SHA，由主代理尽早审查并合入唯一集成分支。不得为 Luna/review/fix/experiment 每项工作长期新增命名分支。
- **真人测试必须证明“源码身份”和“运行物身份”一致**：`--mode owner-test` 输出 HEAD、origin/main、ahead/behind、dirty、branch/worktree 数；启动 Desktop/后端后再用 `--runtime-health-url http://127.0.0.1:8766/api/health` 核对运行时 `build_identity.commit == HEAD`。源码已更新但实际运行旧 EXE/sidecar/DMG 时，测试结果一律不能算当前版本验收。
- **PR freshness 是提醒，不是开发闸门**：`.github/workflows/branch-freshness.yml` 从 PR 实际 head 检查当前 base 是否为其祖先；落后 main 时提示尽快同步，但不阻止继续开发或创建 PR。进入 owner-test / release 前必须同步到当前 main。
- **本地三条分支是建议预算，不是硬限制**：通常保留 `main`、当前开发分支、当前集成分支；并行施工需要更多命名分支时可以继续，不得因为数量本身中断开发。仍优先用 detached worktree，任务完成后再归档/清理。
- **减少分支不等于合并所有功能**：已合并内容与 cherry-pick 后的等价修改核对后收尾；未验收内容列入待集成清单，不能为了数量目标混进 main。移除含独有提交的分支前，必须生成并验证可恢复 Git bundle、保存原分支 SHA 和工作树状态；有未提交改动的 worktree 保留目录及文件，不 force-remove、不 reset。归档不计为功能完成。
- **归档必须能实际恢复**：持久归档放在仓库 Git common directory 的 `archives/`，不能只有临时目录中的单份备份；在隔离目录恢复并比对原 SHA，记录恢复命令。远端分支和开放 PR 单独核对，未获授权不删除或改写远端。当前清单与恢复步骤见 `docs/agents/branch-consolidation-20261005.md`。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 项目注意事项

- **配置文件路径统一走 `llm_config_store.config_file_path()`**：该函数每次调用 `runtime_config_file()` 运行期现取（跟随 `OFFERU_DATA_DIR`），`app/routes/config.py` 与 `app/llm_config_store.py` 不再有模块级 `_CONFIG_FILE` 副本。测试隔离用 `patch("app.llm_config_store.runtime_config_file", return_value=...)` 或 `OFFERU_DATA_DIR` 环境变量，一处生效两处覆盖；不要重新引入模块级路径常量。
- **清理钥匙串时只能删自己写过的 ref**：不要按 `legacy_ref(...)` / `config_ref(...)` 这类固定 ref 批量删除。用户真实 LLM 凭据就存放在 `llm/legacy/*` 与 `llm/config/*` 下，误删会直接让用户丢失 API Key。测试用 fake vault（`unittest.mock.patch` credential_store 的同步函数），不要碰真实钥匙串。
- **API Key 只进钥匙串**：`config.json` 只允许出现 `credential_ref` 和 `env:VAR_NAME` 引用。写入钥匙串失败必须 fail-closed（`VaultUnavailableError`），绝不回退为明文落盘；读取失败不阻断启动，但必须经 `/api/config` 的 `vault_status` 暴露给用户。新增任何会写 config.json 的入口，都要经过 `llm_secret_vault.dehydrate()`。


## 安全回归红线（2026-09-23 加固基线）

这部分来自最新 critical/high/medium/low 修复后的稳定约束。后续改动不得为了“方便”退回旧行为：

- 新增或修改远程 URL / model endpoint / fetch 路径时，必须复用当前 SSRF / scheme / host 校验与 SSL 验证边界；不得关闭证书验证，不得自行放宽到 loopback/private/metadata 等高风险目标。
- 上传文件、PDF/HTML 渲染、导出与本地文件访问必须保持 filename/path canonicalization 与边界校验，禁止重新引入路径穿越。
- 富文本/模板输出继续使用当前安全 sanitizer / sandbox 机制；不得用正则清 HTML 或把用户内容拼入可执行 JS/template。
- 发往外部模型的 cover letter、interview prep 等包含个人信息的内容必须保持 desensitize → model → restore 边界；不得把 PII 明文上送作为“临时简化”。
- API/Bridge/Operation 入口不得移除现有鉴权与权限边界；本地部署也不等于所有 endpoint 可以匿名写。
- config、Agent run、resume/application workspace 等并发写路径必须保留当前锁、事务、idempotency / version 检查；不要用“单用户所以不会并发”作为删除并发保护的理由。
- Secret 永远不进 repo、日志、前端持久状态或明文 config；继续遵循本文件的 keyring / credential_ref 规则。
