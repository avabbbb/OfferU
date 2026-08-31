# OfferU Public Release Goal

## Autonomous Production Readiness Program

生效日期：2026-08-30

## Final Goal

OfferU 的唯一发布终点是：

```text
OFFERU_PUBLIC_RELEASE_READY
```

Public Release 指一个可公开分发的 local-first 个人 Career OS。陌生用户只拿安装包、无需开发者陪同或终端操作，能够独立完成：

```text
安装 / 首次启动
→ 建立或导入 Career Profile
→ 保存目标岗位并自动开始准备
→ 使用 Today / Pipeline / Job Context
→ 查看 Role Intelligence 与 Evidence Gap
→ 审核、手动编辑并导出岗位化简历
→ 形成 Application Packet 并维护真实投递阶段
→ 完成针对性模拟面试与 Debrief
→ 审核 Learning Candidate
→ 让 Career Profile 持续演进
```

产品还必须可安装、升级、迁移、备份、恢复、诊断、失败、重试、审计和卸载。代码能运行、构建通过、单次 E2E 通过或 Replay/Fixture 闭环均不等于 Public Release Ready。

## Product North Star

OfferU 是 local-first 自动化 Career OS。它持续知道用户是谁、正在投什么、当前发生了什么、岗位真正看重什么以及下一步最值得做什么。系统自动完成研究、整理和准备；用户负责事实确认、关键决策和真实世界不可逆行为。

每个进入本 Release 的改动都必须明显改善至少一项：

- 自动化；
- 可靠性；
- 信息复用；
- 决策质量；
- 用户操作成本。

不能减少用户手动维护求职流程成本的功能不进入本 Release。

## Stable Product Model

一级产品结构收敛为：

```text
Today
Pipeline
Job / Opportunity
Profile
```

Agent 是全局能力；Memory 是 Profile 的演进机制；Resume、Role Intelligence、Research、Application Packet 和 Interview 均属于 Job Context。Today、Pipeline、Agent 不拥有独立业务事实，只投影 OfferU Domain Runtime 中同一份 Career Truth。

## Stable Technical Boundary

```text
TypeScript / React = UI、交互、本地 client state
Python / FastAPI = Career Domain Runtime、Operation Registry、Automation、Data、Business State
Tauri / Rust = Desktop shell、进程生命周期、OS 集成、Installer / Update boundary
AgentRuntimeProvider = Pi / Codex / DSH / future harness 的 provider-neutral seam
```

- 不进行 Python → TypeScript 全量重写；
- 不新增第二套 Node backend；
- 不因 Harness 的实现语言迁移 Career Domain Runtime；
- 当前产品仅为本地单人版，不引入 SaaS、多租户、账号、组织、Billing 或云同步预埋。

## Stable Authority Model

```text
Agent Runtime = Reasoning Authority
Operation Registry = Capability / Execution Control
OfferU Domain Runtime = Career Truth
User = High-risk Approval Authority
```

自然语言声称成功不构成业务事实。只有以下链路完成后才算状态发生改变：

```text
Operation
→ validation
→ permission
→ execute
→ persisted event / state
→ audit
```

GUI、CLI、TUI、Slash Skill、Agent、Automation、Plugin 和 Browser Extension 的业务写入都必须经过同一 Operation Registry。外部提交、邮件、私信、发布、购买和接受 Offer 不得自动执行。

## Automation and Truth Invariants

唯一 Automation 模型是：

```text
Event → Rule → CareerTask → Agent / Runtime → Operation
```

- Stage 由 Career Event 推导或正式 Operation 更新，React 不维护第二份状态；
- `INTERVIEW_INVITED` 等事件必须一致投影到 Today、Pipeline、Job、Timeline 和 Interview preparation；
- 所有关键写操作至少保证 exactly-once business effect，覆盖重复事件、双击、刷新、网络重试和重启；
- CareerTask 支持 start、status、events、cancel、result、retry 和 resume，状态为 queued、running、waiting、blocked、completed、failed、cancelled；
- Agent 推断、外部信号和面试学习只能先成为 Candidate / Learning Candidate，不得静默改变 Career Truth。

## Core Product Journey

### First Run

Launch → Welcome → explain OfferU → create/import Profile → add first Job → automatic preparation → Today。正常路径不得要求终端，也不得让用户理解 MCP、Operation Registry、Codex、Pi、DSH、FastAPI 或 SQLite。

