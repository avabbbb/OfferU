# Launch Video Parity Audit

> 基线：`main`（审计时仓库指向 `c58c069`）。本轮只允许 UI 投影与交互重组，不新增 schema、第二套状态或旁路写入。

## 结论

宣传片的 6 个画面与当前产品模型并不冲突：Job Workspace、Role Benchmark / Evidence Gap、Resume Proposal、Interview lifecycle、Progress Timeline 都已经有 canonical 数据源。主要差距是 **同一份 Career Truth 没有被组织成宣传片里那条清晰叙事**。

本轮没有发现 PR1 必须修改后端的理由。PR3 的“逐条接受 / 拒绝”底层能力也已经存在，因此当前没有后端 blocker；后续只需要把既有 Resume Workspace 的审核能力投影回 Job Workspace。

## 逐项对照

| 参考画面 | 现有实现位置 | 当前差距 | 计划改动 |
| --- | --- | --- | --- |
| 1. Job Workspace 六面板 | `frontend/src/app/jobs/[id]/page.tsx` 已读取 `useJob`、`useProgressBoard`、`useProgressTimeline`、`useCareerTasks`、`useJobCareerArtifacts`，并包含岗位情报、简历材料、面试、投递进展、调研、投前决策等 section。 | 页面仍是十几个 section 的纵向长页；用户进入后看不出“这是一个 Job Workspace”，也没有 Snapshot / Role Intelligence / Evidence Map / Materials / Interview / Timeline 的统一总览与锚点。 | **PR1**：新增 `frontend/src/components/jobs/JobWorkspaceOverview.tsx` 与测试；Job 页标题下方加入 2×3 总览；给既有 section 加稳定锚点。 |
| 2. Evidence Map | `frontend/src/components/jobs/RoleIntelligencePanel.tsx` + `roleBenchmarkApi.forJob`。现有 `signal.direction` 区分 common / distinctive / highly_distinctive，`signal.evidence_gap.status` 区分 supported / partial / missing；现有 UI 已有“目标岗位特别强调”“同类岗位普遍要求”“优先补证据 / 准备”。 | 信息散在折叠/分组详情中，没有“岗位要什么 × 你能证明什么 = 下一步准备什么”的一眼式三栏投影；chip 也没有稳定跳转到对应 `SignalEvidence`。 | **PR2**：新增 `EvidenceMapSummary`，只消费现有 benchmark snapshot；为 signal 详情增加稳定 anchor，不改 benchmark/schema。 |
| 3. Resume diff + evidence gate | 后端已有 `review_resume_proposal_item` / `review_resume_proposal_items` Operation 与 `/api/resume/workspace/proposals/{proposal_id}/review-item(s)`；`frontend/src/app/resume/[id]/page.tsx` 已按 `change_id` 支持逐条/分组 Accept / Reject，且 `fact_gate_status === "blocked"` 时禁用接受。`PendingProposalReview` / Proposal v2 则按语义 group 批准或拒绝：组内可以展示多条 before/after，但新 Plan 明确不是“一 bullet 一个批准”。 | Job 页目前主要展示 proposal 摘要并把用户导向 Resume Workspace；宣传片要求在岗位语境里直接看到 before/after、逐条决策、证据门阻断和已检索来源。 | **PR3**：复用现有 Resume Workspace proposal 数据与 item review API，把 diff 投影到 Job Materials；不把 Proposal v2 的语义 group 伪装成逐条批准。无证据条目只读展示并禁止接受。当前 **不需要新增后端 schema**。若实现时发现某条 change 没有可映射的现有 evidence/source ref，只记录为 audit gap，不伪造来源。 |
| 4. 保存即进工作区 | `frontend/src/components/jobs/AddJobModal.tsx` 的结果回传给 `frontend/src/app/jobs/page.tsx::handleJobCreated`，当前已经在拿到 canonical job id 后 `router.push(/jobs/{id})`。Skill 路径也要求解析/创建同一个 canonical Job；Today 的 action 已能按 `target_ref.kind === "job"` 生成 Job 链接。 | 手动 AddJobModal 已基本满足“保存即进工作区”；缺口主要在扩展 / Agent 保存后的显式“打开工作区”发现性与一致性，而不是数据落点。 | **PR4**：保留现有 AddJobModal 行为并补回归；检查扩展 / Agent 保存结果在 Today 的 CTA，统一指向 canonical `/jobs/{id}`。不新增 Agent-only Job。 |
| 5. Interview → debrief → review → Profile | `InterviewLifecycleCard` 已支持 prepare / debrief / learning_review；`submitInterviewDebrief` 提交后进入学习候选流程。当前产品文档与 Career Learning 逻辑明确：debrief 生成 source-linked observation + pending Memory Proposal，未审核候选不算 verified Profile evidence。 | Job 页能显示 lifecycle card，但没有按宣传片聚合 Evidence Map 缺口、最近一次带时间戳 transcript 引用、以及就地 Approve / Dismiss。learning_review 当前更多是“去 Profile 审核”，不是 Job Workspace 内的 review inbox。 | **PR5**：复用 `InterviewLifecycleCard` 与 `frontend/src/components/workbench/PlanReviewInbox.tsx` / 现有 memory review 路径；审核前保持 pending，绝不直接写 Career Truth。若 transcript citation 当前任务结果里没有现成字段，再单独报告缺口，不能编造。 |
| 6. Today / Pipeline / Timeline 一致 | Job 页使用 `useProgressBoard` + `useProgressTimeline`；Pipeline/Today 也基于 canonical progress / task projection，而不是独立 Job 状态。 | 现有实现缺少“写入同一条 Applied event 后，Today / Pipeline / Job Timeline 三处一致”的显式跨 surface 回归，视觉上也没有统一摘要。 | **PR6**：只投影同一 progress event，补一条跨 surface 测试；只有现有 API 无法复用时才讨论后端，当前不预设后端改动。 |

