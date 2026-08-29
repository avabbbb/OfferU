# OfferU Internal Beta Readiness Goal

> Status: accepted execution goal
> Scope: local-first, single-user Career OS
> End state: `INTERNAL_BETA_READY` or `INTERNAL_BETA_READY_WITH_EXTERNAL_BLOCKERS`

本文件定义 OfferU 的终点和验收契约，不是按功能拆开的 TODO 清单。实现时同时遵守 `AGENTS.md`、`CONTEXT.md` 与 accepted ADR；它们分别约束开发行为、领域事实和架构边界。

## North Star

将 OfferU 从当前开发状态推进为一个真实可上手的 Local-first Internal Beta：一个不了解代码结构的内部测试用户，可以自己启动应用，理解产品，建立或导入 Career Profile，保存目标岗位，让系统自动完成岗位分析、材料准备、投递进度维护、面试训练和面试后的学习回流，并在失败或重启时不破坏数据。

用户只需要：

- 定义目标；
- 补充只有自己知道的信息；
- 审核重要事实与候选修改；
- 批准高风险操作；
- 做最终职业决策。

首要判断标准：

> OfferU 是否减少了用户重复维护求职流程，同时更清楚地告诉用户现在最重要的下一步？

## Autonomous Execution

默认循环：

```text
Inspect → Implement → Test → Run → Browser verify → Fix → Regression test → Continue
```

从本 Goal 开始，不在普通切片、Gate 或技术选择处停下来等待确认。允许自主修改 Goal 范围内代码、补测试、启动本地服务和 sidecar、执行 API/fixture/replay/browser 验收、更新 `GOAL.md`、`STATUS.md`、`HANDOFF.md`、内部文档和必要 ADR，并清理本轮产生的临时文件。

只在以下情况中断，并先标记 `BLOCKED_EXTERNAL`，再完成所有不依赖该阻塞的工作：

- OAuth、API key、ChatGPT/Codex Login、Gmail 或第三方账号凭据；
- 正式投递、发送真实邮件、对外发布/私信、接受或拒绝 Offer 等真实外部写入；
- 删除真实用户数据、不可恢复地覆盖用户文件或 destructive migration。

## Product Shape

一级入口收敛为：

```text
Today
Pipeline
Job / Opportunity
Profile
```

Agent 是全局能力，不是第五个业务模块。Memory 是 Profile 的演进机制。Role Intelligence、Research、Resume、Application Packet、Interview 都是 Job 的上下文资源。

### Today

Today 是实时 projection，不拥有独立业务事实。它综合 Career State、Application Event、CareerTask、Candidate、Interview 和 Role Intelligence，展示：

- OfferU 已经完成的工作；
- 求职状态发生的变化；
- 需要用户确认或审核的事项；
- 今天最值得做的下一步；
- blocked / failed automation 及可执行动作。

### Pipeline

Pipeline 是所有目标岗位的主状态面板，至少展示 Job、Current Stage、Next Action、Last Event、Priority 和更新时间。Pipeline、Today、Job Detail 必须使用同一份 Application/Event Truth，禁止各自维护状态副本。

### Job Detail

每个 Job 统一组织：

```text
Overview
Role Intelligence
Evidence Gap
Materials / Application Packet
Interview Focus / Session
Timeline
```

### Profile

Profile 只维护长期 Career Model：Experience、Achievement、Skill、Evidence、Preference、Goal、Interview Story。Memory Candidate 以 `Pending Updates` 进入 Profile，不能把聊天摘要直接升级成 Career Truth。

## Core Loop

```text
Observe
↓
Create Event / Candidate
↓
Understand current state
↓
Plan next task
↓
Execute automatically when safe
↓
Ask user only when necessary
↓
Commit verified state
↓
Learn from outcome
↓
Observe again
```

典型链路：

```text
Job Saved
↓
Role Intelligence
↓
Career Evidence Gap
↓
Tailored Resume Candidate
↓
Application Packet
↓
Application Event
↓
Interview Focus / Interview
↓
Debrief
↓
Learning Candidate
↓
Profile evolves
```

这条循环优先于增加新的独立功能。