Onboarding Golden Path 必须 100% 通过，并达到 0 uncaught exception、0 blank page、0 developer-only blocker。Today、Pipeline、Profile、Job、Resume 的空状态必须解释原因并给出下一步。

### Today / Pipeline / Job

- Today 从 Application、Event、CareerTask、Candidate、Interview 和 Role Intelligence 派生，展示 completed、needs attention、next best action 和 failed/blocked tasks；
- Pipeline 是 Application State 的主要视图，至少展示 Job、Stage、Next action、Last event、Priority；
- Job Detail 收敛 Overview、Role Intelligence、Evidence Gap、Application Materials、Interview、Timeline；
- 任何页面出现不同阶段都是 Release Blocker。

### Resume Workspace

Truth chain：

```text
Career Evidence → Master Resume → Job Tailored Resume → Application Packet
```

正式工作区必须提供 structured content、live preview、manual edit、reorder、visibility、autosave、version、proposal diff、accept、reject、edit then accept、accept all、stale detection、design controls 和 PDF export。Original 不被 AI 静默覆盖。

每个 Proposal 显示 Before、After、Why、Target requirement、Career evidence。事实门将内容分为 SUPPORTED、WEAK_EVIDENCE、UNSUPPORTED；AI 不得发明 metric、technology、company、responsibility scope 或 achievement，UNSUPPORTED 不得进入正式事实。用户修改同一内容后旧 Proposal 必须变为 STALE，禁止覆盖。

Release Gate：autosave stress success ≥99.9%、0 lost edit、0 stale overwrite、100% unsupported-fact enforcement，以及中文、英文、中英混排 PDF 全部通过。

### Role Intelligence

Agent 负责搜索、语义提取和分类；Runtime 负责去重、cohort、frequency、Delta 和持久化。LLM 不生成市场统计数字。Fixture / Replay 必须显式标记，不得冒充实时数据。

若公开声称实时岗位情报，至少一个真实 External Research Provider 必须完整 E2E 通过，并以 10 个跨公司、job family、seniority 的岗位验证 raw collection → dedupe → cohort → comparators → Delta；结果展示 sample size、date range、sources 和 confidence。否则该能力只能标记 Experimental / Demo。

### Interview and Learning

Interview Focus 来自 Role Delta × Career Evidence Gap × Previous Interview Learning，而非通用题库。Interviewer 不自动表扬、不替用户补答案、不提前 coaching；模糊、无证据数字或责任冲突都应继续追问。

Debrief 的关键评价必须引用 actual transcript，并关联 focus capability 与 career evidence。Interview learning 只进入 Learning Candidate。长期 Memory 支持 candidate、verified、derived、conflicted、superseded、archived，并保留 source、evidence、confidence、created_at、last_verified_at、history。PotentialHypothesis 永远不能自动变成 Career Fact。

## Data Safety Definition of Done

- 所有 schema 变化有可重复 migration path，并使用至少 old fixture DB A、old fixture DB B、current DB 验证 previous release → current；
- 升级链为 backup → migration → integrity check → application smoke；失败不得留下半升级数据库；
- 正式备份使用 SQLite Online Backup API、VACUUM INTO 或等价一致性快照，不把运行中直接复制 DB 作为唯一策略；
- 备份包含 DB、相关本地资产和版本元数据；
- Restore 必须真实执行 create data → backup → mutate/delete test state → restore → restart → verify，连续 3 次通过；
- 恢复后 `PRAGMA integrity_check` 返回 `ok`，且 core Golden Path 通过；
- 用户可结构化导出 Profile、Jobs、Applications、Resume data、Interview history；
- Reset Demo 与 Delete user data 明确分离，禁止误删真实 Workspace。

## Security Definition of Done

- secret scan、dependency audit、permission audit、logging audit、Tauri capability audit、CSP audit 全部执行；
- 源码、日志、diagnostic bundle、Playwright trace 和 Temp 文件不泄露 API key、OAuth token、password、session cookie、keychain secret；
- 使用 `OFFERU_RELEASE_CANARY_SECRET_...` 跑完整 Agent、API、error、diagnostic、export、browser 路径，最终 0 canary leak；
- 默认日志不记录完整 resume body、email body、interview transcript、phone 或 personal email；
- Tauri production bundle 使用 restrictive capabilities、restrictive CSP、无不必要 remote script，只授权确需的 host、path 和 OS command；
- Release 时 0 未解决 Critical、0 未解决 High；必须接受的 High 需要 SECURITY_EXCEPTION、risk、reason、mitigation、owner；
- 明确隐私披露：哪些数据只在本地、哪些会发给模型、第三方读取什么、摄像头/麦克风如何处理、如何导出和删除；
- email、microphone、camera、external model 均有明确授权。

