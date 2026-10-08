> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# PR #51 Luna 独立验收报告

日期：2026-10-02。状态：**独立测试报告；不代表 Goal A/B 或 Public Release 通过。**

## 结论

修正打包参数后的 Tauri Desktop 能加载内嵌前端，随包 backend health 为 `0.4.0 / release / desktop-sidecar / ready`。打包 Runtime 的 keyring 状态为 available，DeepSeek `devin/deepseek-v4-1-flash` 发起了真实模型请求；模型通过 Operation Registry 完成了只读 Profile 回读、手动选择 Skill 后的两工具回读，并把 L2 Profile 操作留在独立用户审核队列。待审运行和操作在关窗重启后仍可见，随后由 UI 的“取消本次 Run”取消，Profile 没有被写入。本次模型没有调用 `review_memory_proposal` 或任何确认工具；所验证的是受保护写入保持待审，不能据此声称已覆盖蓄意自批准攻击。

这仍不是完整真人验收。我们没有读取真实简历或 Agent Memory，没有真实岗位、账号、面试或真人对受保护操作的确认。首轮 `app.exe` 因打包缺少 `tauri/custom-protocol` 加载成 127.0.0.1 连接错误；该次标为 **INVALID/setup failure**。父代理重新构建的内嵌静态前端包通过启动检查。

实测中有两个高优先级状态错误：合法的 L1 JD-only Resume 提案会让 packet 把 research 和 interview focus 都标成已关联，但这两个素材均不存在；Job 页面投影也会把无 `RoleBenchmarkRun` 的已完成 CareerTask 标成 benchmark 完成。另一个可重复的生命周期问题是：正常关闭正确包的窗口后，`offeru-backend.exe` worker 两次都继续占用 8766；我只停止了路径核验为本次临时包的遗留 PID，并确认测试结束后 7410/8766 无监听。

## 今天开始求职会在哪被迫离开 OfferU

- 默认 AgentPanel 固定选择“技能中心”。连续两次自然语言询问岗位列表/角色情报，真实模型都只调用 `get_profile`；用户需先手动选“职业总监”等 Skill 才能获得相应工具。一次手动选择后的多工具回读成功，但自动路由没有发生。
- 内置 Agent 被要求原生结构化 Ask 时，只发出普通聊天文字等待选择，没有 Ask 控件或 Ask tool event。CareerTask 的 `CareerQuestionsPanel` 是另一条已实现的问答→pending evidence 路径；它不能证明内置 Run 有主动决策 Ask。
- 新鲜岗位来源、可解释评分排序和真实 BOSS 账号路径没有验收。`list_jobs` 的正式排序字段是创建时间、发布时间或标题；没有找到分数排序出口。
- 正式 ApplicationAction Registry 站外写执行器尚未接入。本次登录、注册、浏览器扩展/SmartFill、填表与 receipt 路径均未验收。按产品边界，最终外部提交仍由用户手动完成；本次结果不判断现有浏览器或扩展能力是否存在。
- 真实 Resume、公司/团队、研究到 Resume/Interview 资产绑定、真实面试逐题复盘和下一轮学习没有真实资料可验收；这些阶段继续保持 NOT_TESTED。

## 真实 Desktop 与模型证据

### 包身份、Runtime 与首次启动

PR #51 固定设计 head 为 `dea9f13cbac6961a38e19e426d7f89253a3798cf`。被测代码是 HEAD `38fdab5728f9c05ca1fc870dcd66ebdb13d98d00` 加当前 dirty worktree；构建身份明确记为 `dirty_worktree=true`，不能当作纯 HEAD。

- 首次 app hash `7D8D81E15386C215B425B9EDAD7B294ED19F511E56DD5946F97BCA5B0CA82DF7` 的 WebView 显示 `127.0.0.1` connection refused。没有启动 Vite、7410 或源码服务。父代理确认该包以 `cargo build --release` 构建，缺少 `tauri/custom-protocol` feature。
- 正式重测 app hash `0A6222B2CFF032F2EEE67EBA322B50AA5962BC3A279A04A3C8B8404553E2C3F1`；backend hash `930A317ACAEC9E5120ED65D031B6805890450EE2477FCD017137E0DEFB450085`；Node hash `63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088`。`build-identity.json` 标记 `tauri/custom-protocol: embedded static frontend`。
- Runtime 使用 `H:/tmp/offeru/owner-dogfood-20261002/goal-a-runtime`，TEMP/TMP 和 WebView profile 位于 `H:/tmp/offeru/pr51-luna-20261002/`。启动前 Profile、Job、Resume、CareerTask、AgentRun、Proposal、Application 和 Interview 相关表计数均为 0。
- 打包 `/api/config/` 的脱敏回读返回 `vault_status.available=true`。配置没有 inline key；provider/model 为 `deepseek / devin/deepseek-v4-1-flash`。没有导出、打印或明文落盘 Key；真实模型按 canonical config 经 vault 在内存读取使用。
- `/api/health` 返回 `status=ok`、`build_mode=release`、`runtime_mode=desktop-sidecar`、启动恢复 `ready`。
- 初次运行 Today 建立了一个持久 `DAILY_REVIEW` CareerTask（`career_task_760d70ad19b64eaca84f`），模型读了 `get_career_snapshot` 和 `get_daily_career_context` 后完成。它是自动 Director 回合，不计入 AgentPanel 主聊天的多工具成功。Today 空状态直接显示 `DAILY_REVIEW`、`strategy_pack=null`、`campus_search` 和 `(redacted phone)` 等内部词，不能当成清楚的首用引导。

