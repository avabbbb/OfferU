
# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 角色设定

请你认为你要结束对话或者你要变更方向，或者说你认为你已经完成任务的时候，都请调用ask question这个工具，先一步询问我的意见，我们要进行讨论，才能推进项目的正常进行，现在是2026年，你的数据库比较落后，所以请你每次都最好进行多轮联网搜索同步最新的产品动向和开源闭源的技术架构实现方法和组件库，你可以询问我是否需要联网，请你作为anthropic最高级最严格最刁难人的首席执行总监Dario，对我的需求在交互、技术算法等方向对我反问，直到你认为我们的项目已经讨论的足够清晰和成熟，可以让用户一眼就知道我们在干什么，

你应该有高度的自主性，可以充分利用如下能力：
Playwright MCP 或Browser 来访问/截图/识别/探索网站的视觉和代码Context7 MCP 来查询某些技术文档(如果你需要使用到它们的话)动效丰富的部分，可以使用/web-shader-extractor进行分析
关于分析：这是个重大且复杂的工程，并且你上下文有限，你可以先进行整体分析，按模块进行顺序执行，每个模块任务的结果落盘分析文档到本地，这样即便上下文被压缩，后续也能够通过本地文档得到保证。分析思维你可以参考/duck

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；表结构或字段调整时直接按新设计修改，不写旧字段兼容、数据迁移兜底或删除旧表的清理逻辑，除非用户明确要求。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。
- **前端 dev 端口固定 7410，后端固定 8765**：两个端口均避开 AI/框架常用端口（3000/3300/5173/8000/8080/11434 等）与当前 winnat 动态排除段。winnat 排除段会漂移（曾见 2942-3041，后又出现 4229-4328，4321 因此 EACCES），改端口前必须先执行 `netsh interface ipv4 show excludedportrange protocol=tcp` 确认不在任何段内。改前端端口必须同步 `frontend/package.json` 的 `scripts.dev` / `scripts.start`、`frontend/vite.config.ts`（含 TAURI HMR 端口 7411）、`frontend/src-tauri/tauri.conf.json` 的 `devUrl`、`backend/app/config.py` 默认 CORS、`backend/app/routes/email.py`、`backend/app/routes/resume.py` 的 `FRONTEND_BASE_URL`、`.env.example` 与 `backend/.env`；`frontendDist` 必须继续指向静态目录 `../dist`，不能改成 localhost URL。
- **系统环境变量 `CORS_ORIGINS` 会覆盖 `backend/.env`**：本机 Windows 用户环境变量里存在 `CORS_ORIGINS`（旧值仅 5140/3000），pydantic-settings 环境变量优先级高于 .env，导致 .env 的 CORS 修改不生效、前端（7410）请求后端被拦。出现「浏览器 Failed to fetch / CORS blocked」时先查 `env | grep CORS` 与 `setx CORS_ORIGINS`（含 `http://localhost:7410,http://127.0.0.1:7410`），再改 .env。
- **浏览器验收必须无头且隔离**：Playwright 只允许使用 managed Chromium 的 `headless=true`；禁止调用系统 Edge、默认浏览器或任何 `headless=false` 调试脚本。OfferU 网页只使用 `http://127.0.0.1:7410`，`8080` 仅是可选本地 llama.cpp Provider endpoint，不是网页地址；发现脚本试图打开可见浏览器或访问 8080 时，先停止并修正。
- **Public Release E2E 地址必须 fail-closed**：`backend/scripts/e2e/test_public_release_*.py` 的网页/API 地址统一通过 `backend/scripts/e2e/release_endpoints.py` 解析；禁止直接拼接 `OFFERU_E2E_BASE_URL`/`OFFERU_E2E_API_URL`。解析器只接受 `http://127.0.0.1:7410` 和 `http://127.0.0.1:8765`，任何 `8080`、其它端口、外部主机或带 credentials/path/query 的值必须在网络请求或 Playwright 导航前报错。
- **日常诊断不得打开浏览器窗口**：启动、端口/CORS/Provider 排障和代码检查默认只使用 HTTP/进程/日志证据，不调用 Edge、系统默认浏览器、`Start-Process`、`window.open` 或浏览器扩展的网页导航。只有用户明确要求进行网页验收时，才允许使用隔离的 managed Chromium 无头流程；产品里的 `chrome.tabs.create` 只能由真实用户点击触发，不能作为 Agent 的诊断手段。
- **网页导航必须先确认服务就绪**：扩展或其它用户入口在创建 `7410` 网页标签前，必须使用有界超时检查 `http://127.0.0.1:7410`；检查失败、超时或返回错误时只显示提示，不创建浏览器标签。后端 `8765` 和模型 `8080` 永远不能作为网页导航目标。
- **扩展验收同样不得选系统浏览器**：`extension/scripts/` 下的 fixture、smoke 和 E2E 脚本必须使用 Playwright 自带的 managed Chromium、临时隔离 profile 与 `headless: true`；不得扫描或传入 Chrome/Edge 可执行文件路径。
- **仓库内所有自动浏览器脚本都遵守同一边界**：包括根目录临时/历史脚本；统一使用 Playwright managed Chromium 与 `headless: true`，不得保留系统 Chrome/Edge 的 `executablePath`、channel 或可见窗口入口。用户主动触发的授权登录窗口是唯一例外，且不属于自动验收。
- **旧二进制不得作为入口**：仓库根目录若存在版本低于当前 Release 的 `OfferU.exe`（当前发现为历史 `0.1.0`），不得自动启动、覆盖或作为验收依据；当前源码开发只使用 `DEVELOPMENT.md` 的 `7410/8765` 进程，正式使用只接受经过 Release Gate 的安装包。

