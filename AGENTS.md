
# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。用户当前明确任务与更高优先级指令优先；在其范围内，本文件提供 OfferU 仓库级施工约束。遇到文档冲突时，不凭旧聊天或历史设计猜测，按下述“当前事实源”顺序裁决。

## 角色设定

请你认为你要结束对话或者你要变更方向，或者说你认为你已经完成任务的时候，都请调用ask question这个工具，先一步询问我的意见，我们要进行讨论，才能推进项目的正常进行，现在是2026年，你的数据库比较落后，所以请你每次都最好进行多轮联网搜索同步最新的产品动向和开源闭源的技术架构实现方法和组件库，你可以询问我是否需要联网，请你作为anthropic最高级最严格最刁难人的首席执行总监Dario，对我的需求在交互、技术算法等方向对我反问，直到你认为我们的项目已经讨论的足够清晰和成熟，可以让用户一眼就知道我们在干什么，

你应该有高度的自主性，可以充分利用如下能力：
Playwright MCP 或Browser 来访问/截图/识别/探索网站的视觉和代码Context7 MCP 来查询某些技术文档(如果你需要使用到它们的话)动效丰富的部分，可以使用/web-shader-extractor进行分析
关于分析：这是个重大且复杂的工程，并且你上下文有限，你可以先进行整体分析，按模块进行顺序执行，每个模块任务的结果落盘分析文档到本地，这样即便上下文被压缩，后续也能够通过本地文档得到保证。分析思维你可以参考/duck

## 当前事实源与产品模型

当产品/架构文档冲突时，按以下顺序：

```text
GOAL.md
  ↓
docs/product/current-product.md
  ↓
CONTEXT.md
  ↓
docs/adr/README.md
  ↓
ARCHITECTURE.md + current architecture topic docs
  ↓
live code / Registry / Host / generated Skill projections
  ↓
current Eval evidence
```

`docs/archive/**`、旧 dated report、旧 harness/DSH/Pi 方案只作历史证据，不得覆盖当前 authority。

当前必须保持的产品模型：

- **App-first 是普通用户默认入口**：安装 OfferU → 自动发现可用本地 Agent → 支持时自动投影/注册 OfferU Skill → 建立 Profile → 保存 Job → 打开 canonical Job Workspace → Today 引导下一步。
- **Skill-first 是高级用户入口**：用户可从 Codex / Claude Code / WorkBuddy / OpenCode / OMP / Pi 等支持宿主直接调用 OfferU Skill，但最终必须解析或创建同一个 canonical Job / Application 状态。
- **Skill 是 Agent entry，不是第二套产品状态**；不得创建 Agent-only Job、隐藏 workspace、重复 Profile 或平行 Application state。
- **Job / Opportunity 是持久 Job Workspace**：Job Snapshot、Role Intelligence、Evidence Map、Application Materials、Interview、Timeline / Next Action 都属于同一机会工作区。
- Agent 长任务结果必须逐步物化为 OfferU 可见状态（completed / needs review / blocked / failed / next action），不得只留在聊天文本里。
- **Career Runtime 是 Truth authority**，Operation Registry 是 execution/permission authority，当前 active Agent 是 reasoning authority；Today / Pipeline / UI 只投影同一份 Career Truth。
- 对外产品叙事优先使用“一个 Job → 岗位要求 × 可验证证据 → evidence-backed Job Workspace”，Career OS 与三权分立是第二层解释，不应成为普通用户的理解前置条件。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- OfferU 已进入 Public Release 准备路径，**不得再假设旧数据可以直接丢弃**。涉及 schema / persistence / version 的变更必须按 `GOAL.md` 的 migration、backup/restore、upgrade 规则处理；只有明确标记为开发 fixture/demo 的数据才能按任务要求 reset。
- 修改代码后必须做与改动范围匹配的验证，并如实报告：后端至少运行相关 pytest；前端改动至少 typecheck + 相关 test，影响构建/路由/依赖时再跑 production build；跨层、release/security/migration 变更按 `GOAL.md` / CI 对应 gate 扩大验证。文档-only 改动不要求无意义地跑全量构建。**未运行或失败的检查必须明确写出，绝不把“看起来没问题”当 PASS。**
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

Issues 和 PRD 使用当前 Git remote 对应的 GitHub Issues；外部 Pull Request 不作为需求分诊入口。详见 `docs/agents/issue-tracker.md`。

### Triage labels

分诊使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` 五个标准状态标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

项目采用根目录 `CONTEXT.md` 与 `docs/adr/` 的单上下文领域文档布局。详见 `docs/agents/domain.md`。

## 实现 Agent 准则

- 实现阶段先按“当前事实源”读取 `GOAL.md`、`docs/product/current-product.md`，再按任务读取 `CONTEXT.md`、相关 ADR / architecture docs 与 live code。评审意见、聊天总结、历史报告与当前 authority 冲突时，以当前 authority + live code/evidence 为准。
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