### 内置 Agent 自然语言回合

所有下列 live runs 使用同一个打包模型；日志保留 provider/model、Run ID、Skill、Operation 事件和状态回读，证据目录只保存合成输入和脱敏摘要。

| Run | 入口/条件 | 模型发起的 Operation | 实际结果 |
| --- | --- | --- | --- |
| `run_0caea61f54b9444fb940672d6ec89691` | 默认“技能中心”，只读 Profile 请求 | `get_profile` | completed；没有真实 Profile 事实，模型没有写入 |
| `run_45c51f5646af4a64bd7efbec16434602` | 保持默认 Skill，自然语言查已保存岗位和研究状态 | `get_profile` | completed；未调用 `list_jobs`，没有自动切换 Skill |
| `run_5e1e2f4dd0834004bd0a3e48784a3050` | UI 手动切换“职业总监”，只读 Career Context 请求 | `get_career_snapshot`, `get_daily_career_context` | 两个 Registry Operation 均 completed；多工具主聊天回合有效 |
| `run_a54c9d9eed0548fa8f76d4143f962762` | 合成 Resume 定位选择，要求 native structured Ask | 无 | completed；只有普通聊天中的等待文字，没有 Ask tool 或结构化控件 |
| `run_bc963e55a140450d9466ecb22659cbb5` | 合成 Profile evidence/确认边界探针 | `add_profile_evidence` 提案，随后只读 `list_profile_evidence` | L2 写请求由 Registry 投影为 `waiting_confirmation`，Profile 未写；重启后审核卡可见，未确认，随后通过“取消本次 Run”取消 |

受保护操作的 UI 展示“逐项审核动作”并提供拒绝/执行按钮。该测试没有点击任何 Proposal 的拒绝或确认按钮。取消普通 Run 后，`agent_runs.status=cancelled`，保留 `run.cancelled` 审计事件，`profile_sections=0`、`memory_proposals=0`。这证明待审内容不自动进入 Career Truth；**真人是否确认以及确认后的最终 UI 结果仍 NOT_TESTED**。

### 重启与关闭

待确认的 L2 Run 在关闭窗口后保持 `waiting_confirmation`；使用新的 `WEBVIEW2_USER_DATA_FOLDER` 重启后，Desktop 仍显示 `待你确认 1项`，打开后能查看相同 Run ID 与操作范围。运行最后通过 AgentPanel 的普通 Run 取消入口取消；没有将 Proposal 的拒绝/确认冒充为取消。

正确包正常关窗 **2/2 次**都遗留一个 `offeru-backend.exe` worker 继续持有 `127.0.0.1:8766`。第二次链为 `app.exe 40240 → backend 37072 → worker 5416`；关窗后 app 和 backend 父进程退出，worker 5416 仍监听。仅在确认可执行文件路径属于本次 `desktop-current` 后停止该 PID。最终核对 `remaining_package_processes=null`、7410/8766 无监听，证据见 `artifacts/final-process-cleanup-check.json`。首个错误包也遗留过 worker，但该次另记为 setup failure，不与正确包的 2/2 重现混淆。

## 三层验收矩阵

`Real owner acceptance` 只记真人独立确认/最终 UI 结果；真实模型调用、自动化窗口操作、fixture 和单测均不升格为真人 PASS。

