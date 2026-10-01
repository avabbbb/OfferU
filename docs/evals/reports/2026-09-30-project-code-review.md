# OfferU 全面代码评审与 Resident Agent 接入评估

日期：2026-09-30。评审基线：`e1dbbaf`，本次 fetch 后 `HEAD...origin/main` 为 `0 0`。这是风险导向的跨模块评审，不是逐行穷尽审计，也不是 Public Release E2E 验收。此次没有修复业务代码。

## 结论

当前不满足公开发布条件。项目已经具备共享 Career Truth、Operation Registry、Proposal/HITL、AgentRunProvider、外部执行器和备份恢复的实际基础；主要问题是这些边界没有在全部入口和任务路径上闭环。不能用增加一个 Resident Agent 来替代边界修复。

发现 5 项 P1 和 4 项 P2。P1 表示会阻断主要流程、丢失用户编辑或破坏权限/隐私边界；P2 表示重要的一致性、恢复或交付风险。未发现有充分证据支持的 P0。

## 评审范围与证据

已检查当前产品与架构事实源、Registry 与授权、Agent provider/任务绑定、旧优化聊天、简历编辑/模板/导出、备份恢复、Tauri 生命周期和权限、扩展边界、CI 和依赖。所有动态复现使用隔离 fixture，没有读取生产简历内容、修改生产数据库或联系真实模型。没有打开浏览器窗口。

本次日志与复现脚本保存在 `H:/tmp/offeru/full-review-20260930/`。下列代码行号对应评审时工作区。

## 按严重程度排序的发现

### R1 · P1 · main 缺少启动所需的新文件，工作区通过不代表交付完整

- 位置：`backend/app/ops.py:28`、`backend/app/routes/resume.py:58`、`frontend/src/app/resume/[id]/page.tsx:45`。
- 已跟踪代码导入 `app.services.resume_design` 和 `ResumeDesignPanel`，但对应文件仍是 untracked；`git ls-files` 中不存在。相关新增测试和设计文档也尚未跟踪。
- 复现：从 `git archive HEAD backend/app` 解压出干净代码，用当前虚拟环境导入 `app.ops`，得到 `ModuleNotFoundError: No module named 'app.services.resume_design'`。远端 main 与本地 HEAD 相同。前端同样存在未交付的导入依赖，但没有另行执行完整干净前端安装。
- 影响：新 clone、CI、其他协作者和安装构建无法复现当前工作区。已有未跟踪文件应保留，不能通过删除它们“解决”。
- 建议：将功能直接依赖的模块及相关测试作为完整交付纳入版本控制，并从干净 checkout 验证导入和构建。
- 证据：`clean-head.log`、当前 `git status --short`。

### R2 · P1 · 非受信 Origin 的简单 POST 可以修改本地简历