## Stable Domain Model

产品优先围绕少量稳定对象表达：

```text
Profile
Job
Application
Artifact
Event
Candidate
CareerTask
```

新的领域概念必须证明无法由这些对象表达。不得因为一个新 AI 功能创建平行状态模型；`TodayState`、`PipelineState`、`AgentState`、`JobState` 不得复制同一业务事实。已有表可渐进演进，不要求本轮一次性重构。

## Truth, Agent and Automation

```text
Agent Runtime
= reasoning / planning / tool selection

Operation Registry
= capability discovery and execution control

OfferU Domain Runtime
= Career Truth

User
= high-risk approval authority
```

Agent 不拥有 Career Truth，不能用自然语言声称成功。只有经过 Operation Registry、由 Runtime 成功提交的 Operation 才能改变正式状态。GUI、CLI、TUI、Skill 和本地 Coding Agent 都必须走同一 Operation Registry，不得直接写数据库、绕过 dry-run/确认/审计或复制业务逻辑。

Agent 每次只获得：

```text
Current Context Snapshot
+ Operation Manifest
+ Relevant Retrieved State
```

需要更多数据时按需查询，不默认把整个 Profile、Job 和 Memory 数据库塞入 prompt。

自动化统一为：

```text
Event → Rule → CareerTask → Agent / deterministic runtime → Operation
```

不要创建第二个 Automation Agent。低风险读取、研究、计算和 Candidate 生成可以自动执行；正式事实修改遵循现有风险策略；外部不可逆行为必须由用户明确操作。

## Internal Beta Gates

### A. 启动、Onboarding 和 Empty State

首次启动必须让普通用户完成：

```text
Welcome → What OfferU does → Create / import Profile → Add first Job → Ready
```

首屏用用户语言说明 OfferU 会持续维护职业资料，并围绕目标岗位完成研究、材料准备、进度整理和面试训练。Operation Registry、MCP、Pi、Codex、DSH 等技术词只进入 Developer/Advanced Settings。

Today、Pipeline、Profile、Job 和其他主要页面必须有可操作的 Empty State；不得显示空白页、开发者 JSON、Python/SQLAlchemy stacktrace、无限 loading 或无响应按钮。

### B. Demo / Fixture Workspace

提供稳定且隔离的 Demo/Fixture Workspace，一键加载并明确标记 Demo、Fixture、Test Data：Demo Profile、Jobs、Pipeline、Role Intelligence、Interview 数据；可一键重置且不影响真实用户数据库。Fixture/replay 可用于没有外部凭据时的产品验收，但不得伪装成实时市场数据。

### C. Agent Runtime 和 Provider Health

主 Agent UI 统一经过：

```text
Agent Run API → Run Coordinator / CareerTask → AgentRuntimeProvider
```

Provider 由 Adapter 隔离：Pi、Replay、Codex、DeepSeek Harness、future providers。UI 和业务逻辑不得出现 provider-specific 分支。

所有 Provider 转换成统一 `AgentRunEvent`：

```text
run.started
assistant.delta
assistant.message
tool.started / tool.progress / tool.completed / tool.failed
approval.requested / approval.resolved
task.progress
run.completed / run.failed / run.cancelled / run.blocked
```

设置或 Doctor 必须显示每个 Provider 的 Ready、Blocked、Experimental 或 Not verified。一个 Provider blocked 不得让 OfferU 整体不可用；至少一个真实可用 Provider 或 replay 路径必须完成核心链路。不得以空数组或 `status=success` 掩盖 Provider 失败。

### D. Job Saved 自动准备

保存 Job 后自动生成 `JOB_SAVED` Event，并按 Rule 创建 CareerTask，自动推动：

```text
Role Intelligence → Evidence Gap → Resume Candidate → Interview Focus
```

用户不应分别手动点击“分析岗位、生成 Gap、优化简历、准备面试”才能获得基本准备结果。任务状态、进度、取消、重试和失败原因必须可见。

