> **已归档（2026-10）**：本文不再是当前权威。当前文档：08-module-agent-runtime.md（位于 `docs/`）。

# Proposal v2：从 Operation Approval 到 Decision Plan

日期：2026-10-02。状态：替换授权层的方向已确定；执行失败、迁移细则与交互仍待讨论。未实施，不声明产品验收通过。

## 目标与现场证据

将小伙伴的计划、分组确认与结果续跑能力融入 OfferU，减少重复确认，保持 Operation Registry 为唯一执行和权限 authority。已迁移的 Agent loop 不重新迁移。

当前工作区有大量未提交修改；以下依据现场代码，不等同于 main 基线：

- `services/resume_workspace.py::review_resume_proposal_items` 已支持明确 change_ids 集合的原子审核、重复请求处理、事实门及 Job/Profile/Resume 快照过期检查。
- `PendingProposalReview.tsx` 仍逐 action 展示批准/拒绝；不能从展示形式推断所有业务都没有批量能力。
- 当前产品 authority 区分 Ask、L1 草稿准备、L2 采用审核与 L3 外部动作。
- 上游固定提交 `3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5` 的 `operator/plan_authorization.py` 有 Plan/Group 摘要绑定、确认事件去重、拒绝依赖阻断；`plan_execution.py` 有节点回执、幂等和人工协调机制。本次未完成整个 operator 目录的依赖审计。

## 建议的融合边界

1. 保留现有 Registry、Career Truth、execute_operation、confirmed_operation、AuditLog、幂等、Run/Events 与独立用户授权。Plan/Group 替换 operation-level Proposal 授权存储；Resume/Memory 内容提案继续承载领域证据与改动，不构成第二套执行授权。
2. ProposalPlan / ConfirmationGroup / OperationNode / ConfirmationDecision / ExecutionReceipt 成为计划授权执行的持久对象；AgentRun.steps 只作迁移期兼容投影，不再作为新提案授权的权威。用户界面可称“决策组”，代码术语统一为 ConfirmationGroup，避免 DecisionGroup 与 ConfirmationGroup 指代两个实体。
3. Confirmation Group 代表使用者可理解、已展示且内容固定的一组受保护改动。批准绑定具体内容及来源版本；改动集合变化需重新审核。
4. 简历首切片优先调用现有原子批量审核 Operation，不把每项 diff 变成一次新的批准。
5. Ask 只处理策略、事实缺口和取舍；回答不构成对未展示改写的采用授权。
6. L1 草稿在已授权任务范围内准备；Profile 事实变更与外部发送不混入简历采用组。
7. 执行回执进入现有 Run 并反馈给原 reasoning authority；异常效果不明进入协调状态，不盲目重放。

## 用户旅程草案

读取 Job/Profile → 必要时 Ask 策略或缺失证据 → 准备岗位化草稿 → 展示 Before/After、证据与理由 → 按模块或整份已展示集合采用 → Registry 执行 → 回执 → 同一 Agent Run 继续验证并解释结果。

## 原子性与恢复

分组批准不等于多 Operation 原子执行。首切片限制为同一 Resume Proposal 的现有事务边界。未来跨 Operation 计划必须独立设计依赖、部分完成、失败隔离与恢复，不能承诺所有副作用可回滚。用户拒绝或修改一项后的依赖处理仍待讨论。

### 已决定：组失败采用分类恢复

用户在 2026-10-02 的 Ask 中选择分类恢复。任何节点失败先暂停本组未执行节点，保留已完成结果与逐节点回执，不默认继续所谓无依赖节点，不自动回滚已完成副作用。