## Reliability and Diagnostics Definition of Done

- Application logs、AgentRun logs、Operation audit、CareerTask events、Error events 可由 run_id、task_id、operation_id、error_id 关联；
- Diagnostic Bundle 包含 app version、OS、provider health、doctor、sanitized recent errors、configuration metadata，不含 secret；
- Doctor 检查 DB、DB integrity、Backend、Desktop bridge、Agent runtime、LLM/provider、Storage permissions、Optional integrations、Version consistency，并在核心可用时返回 `CORE_READY`；可选 Provider blocked 不应让核心失败；
- 强制退出和恢复覆盖 running/waiting task、resume autosave、interview in progress、candidate pending，达到 0 corrupted state、0 phantom completed task、0 duplicate commit；
- 超过 2 秒任务显示 status、stage/progress、cancel 和 failure；
- 固定 Reference Environment 记录 cold startup、warm startup、Today、Pipeline、Job、Resume load；
- SLO：cold usable ≤8s、warm ≤5s、cached navigation p95 ≤1.5s、immediate feedback ≤200ms、background progress ≤1s；
- Soak 至少 2 小时或 100 representative cycles，0 crash、0 corrupted DB、0 duplicate mutation、0 unbounded queue growth；warm-up 后 100 cycles RSS growth <20%，超出必须解释或修复。

## Test and E2E Definition of Done

Testing Pyramid 同时覆盖 Unit、Contract、Integration、E2E、Failure、Migration、Packaging。确定性测试优先覆盖 Fact Gate、Delta、Event → State、Today Priority、Candidate lifecycle、idempotency、migration helpers。Operation Registry 机械验证 manifest、schema、side_effects、permission、dry-run、output contract；Replay/Fake Agent contract 覆盖 stream、tool call、approval、cancel、failure、resume。

Playwright 只操作用户可见 UI；除 fixture setup 外不依赖 CSS class、实现函数或直接 DB mutation。每个 E2E 使用 isolated DB、workspace、browser state；失败保留 trace、screenshot、console、network summary，成功不保留无意义 trace。

必须覆盖：

1. New User：install/launch → onboarding → Profile → Job → automatic Role Intelligence → Resume Candidate → Today → Resume Workspace → review/manual edit → Application Packet → Pipeline → Interview → Debrief → Learning Candidate → Profile update；
2. Existing User：old DB migration → Today/Pipeline/existing Resume/existing Interview → new Job；
3. Failure：provider timeout/auth blocked/LLM error/backend restart/task cancellation/save failure，均 visible、accurate、recoverable；
4. Duplicate：double click/refresh/network retry/restart 只产生一次 business effect；
5. Resume Conflict：AI Proposal → manual edit → accept stale proposal 必须被阻止；
6. Data Recovery：realistic data → backup → simulated loss → restore → open app 通过。

Critical E2E 必须连续 10/10 通过，不依赖 retry 染绿；核心 Journey 随机组合至少 50 runs，first-run pass ≥98%，其余失败有明确分类且无 unknown flaky。Release Candidate 还必须通过 backend full suite、frontend typecheck、frontend production build、relevant lint、desktop production build。

## Packaging and Release Definition of Done

- 生成不依赖开发环境的 Tauri production bundle；Python Runtime 由安装包 sidecar 管理，用户无需安装 Python；生命周期 start、health、restart、shutdown 通过；
- 在无 repo、Python/Node dev env、developer config 的 clean machine 完成 fresh install、launch、uninstall、reinstall；明确用户数据保留/删除策略；
- 使用唯一版本 `OfferU x.y.z`，Backend、Frontend、Desktop、Diagnostics 版本一致；
- 验证 previous internal release → current installer → migration → launch → Golden Path；
- 如果启用 updater，更新包必须签名验证，私钥不入仓库；Windows/macOS Public Release 使用合法代码签名，不能要求用户忽略未知开发者警告；
- Release artifact 包含 installer、checksums、version metadata、release notes、known issues、license/third-party notices；
- release tag 自动执行 backend tests、frontend typecheck/build、security scan、desktop build、package；
- 先发布 `vX.Y.Z-rc.1`，每次 RC 都重新执行 Doctor、full tests、build、migration、backup/restore、critical/failure E2E、packaging、clean install、soak，不继承上次证据。