| 能力/用户结果 | Source/code exists | Product path reachable | Real owner acceptance | 证据层与限制 |
| --- | --- | --- | --- | --- |
| 原生便携构建物启动 | YES | WORKS | NOT_TESTED | 实际 `app.exe` + packaged sidecar；health ready；仅在隔离 Runtime；没有安装程序或干净机器验收 |
| Desktop 退出释放 Runtime | YES | BROKEN | NOT_TESTED | 正常关窗后 worker 两次遗留并持有 8766；最终只停止路径核验过的测试 worker |
| AgentPanel 默认 Skill 及自然语言自动路由 | YES | PARTIAL | NOT_TESTED | 两条真实 Discovery runs 都只调用 `get_profile`；`AgentPanel.tsx` 固定默认 discovery 并发送当前 `skill_id` |
| 手动选择 Skill 后的真实多工具回合 | YES | WORKS | NOT_TESTED | 打包 DeepSeek Run 手动选择 `career_director`，两个只读 Operation completed；不补齐默认自动路由 |
| Directory Skill 正文/方法载入到内置模型 | NO | BROKEN | NOT_TESTED | H 盘合成 SKILL.md 正文 marker 未进入 `AgentSkill` 返回字段；仅 frontmatter、description 和 tools 被解析。不能外推宿主自行加载第三方 Skill 的能力 |
| CareerTask 问题面板 | YES | PARTIAL | NOT_TESTED | `CareerQuestionsPanel` 挂载于 Today/Profile/Job；后端问题→观察/待审提案测试通过。本轮没让真人回答实际 CareerTask 问题 |
| 内置 Agent 原生结构化决策 Ask | NO | BROKEN | NOT_TESTED | 真实模型请求 structured Ask；event 无 Operation，UI 只出现普通聊天等待文本。不同于 CareerTask 问题面板 |
| L2 Profile 写入的独立用户审核 | YES | WORKS | NOT_TESTED | 真实模型 L2 Operation → Registry pending → Desktop 可见审核卡 → 跨重启保留 → 正常 Run cancel；没有批准或拒绝 |
| 活跃流式 Run 的用户取消入口 | YES | PARTIAL | NOT_TESTED | 等待确认 Run 的普通取消已实测；运行中输入/发送控件禁用，取消控件只在 interrupted/pending surface 出现。本轮没有中断一个仍在流式的模型请求 |
| 无 RoleBenchmark 的 Job preparation 完成投影 | YES | BROKEN | NOT_TESTED | 动态执行当前 Job 页面 `preparationProgress` callback；完成的普通 assessment task 被投成 benchmark `done`。仅 callback fixture，没有真实 Job 页面数据 |
| Resume packet research/interview_focus 引用 | YES | BROKEN | NOT_TESTED | 合法 L1 `external_agent` JD-only Proposal（`research_run_id=null`）经 prepare/persist/bind/read；无 JobResearchRun、RoleBenchmarkRun、AIInterview 或 CareerArtifact，packet 仍两个布尔值都为 true |
| Resume 与 Interview 共享 Benchmark/ResumeVersion | YES | PARTIAL | NOT_TESTED | Resume preparation context 含 source fingerprint/verified sections/baseline rows，没有 benchmark/research/version ref；AI 面试专项 Focus 有独立 benchmark ID。无真实资产交叉验收 |
| 分数可解释的岗位队列排序 | NO | BROKEN | NOT_TESTED | 当前 `list_jobs` 仅支持 `created_at/posted_at/title`；本轮隔离库无岗位，没有 score-sort 实际 UI 验收 |
| 正式 Registry 站外写执行器 | YES | PARTIAL | NOT_TESTED | ApplicationAction Registry 报告 `execution_available=false`；浏览器/SmartFill、登录注册、填表和 receipt 路径均未验收；最终提交仍由用户手动完成 |
| BOSS 三层能力（上游/OfferU/本人账号） | YES | PARTIAL | NOT_TESTED | 源码有 adapter/能力边界；没有真实账号，因此上游当前版本、OfferU连接、用户会话三层均未实测 |
| 真实面试逐题复盘→下一轮学习 | YES | PARTIAL | NOT_TESTED | 有 Career Interview、AI Focus 与 Learning Candidate 基础；本轮没有真实面试 transcript/recall、已审核弱项或下一轮资产引用 |
| Reset 覆盖 Python Agent Sessions | YES | BROKEN | NOT_TESTED | 合成 H 盘文件树调用实际 `_reset_runtime_files()`：`pi_sessions` 和 uploads 删除，`python_agent_sessions` marker 保留。没有执行完整数据库 reset、备份或批准 |
| Goal A 有/无简历、授权 memory、Profile 建档 | YES | PARTIAL | NOT_TESTED | 空隔离启动、Profile 只读完成；没有真实简历目录、记忆授权或真人访谈，Profile 未建立 |
| 实时公开职位/公司/团队研究 | YES | PARTIAL | NOT_TESTED | 有 research/benchmark Operations；没有验证当前 Provider 的来源新鲜度/可比样本，不以模型文字算联网通过 |
| 内置 Run 的当前网页/外部源刷新 | YES | PARTIAL | NOT_TESTED | 有岗位研究/情报 Operations，但本轮没有真实 Job、URL、外部 Provider 回读或来源时间戳；未声称内置 Agent 已联网 |
| 手动 section review、PDF 导出与 stale gate | YES | PARTIAL | NOT_TESTED | 相关 workspace/fact gate 代码存在；没有真实 Resume、用户审核或导出文件路径验收 |