- 位置：`backend/app/main.py:205`、`backend/app/main.py:348`、`backend/app/routes/resume.py:403`。
- CORS 设置和 loopback Host 检查没有形成服务器端写入授权。bodyless apply-template 路由可接受跨源简单 POST。
- 复现：真实 ASGI 应用和隔离 SQLite fixture；发送 `Origin: https://untrusted.example`、`Content-Type: application/x-www-form-urlencoded` 的空 POST。返回 200，响应不含允许该 Origin 的 CORS 头，但数据库中模板字号已变为 19。
- 影响：仅阻止浏览器读取响应，不能保证请求不执行。本次没有通过恶意网页验证真实浏览器攻击；浏览器本地网络访问许可可能降低某些客户端上的可达性，不应据此省略服务器边界。
- 建议：在副作用入口实施受信 Origin/调用能力校验，沿用本地 UI capability 与现有 Registry 策略；不要为此新增 SaaS 登录或放宽 CORS。
- 证据：`reproduce.py`、`reproduce.log` 的 `cross_origin_simple_post`。
- 依据：[Starlette CORS 文档](https://www.starlette.io/middleware/#corsmiddleware)、[OWASP CSRF 指南](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

### R3 · P1 · Career Director 把 CareerTask ID 传给仅接受 JobSearchTask 的 Run 创建路径

- 位置：`backend/app/services/career_tasks.py:632`、`backend/app/services/career_tasks.py:989`、`backend/app/services/pi_agent_host.py:285`、`backend/app/services/agent_run_state.py:155`。
- 调用方传入 `career_task_*`；Run 创建时 `_resolve_task()` 只查询 `JobSearchTask.task_id`。两者属于不同持久模型。
- 复现：创建真实 CareerTask fixture，再调用 Pi provider 的真实 start_run。模型尚未启动即抛出 `JobSearchTask career_task_review_fixture does not exist`。
- 影响：Daily、Profile Discovery、岗位保存评估、面试准备/复盘、简历更新后的 review 等共用路径不能完成。换入新 reasoning loop 也不会修复此问题。
- 建议：明确 CareerTask 与 canonical AgentRun 的绑定关系，保留原任务身份与重启恢复能力；不要伪造 JobSearchTask 或另建 Resident 任务库。测试应覆盖真正的 Run 创建 seam，再在模型执行边界替换 worker。
- 证据：`reproduce.log` 的 `career_task_pi_binding`；全量后端的 career resume/snapshot/interview 失败。

### R4 · P1 · 拒绝 AI 建议会覆盖尚未保存的手工编辑

- 位置：`frontend/src/app/resume/[id]/page.tsx:245`、`:264`、`:363`、`:372`。
- 自动保存延迟 800ms。单项和批量 proposal review 完成后直接 `setFromWorkspace(next)`，即使动作是 reject，也用服务器旧简历替换本地 draft。
- 复现：输入新的名字后立即点击“拒绝”；review 响应返回旧 workspace。输入恢复成旧名字，`resumeApi.update` 没有被调用。隔离 jsdom 复现测试通过，表示成功证明了错误行为。
- 影响：用户以为拒绝的是 AI 修改，实际丢掉自己的修改。导航前的未 flush 编辑也值得在修复时一起验证，但没有将其单独列为已动态复现缺陷。
- 建议：明确 dirty draft、正在保存的请求和 review 响应之间的同步；reject 应合并 proposal 元数据，不能无条件替换编辑内容。accept 必须基于当前 revision。覆盖立即拒绝、立即接受、在途保存响应和离开页面场景。
- 证据：`dirty-draft-repro.log`、`repro-tests/review.test.tsx`。

### R5 · P1 · 旧简历优化聊天的模型边界缺少 PII 脱敏

- 位置：`backend/app/agents/optimize_agent.py:1606`、`:1399`，以及 `backend/app/llm.py` 的模型调用。
- start_session 将 ProfileSection 标题和内容摘要原样加入 system messages；聊天将 session messages 直接发送至 chat_completion，该边界没有自动 desensitize → model → restore。
- 复现：使用合成邮箱和电话构造相同 session message，调用真实 turn stream，只替换模型网络函数以捕获参数。邮箱和电话仍以明文存在；没有联系真实模型。
- 影响：包含个人信息的档案摘要可能通过该路径送往外部模型。不能由本次 fixture 推断用户真实数据已经外泄。
- 建议：复用项目现有脱敏映射，每次请求对全部上下文和工具结果应用边界，并验证返回文本恢复。不要只清日志或只处理用户最后一句话。
- 证据：`privacy-repro.py`、`privacy-repro.log`。

### R6 · P2 · 旧优化聊天无法将 protected mutation 转为可确认 Proposal

- 位置：`backend/app/agents/optimize_agent.py:946`、`backend/app/routes/optimize.py:1120`。
- `_registry_outputs()` 以 `surface='optimize_agent'` 直接调用 execute_operation，没有 execute_or_propose 和持久确认授权。聊天里的确认文字不会产生 canonical Run Proposal。
- 复现：在隔离完整 schema 上调用该 helper 的 start_job_research，返回“该副作用操作需要先写入 Agent Run 提案并由用户确认”。副作用没有执行，这是保护生效，但当前 UX 没有完成所需确认链。
- streaming 路由还直接调用聊天逻辑，被现有 architecture audit 判定为未经过 Registry 的入口。不要将这个结果夸大成所有业务写入都可绕过 HITL：受保护操作实际上被挡住了。
- 建议：通过现有 Proposal/Run 路径产生可确认动作，保持独立人类确认；让 streaming 生命周期和审计接上 canonical provider，不能通过移除保护让聊天“恢复正常”。
- 证据：`optimizer-guard.log`、`architecture-audit.json`、全量 architecture/control-plane 测试。

### R7 · P2 · 应用模板没有推进 revision，旧保存可以覆盖新样式

- 位置：`backend/app/services/resume_route_operations.py:191`、`:204`。
- apply-template 更新样式并 commit，但没有推进 workspace_revision；普通 update 则使用 revision 做冲突检查。
- 复现：模板将字号改为 19 后 revision 仍为 0；旧 draft 以 expected_revision=0 保存字号 10.5，被接受并成为 revision 1。
- 影响：多入口或在途自动保存会静默撤销模板变更。单用户也存在并发请求。
- 建议：所有修改同一 workspace 的路径共享版本推进和事务规则；在冲突敏感写入中要求 expected_revision。
- 证据：`reproduce.log` 的 `template_stale_overwrite`。

### R8 · P2 · 恢复与回滚双重失败时，finally 删除未恢复的本地 rollback 副本

- 位置：`backend/app/services/data_safety.py:670`、`:691`。
- 回滚 os.replace 失败后抛出 fail-closed 错误，但 finally 仍无条件删除 prepared 中的 rollback。
- 复现：真实 backup/stage/apply fixture，注入安装验证失败，再注入 rollback replace 失败。最终 database_exists=false、rollback_files=[]；仍保留两份备份 ZIP，包括 pre-restore。
- 影响：原地回滚副本消失，只能走备份归档恢复。不是“全部备份丢失”或已证明不可恢复，但显著增加恢复复杂度。
- 建议：仅在确认安装或回滚成功后清理对应副本；失败时保留 recovery journal 和路径。添加双重失败、重启后恢复的故障注入测试。
- 证据：`reproduce.log` 的 `restore_double_failure`。

### R9 · P2 · Python 发布依赖缺少可复现清单与漏洞 gate

- 位置：`backend/requirements.txt`、`.github/workflows/build.yml`、当前 backend `.venv312`。
- 多数要求采用开放式最低版本；CI 没有 Python dependency audit。当前本地打包环境审计报告 15 个包共 138 条 advisory，涉及 pypdf、Pillow、Starlette、MCP、WeasyPrint 等，也包含 pip/setuptools 等构建工具。
- 这个数字是已安装环境的 advisory 数，不是 138 个已证明可利用的产品漏洞，也不代表新建 CI 环境一定解析到相同版本。需要结合发布包 inventory、可信 advisory 和实际可达性裁决。
- 官方 npm registry 审计：frontend 生产依赖 0；agent 生产依赖 3 个 moderate 受影响包，包含 pi-coding-agent 的 undici 依赖链与 ip-address。没有证明应用中存在可利用的 WebSocket/地址分类调用链。
- 建议：为实际发布环境生成受控依赖清单/锁定方案，加入 Python 审计 gate，并对可达的解析器和网络依赖逐项升级回归。不要直接批量升级所有包来追求数字清零。
- 证据：`python-audit.json`、`frontend-audit-official.json`、`agent-audit-official.json`。默认镜像 audit API 返回 405 后改用命令级官方 registry，没有修改用户 npm 配置。

## 本次实际检查结果

| 检查 | 结果 | 说明 |
|---|---|---|
| backend 全量 pytest | 824 passed / 15 failed / 12 skipped | 另有 11 subtests passed；390.60s |
| frontend typecheck | PASS | 当前工作区 |
| frontend 全量 test | 58 passed / 1 failed | AddJobModal 5s 超时；单独重跑该文件 5 passed，未证明产品功能错误 |
| frontend production build | PASS | 6.86s；包含工作区未跟踪模块 |
| extension typecheck | PASS | 当前工作区 |
| extension test | 213 passed / 7 skipped | 29 个文件通过，1 个文件跳过 |
| architecture audit | FAIL | 1 项：旧 optimize streaming 入口 |
| public release readiness | NOT_READY | policy/checklist 证据状态，不是替代真实 E2E 的结果 |
| version / claims audit | clear / clear | 仅表示对应扫描规则没有发现问题 |
| clean HEAD backend import | FAIL | resume_design 未交付 |
| 合成动态复现 | 见 R2–R8 | 不写生产数据、不接真实模型 |

15 个后端失败应分类处理：CareerTask 绑定和旧 streaming audit 是实际链路问题；部分 Codex→Pi、Skill 命令、web 连接源码断言已经落后；bundled JSON 静态资源和旧 PLAYWRIGHT_BROWSERS_PATH 断言与最新显式 bundled executable 实现不一致。不能把旧测试期望当成架构 authority，也不能直接删除测试来获得绿色状态，应更新行为验收。

## 分模块成熟度评估

| 模块 | 评估 | 当前主要限制 |
|---|---|---|
| Career Truth / Registry / Proposal | 核心基础已存在 | HTTP 写入口没有统一完成调用边界；旧聊天确认链脱节 |
| Career Director | 有结构化状态和触发路径 | CareerTask→Run 绑定阻断模型启动 |
| External Runtime | 具备真实 executor、probe、run/artifact 结构 | 本次未跑真实多宿主模型验收，不能据静态代码宣称全部可用 |
| 简历编辑与设计 | 工作区功能和测试已较丰富 | 交付缺文件、dirty draft 覆盖、模板版本冲突；未做本次视觉验收 |
| 导出/桌面交付 | 已实现 bundled browser 和静态导出路径 | 本次未重新构建/安装冻结产物，源码 build 不等于安装包验收 |
| 备份/升级 | 有检查和 pre-restore 保护 | 双重失败清理会降低原地恢复能力 |
| 扩展 | 当前自动检查基本通过 | 跳过的场景和实际宿主行为没有在本次补验 |
| CI / release | gate 体系已建立 | 干净 main、全量回归和依赖 gate 尚未收敛 |

## Resident Agent 集成评估

### 当前能确认的架构与未知项

小伙伴的源码路径/仓库尚未提供。以下是上游一侧的兼容矩阵，不能称为两套代码已验证兼容，不能评判对方 loop、memory、streaming 或工具语义的实际实现。

| 需求 | 当前 OfferU authority / seam | 接入要求 |
|---|---|---|
| Resident provider | `services/agent_runtime.py:157` 的 AgentRunProvider；现有 Pi adapter | 复用 start/status/resume/confirm/reject/abort 生命周期，不先造第二个框架 |
| 读当前页面/岗位 | Skill Registry 的 connection_bootstrap / get_current_view | 最小第一刀可以直接用；以真实 model-issued Operation read 验收 |
| 工具发现与业务读写 | Skill/Operation manifest、ops、operation_projection | 对方工具只做语义适配，不迁入 DB repository |
| mutation 确认 | execute_or_propose_operation、confirm_operation_proposal、UI capability | 保留独立人类批准，聊天“确认”不等于授权 |
| Run / streaming | canonical AgentRun 与事件映射 | 复用现有 waiting_confirmation 等状态；概念状态可在 UI 映射，别新增平行状态机 |
| 主动任务 | CareerTask / AutomationEvent 等现有链 | 先修 R3，再接 career reasoning；不增加无限循环 |
| 外部执行 | coding_agent_runtime、delegate_career_task、artifact workspace | 已有委派基础，第二阶段复用并加强输出与权限约束 |
| memory | 会话状态与 Career Truth 分离 | 保留可替换的 session；事实提交仍走证据/授权路径 |
| Skill | canonical Skill Registry | 共享知识和 manifest，不建立 Resident 专属产品状态 |
| 普通用户入口 | 当前 App-first / external-first 产品文档 | Resident 默认是产品策略变化， rollout 前同步 GOAL/current-product，保留回滚 |

### 对用户提出方案的判断

“保留 intelligence，适配现有 Runtime Contract”方向正确。当前已经有 AgentRunProvider，不需要从零设计同名抽象。若对方本来基于兼容的 Pi loop，可能只需迁入 prompts、planning 和工具选择；若其 loop 依赖另一套 SDK，应做 provider adapter。没有对方源码前不能选择具体路线。

用户希望外部任务完成后回到 Resident 总结，这更接近有界 delegation / specialist as tool。不要在最初就将整个对话控制权和 session 移交给外部 Agent。[OpenAI Agents SDK 的多 Agent 模式](https://openai.github.io/openai-agents-python/multi_agent/)可作为语义参考，不表示需要引入该 SDK。

当前已有 `delegate_career_task` → `delegate_workspace_task` → CareerTask/run_artifact。应检查父子 Run、稳定 entity refs、allowed_operations、approval_policy、取消/恢复和 output_contract，而不是再造一个外部委派系统。当前通用输出 schema 较宽，不能直接当作强约束契约。

### 可迁、需适配、不能迁

- 可迁候选：职业推理 prompts、loop、planning、tool selection、对话展示、structured response、streaming adapter。必须先审对方实现及许可证。
- 需适配：describe_capability/query_records/create_record/invoke_action、session backend、确认交互、主动触发、运行事件、任务路由。
- 不能作为第二 authority 迁入：Job/Profile/Application/Evidence store、事实 memory、action/permission registry、Skill Registry、Agent task/run 状态库。对方自有内部测试 fixture 不应成为生产数据。

### 预计文件范围与增量计划

不是此次修改计划，仅供双边源码审查后的范围估算：`agent_runtime.py`、必要的 Pi host/worker 或新增 provider adapter、`career_tasks.py`/`agent_run_state.py` 绑定修复、Skill allowlist 与现有 Operation projection 的最小适配。AgentPanel/stream adapter 仅在后台行为证明后调整。不要首先改数据库领域模型、删除旧 provider 或替换整个 UI。

1. 先完成 R1–R5 及全量 gate 修复；取得对方源码，生成真正的双边 compatibility matrix。
2. A：独立 integration branch，只证明 Resident→canonical Run→get_current_view/Job read→stream→complete。此阶段不做外部 handoff。
3. B：迁 prompts/loop/tool selection，验证 protected mutation 产生 Proposal，独立用户确认后执行。
4. C：复用现有 external delegation，验证父子关联、结果/产物持久化、重启/取消、结果回到 Resident，确认与工具权限不升级。
5. D：满足行为 parity 后统一 OfferU AI UX，再决定默认 provider 和退役旧实现；更新产品 authority，保留回滚。

验收应包括真实模型身份和 model-issued calls；mock provider/脚本 Operation 序列只能证明协议或 workflow。Resident 与 external 必须读取同一 Job/Profile/Evidence；重启不改变 Career Truth；用户拒绝操作时不丢 draft、不写事实；不得出现第二套状态或 Agent 自确认。

## 修复顺序与未执行检查

建议顺序：完整交付 R1 → 服务端写入边界 R2 → 编辑安全 R4 与版本 R7 → 任务绑定 R3 → PII R5 → 旧聊天闭环 R6 → 恢复 R8 → 依赖和回归 gate R9。顺序可按当前是否暴露 HTTP 服务及用户使用情况调整，不构成已获授权的修复任务。

未执行：当前安装包重新构建/安装与真实冻结导出、macOS/Rust 全面扫描、隔离网页视觉验收、真实多宿主 Agent E2E、实际人类 HITL、干净环境依赖解析与发布包 SBOM、对方 Agent 的源码和许可证审查。不能将此前会话或其他 checkout 的成功结果当作本次验收。