## 三个必须先确认的问题

### PendingProposalReview / optimize 是否支持逐条接受或拒绝？

结论要分两层：**Resume optimize / Resume Workspace 支持逐条接受或拒绝；`PendingProposalReview` 的 Proposal v2 主路径不以单条 bullet 为审批单位。** 当前 Resume Workspace 已按 `change_id` 调用 `reviewProposalItem` / `reviewProposalItems`，后端 Operation 支持单条或一组 `change_ids` 的 accept / reject，事实门 blocked 时也会禁止接受。与此同时，Proposal v2 把修改组织成少量语义 group，一个 group 原子执行一组 `change_ids`，其约束明确要求不要为每个 bullet 新建一个审批组。因此 PR3 若要还原宣传片“逐条 Accept / Reject”，应复用现有 Resume Workspace 的 item-review 路径，而不是改写 Proposal v2 的审批语义；不需要新增 schema。

### Interview debrief learning 是否会直接写 Profile？

**不会。** 当前 Interview lifecycle 把复盘回答整理为 learning candidate；Career Learning 只把 accepted Memory Proposal 计入有效 evidence。未审核的 pending / deferred / rejected 等状态都不能成为 verified Profile truth。PR5 只需要把这个审核边界更清楚地投影到 Job Workspace。

### 保存岗位后落在哪？

- App 内 AddJobModal：已经进入 canonical `/jobs/{id}`。
- Agent / Skill：创建或解析的是同一个 canonical Job，不能形成 Agent-only workspace。
- Today：已有 job target link 能打开 `/jobs/{id}`；PR4 重点补扩展/Agent 保存后的显式入口与一致文案。

## PR 顺序

1. PR1：Job Workspace overview + anchors。
2. PR2：Evidence Map summary。
3. PR3：Job 内 Resume diff + evidence gate。
4. PR4：保存后的 workspace handoff。
5. PR5：Interview debrief + review inbox。
6. PR6：Today / Pipeline / Timeline consistency test。

每个 PR 独立可合并；后续 PR 不通过新增 schema 或平行状态来“补 UI”。