## Product Claims and Support

- README、官网和 UI 只能宣传真实验证的能力；Live Role Intelligence 未通过时只能称岗位差异分析 Beta；
- README 只有 Final Release Gate 通过后才从 POC/Internal Beta 改为正式 Release claim；
- Public QUICKSTART 只包含 Download、Install、Launch、Onboarding，开发者启动移至 DEVELOPMENT.md；
- 用户报告“Agent 不工作”时，支持人员通过 Doctor、Diagnostic Bundle、Error ID 定位 Provider auth、Backend、DB、Network 或 Task，不要求用户截图 Terminal；
- Optional Codex、DSH、Gmail、browser extension、experimental plugins 可不阻塞核心，前提是 UI 清楚标识、核心有真实可用路径且不宣传为正式能力。

## Release Gates

任何 P0、P1、Critical/High security issue、data integrity failure、backup/restore failure、clean install failure、core live provider unavailable 或 critical E2E flaky 都阻止 Release。Public Release 要求 P0=0、P1=0；P2 只有明确 workaround 且进入 KNOWN_ISSUES 才可接受。

每个重大 Workstream 完成后从 Product、Architecture、Reliability/Security 三个视角独立审查，优先寻找 state duplication、Registry bypass、silent failure、data loss risk、empty state、provider coupling 和 unverified assumption。持续扫描 direct DB mutation、Registry bypass、duplicate business state、provider-specific UI、new agent loop、duplicate domain model。依赖方向保持 UI → API/Operation → Domain → Data。

## Final Human Acceptance

一个从未参与开发的人只拿 installer，不看工程 README，必须独立完成安装 → Profile → Job → 自动准备 → Today → Resume edit → Pipeline → Interview → Learning。若需要终端、直接改数据库、避开按钮、刷新两次或忽略错误，则为 `NOT RELEASE READY`。

## Repository as System of Record

长程执行不依赖聊天上下文。仓库维护：

- `GOAL.md`：稳定 North Star 与 Definition of Done；
- `STATUS.md`：当前 Phase/Gate、PASS/FAIL/BLOCKED_EXTERNAL/PRE_EXISTING_FAILURE/NOT_VERIFIED、最后通过检查点、下一动作；
- `QUALITY_SCORE.md`：各领域持续评分；
- `RELEASE_CHECKLIST.md`：每项 Release Gate 与证据；
- `HANDOFF.md`：当前实现边界与续作入口；
- `KNOWN_ISSUES.md`：P0–P3、workaround 与 release impact；
- `ARCHITECTURE.md`、`SECURITY.md`、`RELIABILITY.md`：稳定边界和当前验证状态。

## Autonomous Execution Rules

进入 Production Readiness 后 Feature Freeze。允许完成核心闭环、UX、可靠性、性能、安全、诊断、安装升级、数据恢复和测试；不新增社区、Feed、Like、Follow、企业租户、Billing、云同步、新 Agent Framework、大型业务模块或社交能力。

循环：Inspect → Reproduce → Implement → Targeted Test → Self Review → Integration Test → Browser Test → Failure Test → Regression → update STATUS/QUALITY_SCORE → 继续最高优先级 blocker。

同一修复假设连续失败两次，停止 patch-on-patch，回到 last passing checkpoint，重新检查根因，撤销该错误方向的局部修改并采用新方案。

优先级：Data loss/Security → Core Journey → State consistency → Reliability → Resume/Product usability → Live provider → Performance → Packaging → Cosmetic。

只有 Credential、真实外部不可逆写入、不可恢复的用户数据删除、法律/隐私策略、签名证书或第三方生产账号允许人工介入。普通测试失败、build 失败、UI bug、migration bug、race condition 和技术债都不是停止理由。

## Final Status and Completion Report

本 Goal 只有两个合法终态：

```text
OFFERU_PUBLIC_RELEASE_READY
BLOCKED_BY_TRUE_EXTERNAL_RELEASE_REQUIREMENT
```

最终报告必须给出 Release version、Product capabilities、Architecture、实际 Test matrix、每条 Golden Path 证据、Migration matrix、Backup/restore、Security、Soak、Performance、Clean install、Upgrade、Signed artifacts、optional integrations、Known Issues 和唯一 Final verdict。

唯一完成标准是：陌生用户能否安全、稳定、独立地使用 OfferU 完成真实求职工作，并在失败、重启、升级和数据恢复中始终保持对职业事实与求职状态的控制。
