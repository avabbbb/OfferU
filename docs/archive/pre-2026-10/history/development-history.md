> **已归档（2026-10）**：本文不再是当前权威。当前文档：README.md（位于 `docs/`）。

# OfferU Development History / 发展历史

Status: **HISTORICAL SYNTHESIS — NOT CURRENT PRODUCT AUTHORITY**
Reviewed: 2026-10-05

OfferU evolved from separate career tools and several Agent-host experiments into an App-first career workspace with one Career Truth and one governed Operation Registry. This page preserves the decisions, reasons and unfinished acceptance boundaries; it does not carry old implementation instructions forward.

OfferU 从职业工具与多种 Agent 宿主实验，逐步收敛为 App-first、一个岗位一个持久工作区、统一职业事实与操作权限的产品。本页蒸馏发展过程；现行要求仍以 [GOAL](../../GOAL.md)、[产品定义](../product/current-product.md)、[CONTEXT](../../CONTEXT.md)、[当前决策摘要](../adr/README.md) 和 [架构](../../ARCHITECTURE.md) 为准。

## Timeline / 阶段演进

| Period | Change and reason / 变化与原因 | Retained boundary / 保留下来的约束 | Evidence and limits / 证据及边界 |
| --- | --- | --- | --- |
| August 2026 | Career modules, provider-neutral Runtime and capability plugins were developed together. / 职业模块、可替换 Runtime 与能力插件共同演进。 | Business writes belong to the Registry; model output is not Career Truth. / 业务写入统一治理，模型输出不能直接成为职业事实。 | [August goal](../archive/offeru-autonomous-2026-08/GOAL.md), [checkpoint](../archive/offeru-autonomous-2026-08/STATUS.md). Fixture/plugin results and external-auth blockers were separate; they did not establish public readiness. |
| August–September 2026 | DSH / external-Harness-first designs explored a host-native shell and CLI bridge. / 曾尝试把宿主原生界面作为外壳，OfferU 作为嵌入工作区。 | One reasoning authority per Run, independent user approval and canonical Career Truth. / 单 Run 单推理主体、用户独立批准、统一职业事实。 | [Archived Agent design](../archive/architecture/agent-system-harness-era-2026-09.md), [host adapters](../archive/architecture/harness-integrations-dsh-era-2026-09.md), [ADR history](../archive/architecture/adr-history-pre-2026-09-23.md). “Harness is the only product shell” and provider-specific priorities were later superseded. |
| Early September 2026 | Release work expanded into persistence, privacy, recovery, packaged startup and failure evidence. / 发布工作逐步覆盖持久化、隐私、恢复、安装产物和失败可见性。 | Claims must identify the tested commit, runtime and evidence layer. / 结果必须绑定代码与验收物，区分模拟、真实模型和人工验收。 | [September status history](../archive/STATUS-history-2026-09.md), [dated eval reports](../evals/reports/). Its old ports, model names, test totals and temporary paths are historical measurements. |
| 14–16 September 2026 | Codex-first simplification reduced setup burden, model presets and broad tool discovery. / 简化首次配置、模型预设和过宽工具发现面。 | Existing career capabilities and Registry authority were preserved; credentials stay in the OS vault. / 保留业务能力与 Registry，密钥留在钥匙串。 | [Archived execution plan](../archive/architecture/2026-09-14-simplification-execution.md), [operation inventory](../archive/architecture/2026-09-14-operation-inventory.md). The 257-operation measurement and temporary “do not run tests” instruction are not current rules. |
| 22 September 2026 | Tool Surface V2 separated execution breadth from model-facing tools. / Tool Surface V2 区分所有可执行能力、Agent 工具集合与当前 Skill 工具集合。 | Registry → Agent Tool Surface → Active Skill Surface. | [Current Tool Surface V2](../architecture/2026-09-22-tool-surface-v2.md). Its design remains current; comparison counts refer to the measured historical checkout. A dated filename alone does not make a document obsolete. |
| 23 September 2026 | Documentation was reset around Desktop, canonical Job Workspace and explicit authority order. / 文档围绕 Desktop、岗位工作区与明确的事实源顺序收敛。 | App-first and Skill-first share Profile / Job / Application state; Agents remain replaceable. / 两个入口使用同一职业状态，Agent 可替换。 | [Product](../product/current-product.md), [current decisions](../adr/README.md), [pre-reset checkpoint](../archive/STATUS-2026-09-23-pre-doc-reset.md), [old context](../archive/architecture/context-pre-2026-09-23.md). Historical numbered ADRs stopped being the default reading path. |
| 27 September 2026 | Proactive Career Director checkpoints covered event-bounded Profile discovery, daily briefs, job assessment, interview work and re-engagement. / 主动职业判断围绕明确事件推进五个切片。 | Reuse AutomationEvent → Rule → CareerTask → Agent/Runtime → Operation; no second infinite loop or automatic external contact. | [Archived status](../archive/checkpoints/2026-09-27-STATUS.md), [handoff](../archive/checkpoints/2026-09-27-HANDOFF.md), [current proactivity contract](../product/proactive-career-director.md). Their 813-test and synthetic Codex results apply to that checkpoint, not every later branch or installer. |
| 1 October 2026 | The upstream Python embedded loop was adapted to OfferU and its UI. / 上游 Python 内置 Agent loop 接入 OfferU Runtime 与界面。 | The loop reasons; Registry executes; Career Runtime persists truth. | Commits `0cbfd54` → `fb72b34` → `265cad5`, upstream `luyishui/OfferU@3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5`; see [current architecture](../../ARCHITECTURE.md). Engineering integration does not prove human Desktop writes or installer upgrades. |
| 2 October 2026 | Owner journeys and the PR #51 blueprint review shifted acceptance toward actual career outcomes. / 真实求职旅程与 PR #51 对照评估将验收重点转向用户结果。 | Source existence, reachable product paths and real owner acceptance are separate. / 源码存在、产品路径可达、真人可用分别记账。 | Commits `38fdab5` and `588d860`; [owner journey](../product/owner-career-journey.md), [blueprint assessment](../evals/reports/2026-10-02-pr51-assessment-and-refactor-plan.md), [verification](../evals/reports/2026-10-02-pr51-luna-verification.md). A blueprint, packaged smoke or synthetic Profile is not completed owner dogfood. |
| 2–5 October 2026 | Proposal v2 work explored semantic decision groups, exact authorization, durable receipts and continuation. / Proposal v2 推进语义决策组、精确授权、持久回执与原 Run 续跑。 | Approval binds displayed changes; completed history survives revision; unknown effects cannot replay blindly. / 批准绑定展示范围，修订保留历史，未知效果不盲目重放。 | Local integration `cf8deae` and the dirty development checkout were distinct implementations under review. Whole-plan synthetic checks and live-model preparation are scoped evidence; authority convergence, final regressions, human approval and upgrade acceptance remain separate. See [readiness review](../evals/reports/2026-10-05-main-readiness-review.md). |
| 5 October 2026 | Local branches were reduced from 29 to three with recoverable archives; stale root checkpoints were distilled. / 本地分支通过可恢复归档收敛到三条，旧根目录检查点蒸馏为本历史。 | Preserve unmerged commits and user files; deliver slices with explicit source and artifact identities. / 保留未合并提交和用户文件，按切片交付并说明版本身份。 | [Branch consolidation](../agents/branch-consolidation-20261005.md), [AGENTS](../../AGENTS.md). Archiving branches is not merging or accepting their features; remote branches were not deleted. |

