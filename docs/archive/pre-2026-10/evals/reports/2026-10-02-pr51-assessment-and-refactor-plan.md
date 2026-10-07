> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# PR #51 设计对照评估与下一轮重构方案

日期：2026-10-02。状态：**SOURCE ASSESSMENT / REFACTOR PLAN；独立测试结果另行记录**。

设计基线：[PR #51](https://github.com/avabbbb/OfferU/pull/51)，head `dea9f13cbac6961a38e19e426d7f89253a3798cf`。已读取该提交的 `career-operations-loop.md` 和 `offeru-career-os-blueprint.html`；本地只读快照位于 `H:/tmp/offeru/pr51-review-20261002/`。GitHub 网页抓取的 main/branch 内容可能缓存，评估以 GitHub API 返回的指定 commit 内容为准。

代码基线：本地 `38fdab5728f9c05ca1fc870dcd66ebdb13d98d00` + 保留的现有未提交代码。上轮的 Desktop 隔离目录和打包 PDF 浏览器修复也在其中。PR #51 目前 OPEN，只有两份设计资产；未合并、未切换工作分支。不能把 PR 中的蓝图当成当前 UI，也不能把构建物说成纯净 HEAD。

## 1. 结论

当前 OfferU 有可信的职业 Runtime 和许多独立业务模块，但距离蓝图中的连续 Career Operations Cockpit 仍有明显断点。要重构的是跨步骤的上下文、用户决策、结构化资产和产品投影；应保留 Registry、Career Truth、版本/事实门及现有 Automation 骨架。

蓝图中的界面密度、显著差异、高价值下一步可以用于指导真实页面，但它是概念演示，不是要求把 HTML 复制成产品，或用样例岗位、假分数、写死的状态替代业务。

## 2. 当前代码能证明什么

下表“产品路径”保留源码可追踪的初判，最终独立证据与三层矩阵见 [Luna 验收报告](./2026-10-02-pr51-luna-verification.md)。源码、自动回归、真实模型、自动 UI 与真人审核分别记录，不宣称真人 PASS。

| 蓝图结果 | 代码层 | 产品路径初判 | 关键证据与断点 |
| --- | --- | --- | --- |
| 一个 OfferU 自动组合业务 Skill | 部分 | PARTIAL | `agent_skill_registry.py::resolve_run_skill` 仍按 slash/已选 Skill 解析；AgentPanel 默认 discovery 并提供 Skill 下拉。外部 Skill 的宿主路由已有指导，内置 Agent 只拿选定工具集 |
| Skill 提供完整方法和 workflow | 部分 | PARTIAL | `directory_skills.py` 解析 frontmatter 注册工具，没有保留正文/引用路径；embedded host `_system_prompt` 只加入 Skill 名称和 description。与一套可加载方法 Skill 有差距 |
| 第三方 Skill composition | 有边界契约 | PARTIAL | `agent_skill_projections.py` 允许宿主组合方法 Skill，候选经 Registry 持久；当前没有实际跨 Skill、跨回合 provenance 连续性验收，内置 host 也无同等加载证明 |
| 完整 Profile 与可见 evidence | YES | PARTIAL | Profile/sections、CareerSource、Memory Inbox、CareerLedger 与无简历访谈基础存在；首屏仍以 resumeArchive 和字段完成统计组织，目录发现/授权 memory→完整建档需验收 |
| 决策 Ask 与 adoption 分离 | 有批准边界与问题面板 | PARTIAL | 外部宿主原生 Ask 有契约，CareerQuestionsPanel 已展示 CareerTask 的问题/候选证据，Resume UI 有具体改动审核；内置 Run 能主动发起独立决策 Ask 尚未证明。PendingProposalReview 仍展示 Operation 与参数 |
| 一次简历按 section 审核 | YES | 待测试 | workspace 支持原文、建议、理由、fact gates、版本、整组展示内容审核；需要验证长简历时点击数、逐段采用和人工编辑 stale，而不是再从零建系统 |
| 每日发现→去重→排序→选择 | 部分 | PARTIAL | search sources、批量评估与 triage 存在；JobsPage 主要是 inbox/picked/ignored 和 pool/filter，未发现完整 rubric 排序队列产品路径；scan_jobs 仍标缺采集工具 |
| Comparable/Delta/Evidence Map | YES | 部分可达 | RoleIntelligencePanel 展示信号、样本与证据。Job 页 preparationProgress 会将某些无 benchmark 的 completed task 标为“岗位基准分析已完成”，需优先复现并修正 |
| 同一 Benchmark 驱动简历/面试 | 面试 YES，简历部分 | PARTIAL | 面试 Focus 返回 benchmark_run_id；resume optimization/context 主要引用 JobResearchRun/research_snapshot，没有看到共同 benchmark ID/version 固定引用的完整链路 |
| Company/Team/People intelligence | 有 research dossier | PARTIAL | job_research.py 有公司/岗位 scopes 和来源 schema；还需统一长期 Job 侧情报投影、unknown、每轮反问及观察回写，不另建公司 CRM |
| prepared/filled/reviewed/submitted/receipt | 部分 | PARTIAL | ApplicationAttempt 已有 resume_version_id 和阶段事件；application_actions 是 preview，connector registry 明确 execution_available=False，不能将预演或登记计为站外完成 |
| BOSS 三层能力 | 上游与适配存在 | PARTIAL | 当前 boss adapter 包装的是 boss-agent-cli，只读 search/detail 加进展同步；PR 文本引用 jackwener/boss-cli 是另一个项目，不能把命令或风险结论混用 |
| 分轮面试→逐题复盘→题库/故事/弱项 | 有多套基础 | PARTIAL | career_interviews、AI interview、interview experience、Career Learning 都有代码；get_interview_career_context 主要读 CalendarEvent、Job Assessment 和 learning 摘要，没有完整 submitted version+benchmark+team+story bank 组装证明 |
| 全清 / 历史蒸馏继续 | 有底层 | PARTIAL | reset 清单遗漏 python_agent_sessions 的源码风险；memory_distiller 是候选蒸馏，尚非全业务历史节点/归档/展开/刷新完整路线 |
| 当前原生 Desktop + 真实模型 | 有新构建 | 待测试 | 上轮前端/Rust 已构建；新 sidecar 正在完成。应核对哈希、进程和隔离路径，再测实际 UI 与模型；不复用 9 月旧安装包 |

## 3. 优先整改的问题

**P0 产品正确性：不能从相邻状态推导任务成功。** `frontend/src/app/jobs/[id]/page.tsx:393` 把 decision_ready/resume_proposal_ready 等同 benchmarkDone；`:420` 又在 completed 且没有 benchmark result 的分支标成已完成。另 `resume_workspace.py:309` 把 research 和 interview_focus 都设成 `bool(proposals)`，Resume 页据此显示“已关联”。Luna 已动态执行原始进度闭包证明两条假完成分支；也通过合法 `persist_external_resume_proposal` JD-only 路径（research_run_id=None、无 Research/Benchmark/AIInterview/Artifact）证明 Packet 返回两项 true。证据是 synthetic code/service layer，未假装真实 owner UI 已通过。必须按真实 artifact/task receipt 展示完成、未做、失败或待准备。

**P0 旅程断点：用户仍替系统做路由与拼上下文。** 默认 discovery 只有 get_profile；自然语言要求跨岗位研究/简历/面试时，没有证据证明内置 Run 可以合法发现并切换任务 Skill。自定义 Skill 正文也没有进入这个模型上下文。需要真正的最小 Skill 方法加载与有界组合，仍由 Runtime/Registry限制权限。

**P0 资产断点：研究、简历、面试未保证共享版本。** 在 Artifact 数据结构里写“已研究”不足以保证三个模块引用同一 Job、benchmark、Profile snapshot 和 Resume Version。这里要补引用链和 stale 检查，而不是重新搜一次得到另一套解释。

**P1 执行断点：外部能力仍只是 read/preview。** search/status、application preview、receipt/progress、登录和填写必须分别验收。没有 executor 就明确缺口；页面接管可以作为诚实的部分能力，但不能冒充一键投递。

## 4. 重构顺序：一次只闭环一个纵向切片

| 顺序 | 用户出口 | 直接修改范围 | 验收与前置 |
| --- | --- | --- | --- |
| S0 真实基线与失败诚实展示 | 当前 Desktop 能启动、对话、关窗/重启，用户知道哪些未完成 | `sidecar_entry.py`、Tauri launcher、AgentPanel/recovery、Job preparationProgress、resume workspace artifact projection、reset、对应测试 | 新包身份/隔离→真实模型 tools→持久 session；关窗不遗留拥有端口的 worker；无真实研究/Focus 不显示关联；完整业务 reset 覆盖新 session；先修实测阻断，保留修前证据 |
| S1 一个 OfferU：建档到可用 Today | 用户给目录或仅给背景，Agent 做访谈，Desktop 展示来源/候选/目标/下一步 | Skill registry/projections/directory loader、embedded host、existing Profile/onboarding、CareerSource/Memory Inbox、Today | 方法正文/版本可验证加载；自然 intent 路由不要求手选 Skill；显著选择用结构化 Ask；已授权准备无需几十次点击；确认后才入 Profile |
| S2 一批岗位到可解释当日队列 | 从一个官网 ATS 和 BOSS 可用只读路径取新岗位，去重筛选、评估排序、用户选当日目标 | existing job_sources、batch evaluations、Job 查询/JobsPage/Today、Automation event/rule/task | 小规模真实来源，时间/失效/unknown/硬门槛/score reason；同一 Job 去重；不把旧库排序称每日新发现，不把分数称成功概率 |
| S3 一个 Job：共享研究到可采用简历 | 同类要求、独特点、公司/团队情报映射本人证据，准备并审核一版岗位简历 | role_intelligence、job_research、resume preparation/workspace、Job/Resume UI | 固定 benchmark/research refs 与内容指纹； section Before/After/Why/来源；unsupported/stale 阻止采用；用户审核少量语义决策；当前 Job 绑定正确版本 |
| S4 同一个 Job：准备到真实进展 | 按需配置一个实际 connector；填写/审核/用户提交/receipt→唯一投递状态 | application_actions/registry、现有 extension 或正式 browser connector、ApplicationAttempt/StageEvent、progress association/UI | 先只一个网站/来源，上传与提交独立授权；保留字段来源及回读；receipt 未核验不算成功；无 connector 明确接管；邮箱/BOSS 先 candidate 去重关联 |
| S5 同一个 Job：面试信息反哺下一轮 | 当前轮次准备/反问，真实问答复盘，经审核后改变下一轮重点 | career_interviews、ai_interviews、Career Learning、Interview/Job panels、现有 artifact/context 投影 | 同 benchmark、实际 submitted ResumeVersion、Team intelligence；题目/故事/弱项的来源和轮次；真实回答≠建议答案；动态反问答案回写候选；下一轮展示引用变化 |
| S6 长期返回：蒸馏、刷新与跟进 | 几天后回来保留已接受结果，旧历史可展开，新现实已刷新 | memory_distiller/consolidation、history/session/reset、Career Director、Today/Job history | reset canary+备份/恢复；历史节点保留决策/证据/结果/receipt；过时不等于删除事实；重联系读取 last-contact、开放状态、回复/材料变化、cooldown 和 outcome |

依赖：S0→S1→S2→S3；S3 的稳定资产引用供 S4、S5 消费；S6 在这些记录真实存在后完善。每片同时交付 Runtime 路径、Agent 行为、产品 UI 与回读，避免数据库/API/前端各自长期半成品。可以先用一个真实目标 Job 验证 S3/S5，不以实现几十个平台作为前置。

每片明确停止点：用户能完成对应结果、保存/重启/复核可用、安全和数据门满足；之后进入下一片。缺账号/真实面试/人类批准分别记录 NOT_TESTED/BLOCKED，独立可执行的测试继续。

界面沿用现有 Today、Profile、Job Queue/Workspace、Resume、Pipeline、Interview 页面就地收敛。蓝图的 Apple 极简方向落到清晰层级、少量主动作、段落差异和状态变化，避免只换皮肤。开发诊断如 event 名、strategy pack、Operation 参数移到按需诊断；业务首屏使用用户能理解的行动、原因和待决定项。Profile 既有“复制 Prompt→去 AI 识别→粘 JSON”手动入口可作为明确高级/降级路径，不能冒充已验收的自然建档主路径。

## 5. 数据与架构处理

不改变 Python Career Runtime / React / Tauri 的分工，不增加新 backend、无限 Agent loop、Agent-only workspace 或 SaaS 多租户。Operation 仍是执行 authority；Skill 包负责方法、上下文和交接，不直接改 DB。

优先复用 Profile/sections、CareerSource、LearningObservation、RoleBenchmarkRun、JobResearchRun、ResumeVersion、ApplicationAttempt.resume_version_id、StageEvent、CalendarEvent/AIInterview 与 CareerTask。先补类型化上下文与真实引用，不根据蓝图里的每个框新建一张表。

必要的新持久字段才走 schema migration；具备 backup→upgrade→integrity→smoke→restore 验收，旧 Profile/简历/投递/面试不丢失。Application 的准备/填写过程放在已有执行事件或材料状态，与真实 Application stage 分开；相同事实只维护一份。

外部宿主与内置 Agent 的能力差异保留：外部可用宿主 native Ask/web/Skills，内置需要自己的交互与工具绑定。不能用一份 generated SKILL 的文字宣称所有宿主和新 kernel都已执行同等方法。

优先复用现有 CareerQuestionsPanel 与 CareerTask 问题/回答投影，补内置 Run 的请求/返回路径，而不是另建一个问题库。职业事实补证按 Candidate 审核；定位、结构、偏好答案保留为 user decision，不强制升级为事实提案。共享准备上下文还需带真实 reference/submitted Resume Version，外部 draft 的 baseline_rows 目前从 Profile 构造，不能仅凭该字段证明保留了原简历措辞/版式。

## 6. 独立测试任务

按用户要求启动 **GPT-6 Luna / max** 子代理。它只负责测试与证据报告，不修改产品代码或扩大设计。父代理负责构建与最终评估；测试子代理负责其独立临时目录及 `docs/evals/reports/2026-10-02-pr51-luna-verification.md`，双方不同时控制同一个 Desktop 或端口。

先检查真实包装/Runtime/Key引用/隔离及可用产品入口，再围绕关键断点运行必要自动回归和真实模型任务。每项记录 Source YES/NO、Product WORKS/PARTIAL/BROKEN、Owner PASS/FAIL/NOT_TESTED，并另列 fixture/live-model/human-UI 层级。UI fixture、kernel smoke、模型的自报都不是 owner PASS。

重点：默认 Skill 路由与方法加载、决策 Ask、真实 multi-tool loop、protected action 留审、session/restart、无简历建档、队列排序、无 benchmark 的虚假完成、共享资产引用、section review、三层 BOSS 能力、Application preview≠执行、面试学习和 reset session canary。真实简历/Memory 精确范围、真实账号及真人批准未具备时不得自行扩大。

输出同时回答“今天开始求职会在哪被迫离开 OfferU”：目前源码初判包括多源岗位发现与排序、站外登录/注册/投递/发送、完整逐题复盘/故事库，以及必要决策的原生交互；已有外部 Agent 是核心使用方式，不将用户主动选择 Agent 误算为产品失败。最终结论由实际测试更新。

## 7. 本轮边界

本轮交付评估、可执行重构顺序和测试结果。方案不是已完成改造，设计 PR 未被自动合并，也不新开无关 PR。测试发现的小范围阻断修复单独报告；整模块缺口只进入明确切片，不顺手重写全部产品。源码可用程度与真人验收结论绝不合并。

测试构建记录：首次直接 `cargo build --release` 未启用 Tauri 静态资源协议，后端 ready 但窗口访问开发 URL 被拒绝，计为父代理 setup INVALID；已改用 `cargo build --release --features tauri/custom-protocol --offline` 重建，Luna 复核 hash 后确认静态前端和 packaged sidecar 均能启动。这不等于干净机器安装通过。正式包正常关窗也复现二级后端 worker 仍占 8766：app PID 9140/launcher退出、worker PID 42928存活且路径确属本次 portable。这是独立 lifecycle FAIL，不能被“health ready”或首轮 INVALID 掩盖；新启动不得接受不属于新实例的旧 health。

Luna 已报告的正式原生模型证据：默认 discovery 的自然语言岗位请求仍只调用 get_profile，不能自动路由；手选 career_director 后 Run `run_5e1e2f4dd0834004bd0a3e48784a3050` 连续执行 get_career_snapshot/get_daily_career_context 并留审计。明确要求结构化策略 Ask 的另一次实际回合仅输出普通 Markdown 选项，未调用交互工具或展示选项控件；CareerTask 问题面板仍是不同的既有能力。这些结果支持 S1 的路由/交互优先级，不把纯文本等待、手选成功或只读 smoke 计为完整旅程。隔离 reset helper canary 也证明旧 pi_sessions/uploads 文件被删除而 python_agent_sessions 文件保留；全量 Registry 批准、业务清空与恢复仍未测试。

受保护动作也已进入真实内置模型测试：`run_bc963e55a140450d9466ecb22659cbb5` 经 add_profile_evidence 形成待审 Proposal，Run waiting_confirmation，ProfileSection仍0，模型没有自行审核；用户批准和最终采用未测。定向26个后端用例最终通过，包含两项从共享 H 测试库污染中改用各自全新 temp root 后重跑；实际 engine 路径已校验，未清理共享测试目录，不把该 fixture 失误记作产品 bug。

最终收尾：待审 L2 Run 跨全新 WebView profile 的重启仍可见，随后通过普通 Run 取消变为 cancelled，ProfileSection保持0；没有点击提案批准/拒绝。正确包关窗遗留 worker 已复现2/2，测试代理仅停止经PID/路径核验的本次worker。主代理核对了动态投影脚本、合法JD-only脚本与输出、reset helper、真实截图及最终进程记录；测试结束本次包进程和7410/8766监听均为空。完整Goal A/B、真实资料/账号/面试、人类审核、PDF/安装/升级仍未通过验收。
