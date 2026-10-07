> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# Main Readiness Review / 可合入 main 的改动梗概

Date: 2026-10-05
Status: **REVIEWED CANDIDATES — NOT PUSHED OR PRODUCT ACCEPTED**

Reviewed source: `main / origin/main = 265cad5`, development HEAD `588d860` plus its changing working tree, and isolated Proposal integration `cf8deae`. Changes were not inferred from HEAD alone. A detached review worktree based on main isolates the model-discovery API from the unfinished approval changes; local named branches remain three.

核对对象包含已提交历史、原工作区未提交改动和隔离集成。可合入的是按明确范围验证的提交，不是把整个 dirty worktree 推送到 main。本报告记录的是核对时状态，后续新增修改需要重新判断。

## Merge candidates / 分组结论

| Group | Verdict | 中文梗概 | English synopsis | Evidence / remaining gate |
| --- | --- | --- | --- | --- |
| Owner journey and acceptance docs: `38fdab5`, `588d860` | **READY — documentation scope** | 明确真实求职旅程与两条 dogfood Goal，保存 PR #51 的源码评估和当时真实模型/安装包检查，区分源码、产品路径与真人验收。 | Define outcome-based owner journeys and dogfood goals; retain the PR #51 assessment and its dated runtime evidence without claiming product completion. | Reviewed as documentation; the PR #51 blueprint itself remains a separate open design proposal. Historical report results are not a current full-suite PASS. |
| AGENTS execution rules, branch inventory and history distillation | **READY — documentation scope** | 固化首切片、并行契约、阻塞定位和最多三条本地分支规则；蒸馏旧状态、交接与架构检查点，建立统一发展历史入口。 | Establish delivery and branch-budget rules; distill stale checkpoints into one development history while preserving raw evidence and old-path pointers. | 105 local links and four archive source hashes checked; whitespace checks passed. No business behavior change. |
| Model discovery API + ModelPicker | **NEEDS FIX / INTEGRATION CHECKS** | 支持使用已存密钥获取模型，区分 OpenAI/Anthropic 请求头，展示友好名称并丢弃过期响应。新增强制密钥行为改变了原来无密钥请求语义。 | Discover models using saved credentials and protocol-specific headers, show display names and discard stale responses. The new mandatory-key check changes existing keyless-request behavior. | Isolated main API selection: **19 passed**; current ModelPicker: **3 passed**. Resolve the keyless compatibility behavior and test Settings integration/typecheck/build before merging the complete feature. Mock transport results are not live-provider acceptance. |
| Optimize stream → Registry | **NEEDS STREAMING VALIDATION** | 将旧 Optimize 旁路收敛到 Registry；当前先等待 Operation 收集全部 events，再创建 SSE 响应，可能改变首事件延迟与实时流式行为。 | Route Optimize through the Registry; awaiting all events before creating the SSE response may change first-event latency and streaming behavior. | Existing wrapper tests do not establish progressive delivery, cancellation or real Registry execution. Verify these behaviors before declaring the bypass fixed and product streaming preserved. |
| External Agent / Skill installation / connection and resume drafts | **NEEDS CROSS-LAYER VALIDATION** | 恢复 runtime-bound Skill、宿主能力与原 Run 连接，准备外部简历草稿和恢复投影。 | Restore runtime-bound Skills, host capability/readback and original-Run linkage; prepare external resume drafts and recovery projections. | Changes span Registry, Bridge, host workers, workspace and UI. Require a complete slice with real model-issued operations and independent review; do not combine with approval migration solely because files overlap. |
| Decision Plan / Proposal v2 / Ask and native review | **HOLD — AUTHORITY AND RECOVERY CHECKS** | 原工作区出现 `decision_plans` / `decision_execution` 等新实现，隔离分支仍有 `proposal_plan_*` 实现；需明确唯一权威、入口范围与数据迁移，再验证授权、回执与同 Run 续跑。 | Reconcile the working-tree decision services with the isolated Proposal control plane; establish one authority, exact authorization, durable receipts and same-Run continuation. | Isolated earlier tests do not validate the current working-tree implementation. Complete source/argument binding, legacy entrypoints, failure recovery, final regressions, native human review and upgrade evidence for the declared scope. |
| Sidecar browser path, filelock dependency, S0 startup and generated types | **NEEDS ARTIFACT / DEPENDENCY CHECKS** | 修正安装资源定位和进程/会话协调；必须核对依赖、生成接口与最新包身份一致。 | Correct packaged resource lookup and process/session coordination; verify dependencies, generated interfaces and the final artifact identity together. | A sidecar built before subsequent code changes is historical evidence. Verify locked dependencies, packaged startup, schema and affected recovery behavior on the actual candidate. |

## Recommended order / 建议合入顺序

1. Land the documentation and historical-source cleanup as a separate reviewed commit. / 文档与历史整理先独立合入。
2. Resolve model discovery's compatibility issue, then validate the complete Settings slice. / 解决模型发现兼容变化，再验收完整设置链路。
3. Verify Optimize's first-event delivery and Registry boundary. / 验证 Optimize 的真实流式与权限边界。
4. Reconcile approval implementations and integrate Agent/Skill/resume work by complete slices. / 统一审批实现，按完整链路集成 Agent、Skill 与简历改动。
5. Run mandatory persistence/security/release gates and record native/human/installer evidence separately. / 必需门槛与真人、安装验收分别记录。

This order preserves the user's requested final scope; it does not declare the later groups abandoned or complete. Direct main push has not been performed.

## Checks executed in this review / 本轮检查

- Initial root `.venv` run: **15 passed / 4 failed**, all four failing on missing `anthropic`. This was an environment failure, not a repaired product defect.
- Repeated against the isolated main candidate using the existing backend `.venv312`: **19 passed** (`test_model_discovery.py` + `test_llm_protocols.py`, 27.03 seconds).
- Current `ModelPicker.test.tsx`: **3 passed**, including saved-key input, manual entry and stale-response rejection. This does not cover the entire modified Settings page.
- No real Career DB or real keyring was used; config/vault and network transports were isolated/faked. No model-provider credentials were exported.
- Full working-tree regression, native approval, live Settings discovery and installer upgrade: **NOT RUN in this review**. Existing source-branch reports retain their own scope.

The documentation candidate passed 105 local-link checks, four archived-source hash checks, balanced code fences and Git whitespace checks. Archived prose and dated results were preserved, with relative links and trailing whitespace normalized. See [Development History](../../history/development-history.md) for the distilled historical record and [branch consolidation](../../agents/branch-consolidation-20261005.md) for recoverable unmerged work.