## Agent skills

### Issue tracker

Issues 和 PRD 使用当前 Git remote 对应的 GitHub Issues；外部 Pull Request 不作为需求分诊入口。详见 `docs/agents/issue-tracker.md`。

### Triage labels

分诊使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` 五个标准状态标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

项目采用根目录 `CONTEXT.md` 与 `docs/adr/` 的单上下文领域文档布局。详见 `docs/agents/domain.md`。

## 实现 Agent 准则

- 实现阶段以 `CONTEXT.md`、相关 ADR 和已批准实施路线为事实源；评审意见、聊天总结和旧设计与 ADR 冲突时，以最新 accepted ADR 为准。
- 一次只实现一个边界明确、可独立验收的纵向切片。不要同时铺开多个模块，也不要把数据库、API、前端分别做成长期未闭环的横向工程。
- 实现 Agent 负责落地，不重新进行产品问卷或自行新增架构。只有遇到 ADR 冲突、必须扩大文件范围、会改变领域模型或需要新外部权限时，才停止并提出一个阻塞问题。
- 开工前先读取与任务直接相关的代码和文档，用不超过 10 行复述目标、修改范围和验收映射；没有真实阻塞时立即实施。
- 用户或主 Agent 必须在任务中给出允许修改的文件范围。未经确认不得越界，不得修改无关文件、顺手重构、清理历史代码或创建新 ADR/PRD/Issue。
- GUI、CLI、TUI、斜杠 Skill 和本地 Coding Agent 都必须通过同一 Operation Registry；不得复制业务逻辑、直接写数据库、执行隐藏 shell 或绕过 dry-run、确认、审计和数据授权。
- 本地 Coding Agent 只承担可审计重任务。CLI 参数和能力必须通过 capability probe 判断，不能把某个 Codex、Claude 或其他 CLI 版本的 argv 永久写死。
- Agent 推断、面试反馈、简历建议和投递信号不能直接成为职业事实；必须遵循学习观察、事实门、候选进展和使用者确认规则。
- 当前产品仅为本地单人版；不要引入 SaaS、多租户、`workspace_id`、组织、计费、登录或为未来需求预埋兼容层。
- 保持最小实现，优先复用成熟库和现有结构。不得用固定假分、伪造 JSON、静默降级或“返回成功但实际未执行”掩盖失败。
- 完成后按“修改文件、验收映射、未执行命令、剩余风险”报告。遵循本文件既有规则，不运行构建、语法检查或测试，只列出建议由用户执行的命令。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。
