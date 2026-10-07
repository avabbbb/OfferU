> **已归档（2026-10）**：本文不再是当前权威。当前文档：08-module-agent-runtime.md（位于 `docs/`）。

# 给小伙伴：OfferU Proposal v2 迁移方案

日期：2026-10-02。状态：设计交接，尚未实施。本文记录已讨论确定的方向、源码调查和推荐施工顺序；未决事项不是授权默认值。

## 先看结论

这次迁移的目标是：**用小伙伴的 Plan / Confirmation Group / Receipt / Continuation 机制替换 OfferU 当前 operation-level Proposal 授权层，让用户审核一组具体改动，而非逐个底层操作确认。**

保留 OfferU 的 Career Truth、Operation Registry、`execute_operation()`、`confirmed_operation`、`OperationAuditLog`、幂等、AgentRun/Events 和独立用户授权。保留 Coordinator 的并发防重与恢复职责，但迁移其底层存储实现。

不重新迁移 Agent loop，不搬入第二套 Operator Registry/Executor，不让 Plan 成为第二套 Career Truth。简历和 Memory 的领域内容提案继续承载证据、改动和事实门；替换的是执行授权层。

**本次源码调查基于有大量未提交改动的工作区，不代表远程 main。没有运行产品验收或发布 gate。**

## 1. 希望用户体验到什么

以“针对当前 AI 产品经理岗位准备简历”为例：

1. Agent 读取同一个 canonical Job、Profile 和可验证证据。
2. 证据无法回答且影响定位时，通过 Ask 询问用户；有足够信息时继续准备。
3. 在任务范围内保存 L1 草稿，不自动采用、不改写 Profile。
4. 展示 Before/After、每项证据与改写理由，组织成用户能理解的改动集合。
5. 用户采用具体集合，系统通过 Registry 执行底层动作并记录回执。
6. 回执交回同一个 Run 的 reasoning authority，Agent 验证结果并继续。
7. 重启后保留授权、结果与待处理状态，不重放效果不明的写操作。

定位、结构、工作经历等可以是语义分组，但不强制每个阶段都 Ask，也不硬凑 3–7 个组。最终预览不重复审核已采用的改动。整份采用与按模块采用的默认入口仍待讨论。

## 2. 保留与替换的边界

| 对象 | 处理方式 | 原因 |
| --- | --- | --- |
| Career Truth / Job / Profile / Resume / Application | 保留同一 canonical 状态 | 不产生 Agent-only 工作区或第二份职业事实 |
| `app.ops.OPERATIONS`、schema、permission、execute、audit | 保留 | 仍是唯一能力和执行边界 |
| Coordinator | 保留职责，升级存储和执行调度 | 当前 claim 依赖 steps_json，不能原样用于兼容投影 |
| AgentRun / Run Events / Session | 保留 | 承载任务、推理上下文和可见进展 |
| operation-level pending Proposal | 被 Plan/Group 授权层替换 | 解除“一次受保护工具调用对应一次确认”的耦合 |
| AgentRun.steps 的提案权威 | 迁移到新对象，暂留兼容投影 | 不双写两份授权事实 |
| ResumeOptimizationProposal / MemoryProposal | 保留领域内容职责 | 保存证据、候选内容、差异及事实门，不能变成平行执行授权 |
| 上游 operator Registry/Executor/tools | 不作为第二套业务执行器迁入 | 避免两套 schema、permission、side effect 和 audit |

## 3. 目标对象与调用链

| 对象 | 职责 |
| --- | --- |
| ProposalPlan | 一个 Run 关联的准备目标、节点与依赖；计划本身不授予执行权限 |
| ConfirmationGroup | 一组已展示、内容固定、可共同授权的具体改动；UI 可称“决策组” |
| OperationNode | 引用 Registry Operation 和受约束的输入、目标、依赖与执行状态 |
| ConfirmationDecision | 来自独立用户界面的授权/拒绝证据，绑定 Plan/Group 的具体版本和摘要 |
| ExecutionReceipt | 节点实际执行结果、审计关联和副作用证据 |
| Continuation | 将可验证结果交还原 Run 的续跑记录；具体表/队列复用方式待依赖审计 |