- 确认没有副作用、属于可重试错误，且参数、来源快照、授权范围/有效性均未变化：可在原授权内有界重试，不再次索要同一批准。具体重试上限与错误分类契约待实现设计。
- 效果不明：进入 reconciliation，通过可信回执/业务状态核对后才能决定恢复，不把普通异常视为“没有副作用”。
- 已有部分效果：保留效果证据，不能从节点开头盲目重放；恢复必须具备可验证的安全检查点或新的修复方案。
- 内容、来源或授权范围变化：旧授权不能用于新操作集合，重新生成并审核变更。
- 永久错误、事实门阻断或过期：不自动重试；Agent 可以在原任务范围内准备修复候选，但不能绕过阻断或自行批准。
- 恢复后节点 claim 必须同时检查组的执行/授权状态；旧 action_id 入口不能越过组暂停或协调状态执行 sibling。

Luna max 只读调查确认：当前 `operation_projection.py` 的确认入口只传单个 action ID；Coordinator 的普通工具异常统一为 failed 并停止循环，未区分有无副作用；遗留 executing 才进入 uncertain。Run failed 后 sibling 仍可能被单独确认，故“整组暂停”需要新增可靠状态约束而非沿用旧循环 break。本轮未运行测试。子代理未能再次取回指定上游文件；先前已取得的上游源码证据不能代替完整依赖/恢复审计。

## 已确定的实施方向

- 吸收上游不可变快照、组摘要、节点依赖、确认记录、回执与续跑设计；迁入具体文件前做模型、事务、授权及调用链依赖审计，不整体复制 operator Registry/Executor。
- 模型可在执行前准备多个节点，再提交语义组。每个节点绑定现有 Registry schema、具体参数、目标与授权快照；依赖输出导致参数变化时，不得借已批准组授权任意新写入。
- Coordinator 保留职责与已验证的不变量，但其当前 CAS 是对 steps_json 的条件 UPDATE；迁移到节点/组权威后必须重写 claim 的存储实现并做并发、崩溃回归，不能把旧 CAS 原样用于只读投影。
- 单操作兼容调用映射到明确的单节点组；旧 action_id 不能批准包含额外节点的新组。旧待批准记录、执行中记录及历史审计按 backup/migration/upgrade 规则保留，不能丢弃或双写两份 authority。
- Plan Review 按语义展示，操作详情可展开；不为了固定 3–7 个组而合并不同风险或授权范围。已批准的改动不在最终预览重复索要批准，最终批准仅针对尚未采用或新增的集合。
- Ask 不固定成每阶段必问；只询问现有证据无法回答且影响结果的选择。“负责接口开发”改为“主导需求到业务落地”是新增 ownership 事实，缺少证据时必须阻断或询问，不能因整组批准绕过事实门。
- 机制覆盖内置与外部 Agent 的同一 Registry 路径，不新增第二条专属授权链。

## 建议的迁移顺序（未执行）

1. 上游依赖审计，确定最小模型及旧记录迁移映射。
2. 一个简历采用纵向切片：新 Plan/Group 存储 → 独立审核 → 现有批量审核 Operation → Audit/Receipt → 原 Run continuation。
3. 将 Coordinator claim/checkpoint/reconciliation 接到新节点权威，验证兼容确认不扩大授权。
4. 扩展到多 Operation 依赖计划，按已决定的部分失败语义执行。
5. 真实 Desktop、重启、安装升级验收后移除旧步骤授权路径与兼容代码。

## 首切片验收建议

- 多项简历改动以一次明确集合审核采用，保留每项证据与事实门。
- 重复点击、重启重试不重复产生业务效果；来源或工作区变化使旧审核失效。
- 批准后同一 Run 获得回执并继续；拒绝能被 Agent 感知。
- 自动测试与真人 Desktop 批准、安装版持久化验收分别报告。

## 待决策

已决定：组内失败先暂停，按副作用证据、错误类型与授权有效性分类恢复；安全重试沿用原授权，未知效果协调，内容变化重新审核。

后续：部分拒绝的依赖语义；Ask 暂停和重启恢复；整份采用与模块采用默认入口；动态参数绑定的授权范围；旧待批准记录迁移。