Role Intelligence 中 Agent 可负责 search、extract、classify、verify；Runtime 负责 dedupe、cohort、frequency、Delta、ranking、persistence。统计数字不能由 LLM 凭感觉生成。UI 至少显示 benchmark size、freshness、source mode、Distinctive/Common/Missing、Candidate Evidence Gap；Signal 可展开看到 JD evidence、sample count、market frequency、comparator sources、candidate evidence 和 confidence。

### E. Materials 和 Application Packet

Role Delta 与 Career Evidence 生成 Tailored Resume Candidate。每个修改都能说明 Before、After、Why、Target requirement 和 Career evidence；不得静默覆盖正式 Resume。

用户必须能查看、逐条接受/拒绝、接受全部、撤销；接受后生成结构化 Resume Version，不使用 `final_final_v2` 之类非结构化版本名。每个 Job 统一拥有 Application Packet：Job Snapshot、Research、Role Intelligence、Resume、Application Answers、Interview Focus。

### F. Application、Event 和 Pipeline

Application 采用 `Event → State`。至少支持：

```text
saved / preparing / ready / applied / screening / interviewing
offer / accepted / rejected / withdrawn / archived
```

Timeline 至少记录 Job saved、Resume prepared、Application prepared、Application submitted、Interview invited、Interview completed、Rejected、Offer。状态只能由验证过的 Event 推导或提交，不能由 Agent 文本决定。

Candidate Review → Accept/Reject 后，必须同步刷新 Today、Pipeline、Job Detail、Timeline 和 Interview preparation；禁止页面状态漂移。

### G. Today 和排序

Today 必须自动分为：

```text
Already done by OfferU
Needs your decision
Next best action
Blocked / failed task
```

Priority 至少考虑 deadline、application stage、interview proximity、role importance、evidence gap、stale follow-up、user priority。确定性 Runtime 负责主要排序信号，LLM 只负责解释。Today 不创建新的事实表。

### H. Interview、Debrief 和 Learning

训练优先级来自：

```text
Role Intelligence × Evidence Gap × Previous Interview Learning
```

Interview Focus 至少覆盖 Proof、Depth、Trade-off、Scenario、Contradiction。Interviewer 与 Coach 分离：Interviewer 不谄媚、不提前补答案，模糊、数字、scope 或 Career Evidence 冲突时追问。

Debrief 必须基于真实 transcript、Focus Plan 和 Career Evidence，输出 Strength、Gap、Weak evidence、Missing metric、Reasoning problem、Next training，并能回指真实回答。结束后按 `Debrief → Learning Observation → Memory Candidate` 回流，不能直接写入“用户不擅长某项”等 Career Truth。

### I. Profile、Memory Inbox 和 Hypothesis

更新必须经过：

```text
Observation → Candidate → Evidence → Review / policy → Career Truth
```

Candidate 保留来源和证据，支持 `candidate`、`verified`、`derived`、`conflicted`、`superseded`、`archived`。Memory Inbox 清楚展示发现了什么、为什么、来源和接受后的影响，并提供 Accept、Reject、Later。Potential career direction/skill/strength 必须标记 Hypothesis，与 verified Career Fact 分开。

### J. Automation Inbox 和 Failure UX

所有后台任务统一可见于：

```text
Needs Approval / Needs Review / FYI / Completed / Failed / Blocked
```

失败必须 visible、explainable、safe retryable；Provider 401 显示“Blocked — authentication required”，而不是“没有找到岗位”。长任务显示正在研究岗位、准备材料、生成面试 Focus 等进度，并支持取消；错误提供 Retry 或下一步动作。

### K. Restart、重复和数据安全

应用重启或进程异常退出后，`running`、`waiting_for_approval` 等任务不得成为幽灵状态；重要状态可恢复并明确标记 interrupted/retryable。重复点击、刷新、网络重试不得重复写 Resume、Interview 或 Application Event。

至少提供 Export user data、Reset demo data、Backup local database、Restore local database，或提供经过验证的 backup + documented recovery procedure。自动测试必须使用隔离数据库，不污染真实用户数据。日志、临时文件、浏览器输出和 Agent events 不得打印 API keys、OAuth tokens、完整敏感邮件或系统凭据。

### L. Doctor、反馈、文档和产品文案