## What was superseded / 已被取代的内容

| Historical instruction / 旧要求 | Current treatment / 现行处理 |
| --- | --- |
| A particular Harness owns the product shell; built-in reasoning is categorically forbidden. | Desktop is App-first; verified user Agents remain core, and an explicitly chosen embedded Agent can use the same Registry. / Desktop 是默认入口，外部与内置 Agent 共用治理边界。 |
| Static operation totals and provider priority lists define current capability. | Inspect the live Registry, host adapter and actual conformance evidence. / 以当前代码和能力证据核验。 |
| A numbered historical ADR is automatically current. | Use the current decision summary and authority order; retain old ADRs for rationale. / 旧 ADR 只作来由，现行决策按摘要与权威顺序裁决。 |
| Old PASS totals or a working source server prove current release readiness. | Bind results to exact code and artifact; record model, human and installer layers independently. / 绑定版本与验收物，分别记录各层验收。 |
| Every low-level mutation should create a separate human decision. | Group exact reviewed changes semantically; no widening authorization or self-approval. / 按明确语义审核具体修改，不扩大批准范围。 Migration remains subject to validation. |

## Lessons for implementation / 施工经验

1. Complete one business chain early, including state, audit, continuation and recovery; then expand coverage. / 先闭环再扩展。
2. Freeze shared interfaces and integrate small work packages continuously. / 先对齐契约，小包持续集成。
3. Test all groups, including source versions changed by previous groups. / 验证整份任务，覆盖跨组版本变化。
4. Separate business success, execution receipts and subsequent model startup. / 区分业务提交、回执和模型续跑。
5. Report whether the user's checkout and running app contain the change. / 明确原项目与当前 App 是否已交付。

These lessons supplement [AGENTS.md](../../AGENTS.md); they do not relax security, data migration or release gates.

## Reading policy / 阅读策略

Start with current authority documents. Use this page to understand evolution, then open raw archives only for a specific historical question. Dated reports retain their original results; unresolved evidence is not converted into PASS. Historical failures are not automatically current blockers without checking their applicability.

先读当前事实源；需要理解演进时读本页，再按问题定位原始归档。保留旧证据的日期与范围，不把未知项写成通过，也不把无法确认仍适用的旧失败无限扩大为当前门槛。