```text
Active Agent → 准备 Plan / Nodes → Registry dry-run 与验证
                          ↓
                  固定的 ConfirmationGroup
                          ↓
                   独立用户审核与授权
                          ↓
               Coordinator claim / checkpoint
                          ↓
          confirmed_operation → execute_operation → AuditLog
                          ↓
               ExecutionReceipt → 原 Run continuation
```

Ask 是方向或事实问题；ConfirmationDecision 是对具体受保护变化的授权。回答“产品经历优先”不批准尚未展示的改写。普通 Agent 工具调用不能自行授予确认权限。

组摘要要绑定用户实际审核的内容、具体节点、目标与来源版本。依赖输出导致最终参数变化时，必须有可验证的预授权约束；如果改变实际改动内容或授权范围，重新审核。该契约尚未定稿，不能先用任意动态参数完成执行。

## 4. Luna max 的现场调查

| 证据入口 | 发现 | 对迁移的影响 |
| --- | --- | --- |
| `backend/app/services/operation_projection.py`：`confirm_operation_proposal` | 当前入口只选择一个 action，将单个 ID 传给 Coordinator | 需要新增组级确认与执行入口，不能只换 UI 标题 |
| `backend/app/services/agent_run_coordinator.py`：`_claim_step_for_execution` | CAS 比较整个 steps_json，并检查节点 waiting_confirmation | 新节点成为权威后，claim 必须迁移；并发防重不变量继续验收 |
| 同文件：`execute_confirmed` | 普通异常/工具错误记为 failed 并停止本次循环，没有判断是否产生副作用 | 新失败分类不能把异常等同于 no_effect |
| 同文件及 `agent_run_state.py`：恢复逻辑 | 遗留 executing 进入 uncertain / needs_reconciliation，不自动重放 | 保留这个边界并扩展可信副作用证据 |
| 确认入口、blocker 与 claim 的组合 | Run failed 后等待 sibling 仍可能被单独 action_id 再确认 | 新组暂停/协调状态必须阻断所有旧入口，避免旁路续跑 |
| `backend/app/services/resume_workspace.py`：`review_resume_proposal_items` | 已有具体 change_ids 集合的原子审核、重复处理、事实门与快照过期检查 | 首切片复用该 Operation，不为每个 bullet 重新造一次底层 mutation |

这些是只读源码调查结论，不是失败场景测试通过的证明。小伙伴施工前应在自己的 checkout 再确认实际文件与调用链。

## 5. 用户已决定：分类恢复

任何节点失败，先暂停本组未执行节点，保留已完成结果及逐节点回执。不默认继续所谓无依赖节点，不自动回滚整组。

| 情况 | 恢复规则 | 是否重新审核 |
| --- | --- | --- |
| 确定未产生副作用、可重试，参数/快照/授权均有效 | 在原授权内有界重试 | 不重复确认同一内容 |
| 副作用是否发生不明 | 进入 reconciliation，先核对可信回执和业务状态 | 核对本身不是批准；后续按实际恢复内容判断 |
| 已有部分效果 | 保留证据，仅从安全检查点恢复，或准备修复方案 | 新修复变化按权限审核 |
| 内容、来源版本或授权范围变化 | 旧授权不再用于新集合 | 审核变化后的集合 |
| 永久错误、事实门 blocked 或过期 | 不自动重试；Agent 可准备修复候选 | 修复不能绕过事实门 |

具体错误分类契约、重试次数和退避尚未定稿。分类必须来自 Registry/执行回执及状态证据，不能仅由模型声称“没有副作用”。失败和恢复通过同一权威状态转换；单节点兼容入口也必须检查组状态。