OfferU Doctor 或等价诊断必须检查 Database、Backend、Frontend、Agent Providers、LLM、Optional integrations，并区分 Core Ready 与 optional blocked。Release diagnostics 至少显示 app version、build mode、database path、runtime mode。

提供轻量 Report issue，保存 current page、app version、非敏感 diagnostics 和用户 note，可导出本地诊断包，不建设 SaaS feedback backend。普通用户看到“正在准备、需要你确认、资料已更新、无法连接 Agent、重新尝试”，技术概念留在 Developer Mode。

至少维护：

```text
README.md
QUICKSTART.md
INTERNAL_BETA.md
ARCHITECTURE.md 或等价 accepted ADR
KNOWN_ISSUES.md
```

文档必须说明启动、Profile、添加 Job、推荐流程、外部 Provider 要求、故障处理、数据位置、备份与恢复。

## Technology Boundary

不进行 Python → TypeScript 全量重写，不增加 Node backend：

```text
TypeScript → UI / presentation / client interaction
Python → OfferU Domain Runtime / Operation / Automation / data
Tauri/Rust → desktop shell / process lifecycle
External Harness → replaceable agent runtime
```

Codex、Gmail、DSH 等外部能力可为 `BLOCKED_EXTERNAL` 或 `EXPERIMENTAL_PROVIDER`，但不能阻塞至少一条完整核心路径。当前不建设面经社区、Feed/Like/Follow、复杂协作、企业租户、组织权限、Billing、云同步、大规模 SaaS infrastructure、全自研 Harness 或为未来需求预埋架构。

## Verification Contract

不能用测试数量或静态检查单独声明完成。最终必须实际执行并记录：

```text
backend full tests
frontend typecheck
frontend build
relevant lint
Doctor
localhost API smoke
real browser E2E
```

### New User Golden Path

使用全新的隔离测试数据库，从真实 UI 完成：

```text
Launch → Onboarding → Create/import Profile → Save Job
→ automatic preparation → Today progress → Role Intelligence
→ Evidence Gap → Resume Candidate → Accept changes
→ Pipeline → Interview Focus → mock Interview → Debrief
→ Learning Candidate → Accept Learning → Profile updates
```

不得直接改数据库跳过步骤。

### Existing User Golden Path

使用已有 Profile、5 Jobs、2 Applications、1 upcoming Interview 的 fixture，验证 Today、Pipeline、Job Detail、Profile 状态一致。

### Failure and Approval Paths

主动覆盖 Provider unavailable/auth blocked、LLM timeout、cancelled task、backend restart、invalid Candidate、重复请求以及 Candidate Accept/Reject；确认失败不白屏、不无限 loading、不伪造成功，审批后的投影全部一致。

若 full suite 失败，区分本轮 `REGRESSION` 与 `PRE_EXISTING_FAILURE`；本轮引入的必须修复，历史问题记录在 `KNOWN_ISSUES.md`，不得无边界扩张范围。检查明显重复请求、N+1、每个 Tab 重复调用 LLM、无效重复 Research；有效 Role Intelligence/Research 应缓存。

## Final Acceptance

只有下列结果之一可以结束 Goal：

### `INTERNAL_BETA_READY`

所有当前本地环境可完成的必需 Gate 通过；陌生测试用户仅凭启动说明即可走完 New User Golden Path，核心 Career State、自动准备、Today、Pipeline、材料、Interview、Learning、失败恢复和数据安全均有实际证据。

### `INTERNAL_BETA_READY_WITH_EXTERNAL_BLOCKERS`

只有 Codex OAuth、Gmail OAuth、DSH 等非核心第三方凭据或实验 Provider 仍待人工处理，同时至少一个真实可用 Runtime Provider/replay 核心链路通过；阻塞项必须在 UI、Doctor、文档和最终报告中明确。

最终用户体验应当是：

> “OfferU 一直知道我在投什么、发生了什么、下一步最重要的是什么，而且大部分整理和准备工作已经替我完成。”

若一个新增功能增加页面、状态、Agent、用户点击或重复数据，却没有明显改善这条体验，不实现。