## 合成动态复现与自动检查

全部 fixture、脚本、截图、日志、隔离 profile 和临时数据仅在 `H:/tmp/offeru/pr51-luna-20261002/`。合成服务测试用 SQLite in-memory DB；Reset canary 只操作该 H 盘测试目录。

- `scripts/job_progress_projection_fixture.cjs` 使用项目 TypeScript compiler 对实际 `frontend/src/app/jobs/[id]/page.tsx` callback 做转译并执行。结果见 `artifacts/job-progress-projection-fixture.json`。
- `scripts/resume_packet_valid_jd_only.py` 执行正常 L1 JD-only prepare/persist/workspace/read 路径；`research_run_id=null` 的合法 proposal 仍造成 packet 假关联。
- `scripts/reset_python_session_canary.py` 只调用文件清理 helper；没有执行破坏性全清 Operation。
- `scripts/directory_skill_body_probe.py` 对合成 SKILL.md 运行真实目录解析器；不代表 live host composition。
- `scripts/inspect_protected_run.py` 与 `scripts/inspect_cancelled_run.py` 只读回填充运行轨迹；不输出 prompt 原文、Key 或凭据。

定向 pytest 使用 backend Python 3.12 venv，临时根在 H 盘。组合命令为 `H:\tmp\offeru\venvs\backend-py312\Scripts\python.exe -m pytest -q backend/tests/test_application_action_registry.py backend/tests/test_byok_directory_skills.py backend/tests/test_career_questions.py --basetemp=H:\tmp\offeru\pr51-luna-20261002\pytest -p no:cacheprovider`。首次因缺少 `PYTHONPATH=backend` 未能收集（`ModuleNotFoundError: app`），修正后 26 个目标用例中 24 passed、2 个 Career Questions 用例因 conftest 复用了默认 H pytest DB 而出现 ID 序号断言失败。确认 `backend/tests/conftest.py` 会清除 `DATABASE_URL`，并把 DB 指向 `OFFERU_TEST_TEMP_ROOT/offeru/pytest-temp/offeru-data/djm.db` 后，将两个失败用例分别放入新的 `OFFERU_TEST_TEMP_ROOT`，使用 `-p offeru_engine_guard` 在 collection 结束时打印/校验实际 engine URL；两项分别 **1 passed**。最终该组 26 个目标用例均有隔离有效通过结果。初次共用测试目录没有清理，也没有读取或更改仓库 DB、真实 vault ref 或用户文件。

重建包后 `/api/health` 与真实内置模型/Operation 流程均通过。本轮没有重跑父代理已通过的 31 个 backend pytest、10 个 frontend tests、typecheck 或 production build；这些仅是父代理此前报告的结果。

## 尚未测试 / 验收门

- 用户未提供真实简历精确目录或 Agent Memory 授权；没有猜路径、扫描磁盘或读取真实文件。
- 没有真实岗位、当前外部来源、登录的 BOSS/ATS/邮箱账号、申请材料或提交目标。
- 没有真实面试 transcript、本人 recall、团队情报或获批准的学习候选。
- 没有任何真人点击 Proposal 的确认/拒绝按钮；不声明 HITL adoption 通过。
- 没有验证外部 Codex/Claude/WorkBuddy 接入、CLI/MCP nonce、第三方 Skill composition、原生 web/search、steering、compaction、active-stream cancellation、失败 provider/retry、真实 PDF 导出、安装升级、备份恢复或干净机器。
- 没有使用 Playwright 或启动 7410/Vite/源码服务；没有发送或提交外部动作。

## 建议按证据顺序修复

1. 先修两个错误成功投影：Job benchmark 只能由真实 benchmark artifact/receipt 决定；Resume packet 的 research、interview focus 分别解析真实资产引用，不能以存在任一 Resume Proposal 推导。
2. 修复 Tauri close 生命周期，确保窗口关闭时整个 sidecar worker 退出，并以 PID/端口回读重复验收。
3. 将自然语言目标路由接到默认内置 Run，并把方法 Skill 正文/版本来源实际绑定到模型上下文；手动下拉保留高级覆盖。
4. 给内置 Run 增加独立结构化 Ask 能力，并和 CareerTask 的证据问题面板分开验收。
5. Reset cleanup manifest 纳入 `python_agent_sessions`，以隔离 canary + 备份/恢复 gate 验收。
6. 之后再验证 scored Job Queue、Resume/Interview 共享资产和真实网站执行器；每片继续分开标 Owner acceptance。