## 6. 上游吸收范围

参考固定来源 `luyishui/OfferU@3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5`，优先审查 Plan Snapshot、Group digest、OperationNode 依赖、ConfirmationDecision、执行 lease、receipt、continuation、revision/replacement 与 manual review。

前一轮已取得 [plan_authorization.py](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/plan_authorization.py) 和 [plan_execution.py](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/plan_execution.py) 的源码，观察到摘要绑定、确认去重、拒绝依赖阻断与节点回执机制。Luna 后续取回失败，完整 operator 依赖审计仍未完成。

迁入前输出一张最小依赖映射：上游模型/方法 → OfferU 对应 authority → 保留或适配原因 → 验证项。保留适用许可证与来源信息，不凭文件名认定模块可以直接搬。

## 7. 建议施工顺序

每个阶段完成一个可验收纵向切片，不先铺满所有表再补闭环。

1. **确定最小依赖与迁移契约。** 核实上游依赖和当前工作区，定义新对象、旧记录映射、快照/摘要绑定与组状态，准备 backup/restore 和升级测试。
2. **打通简历首切片。** Plan/Group 持久化 → Desktop 展示具体改动 → 独立审核 → 新节点 claim → 现有原子批量审核 Operation → Audit/Receipt → 同一 Run continuation。没有这个闭环，不宣称 Group 已迁完。
3. **收敛兼容入口。** `confirm_operation_proposal` 只映射到对应单节点组；旧 action_id 不能批准额外节点。新授权对象是唯一 authority，旧 steps 只是投影。
4. **扩展真实多 Operation 组。** 验证依赖、拒绝阻断、部分失败、分类恢复和动态输入边界。分组授权不承诺跨 Operation 原子性。
5. **真人与安装升级验收。** 完成真实 Desktop 批准、回执续跑、关闭重启及历史记录升级后，再删除旧授权逻辑和不再必要的兼容代码。

适用范围是同一 Registry 的内置/外部 Agent；首切片可以先由内置 Agent 验证，但不创建专属第二套授权路径。

## 8. 历史数据与安全边界

- 待批准、执行中、已完成与历史审计分别迁移；不得清空旧数据。
- 旧记录无法证明与新摘要等价时，保留历史并要求重新展示审核，不伪造新授权。
- 执行中/效果不明的旧记录先协调，不在 migration 中重放。
- 幂等键与已完成效果关联保持可追踪，兼容调用和重启不能重复写入。
- 组变更不能继续使用旧 digest/decision；已执行历史不能被 plan replacement 抹去。
- 简历采用、Profile 事实变更和外部发送不因“同属一个任务”混进同一授权组；L3 仍遵循现有明确批准政策。
- “负责开发”改成“主导业务落地”涉及新增 ownership 事实，不能靠批量批准绕过证据门。
- 浏览器回归遵守仓库 managed Chromium、headless、固定地址与 H 盘临时空间约束；自动化批准不冒充真人授权验收。

## 9. 验收映射

| 目标 | 必须验证 |
| --- | --- |
| 少确认 | 一个展示过的具体集合一次审核；Ask 和最终预览不重复批准已采用内容 |
| 授权准确 | 摘要/来源/参数变化失效；Agent 不能自批；兼容入口不扩大授权 |
| 执行正确 | 所有节点走 Registry，schema、权限、事实门、审计仍生效 |
| 并发和重启 | 双击、并发确认、重试与重启不重复效果；effect unknown 不重放 |
| 分类恢复 | 无效果安全重试沿用原授权；未知/部分效果先协调；永久阻断不循环重试 |
| 组暂停有效 | 失败后的 sibling 不能从旧 action_id 或其他入口绕过暂停 |
| Agent 续跑 | 同一 Run 收到实际成功/失败/拒绝回执，继续读取并验证真实状态 |
| 数据升级 | 旧提案/审计保留，backup/restore、迁移重复运行和失败恢复可验证 |
| 产品完成 | 真人 Desktop 审核与安装版升级/重启另行记录，不以单测代替 |

后端运行相关 pytest；前端至少 typecheck 和相关测试，影响路由/依赖/构建时加 production build。跨层和 persistence migration 按 GOAL/CI 扩大 gate。报告必须列修改文件、已执行/失败/未执行检查和剩余风险。

## 10. 尚未定案，请继续讨论

1. 默认入口是整份采用并可取消个别项，还是按模块采用？已确定支持语义集合审核，默认展示尚未明确。
2. 用户取消/修改某项时，组如何修订，哪些依赖需要重新准备？不能只删除节点后沿用原摘要。
3. Ask 等待回答、超时、取消和重启恢复怎样关联同一 Run？尚未定义持久状态契约。
4. 节点引用前序输出时，哪些输入可以被预授权约束，哪些变化必须再次审核？
5. 安全重试的分类来源、次数上限、lease 和 continuation 投递/消费防重如何复用现有机制？

这些问题不改变已确定的替换方向，但对应模块实施前需要收敛。不要把“待定”实现成静默放行。

## 交接要求

实施共同契约、A–E 独占职责、状态、摘要材料和迁移矩阵见 [实施接口契约](./proposal-v2-implementation-contract.md)。该契约由主 Agent 冻结；子代理不得自行改变 schema、状态名、重试语义或共享文件。2026-10-03 正在实施，准备层定向测试通过不等于整体迁移或产品验收完成。

固定上游最小映射（2026-10-03 取回实际源码）：

| 上游对象/方法 | OfferU authority | 适配原因 | 验收 |
| --- | --- | --- | --- |
| plan_snapshots snapshot/node/group binding | root Builder + Registry schema | 摘要覆盖实际展示和确切输入，拒绝 default=str 隐式转换 | 参数/展示/来源/schema/依赖篡改拒绝 |
| plan_authorization record_group_decision | 新 store 决策事务 + 独立 UI capability | 摘要不是批准凭证，重放决策必须同身份 | 伪造来源、重复ID不同内容、拒绝传播 |
| plan_execution claim/checkpoint | OfferU Coordinator + execute_operation + AuditLog | 保持现有执行和事实门，不迁入第二执行器或自动整组补偿 | 并发、防重、部分失败、unknown协调 |
| effect_manifest committed/no_effect completeness | Registry执行回执及可信核对 | no_effect 必须完整证据，不由错误类型推断；普通异常/超时仍可能有副作用 | commit后回执前crash、安全重试不绕审计 |
| manual_review_recovery recovery overlay | 原Plan/Run的协调状态与历史 | 保留效果及已执行历史，不替换职业事实或抹掉旧授权 | unknown/partial不自动重放，旧记录保留 |
| continuations leased claim/renew/finish | 原Run continuation outbox/消费 | 模型接受后才标投递完成，原宿主不能push时保留回读 | receipt/outbox/模型启动崩溃、防重与原Run绑定 |

上游引用：[plan_snapshots](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/plan_snapshots.py)、[effect_manifest](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/effect_manifest.py)、[manual_review_recovery](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/manual_review_recovery.py)、[continuations](https://raw.githubusercontent.com/luyishui/OfferU/3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5/backend/app/operator/continuations.py)。只读核验不代表移植或回归通过。

请先对照 authority 和 live code 给出上游依赖映射与第一纵向切片范围，再实施。交付应证明：**用户批准的是可理解的具体改动，Registry 执行的是被批准的确切操作，Agent 收到的是实际回执。**

进一步背景见 [讨论草案与决策记录](./embedded-agent-proposal-integration-draft.md)、[当前架构决策](../adr/README.md)、[领域词汇](../../CONTEXT.md)。本文未声称迁移已完成，也未授权外部发送、发布或提交。
