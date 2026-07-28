---
name: resume-optimizer
description: Create an evidence-locked resume optimization proposal for one researched job, expose an auditable diff, and apply it only after explicit user review.
---

# Resume Optimizer Skill

为一个目标岗位生成“可审核提案”，而不是直接改写正式简历。岗位调研、候选人事实和最终接受动作必须保持可追溯。

## Inputs

- 当前默认 Profile 中 `tier=verified_fact` 的结构化事实
- 目标岗位及完整 JD
- 该岗位一份状态为 `completed` 的调研结果，且结论必须引用已保存的 `source_refs`
- 可选参考简历；只能复用联系方式、语言、版式和模板偏好，不能继承其职业事实

## Required workflow

所有动作必须通过 Operation Registry：

1. `prepare_resume_optimization`
   - 读取已确认 Profile、JD 与已完成岗位调研
   - 生成候选段落、排序策略和逐项 diff
   - 保存 `ResumeOptimizationProposal`
   - 不创建正式 Resume
2. `list_resume_optimizations`
   - 仅返回扁平摘要，支持按岗位和状态筛选
3. `get_resume_optimization`
   - 渐进披露完整原文、建议、证据引用、事实门和调研 trace
4. `review_resume_optimization`
   - `action=accept`：重新验证档案与调研快照、事实门，通过后原子创建 Resume、ResumeVersion 和学习观察
   - `action=reject`：记录拒绝及学习观察，不创建 Resume

## Evidence and fact gates

- 每个候选段落都必须包含有效 `source_section_ids`
- 只能改写已确认事实；不得添加候选人未确认的技能、经历、指标、成果、责任范围或时间线
- “参与、协助、配合、支持”不得升级为“负责、主导、独立完成、owned、led”
- 原文没有数字时，不得添加数字或 `[待量化]` 占位符
- JD、面经、团队氛围、岗位调研和参考简历只影响排序、强调方向与能力缺口，永远不能成为候选人事实
- 找不到证据的 JD 能力必须列为 `missing_capabilities`，不能注入简历
- 调研结果必须保留 `evidence_level` 和 `source_refs`；冲突或证据不足时明确披露
- 提案生成后 Profile、JD 或调研发生变化，接受动作必须标记提案为 `stale`，要求重新生成

## Output contract

提案至少包含：

```json
{
  "proposal_id": "uuid",
  "status": "ready",
  "job_id": 123,
  "original_rows": [],
  "proposed_rows": [],
  "diff": [
    {
      "change_id": "stable-id",
      "change_type": "modified",
      "source_section_ids": [1],
      "before": {},
      "after": {}
    }
  ],
  "strategy": {
    "missing_capabilities": [],
    "research_gaps": [],
    "scoring_policy": "no_unvalidated_ats_score"
  },
  "fact_gates": {
    "status": "passed",
    "warnings": [],
    "warnings_count": 0
  }
}
```

## Rules

- 不输出伪造的 ATS 0–100 分或“优化后分数”；除非未来接入经过验证、可解释、可复现的评分器
- 不静默降级，不把失败包装成成功
- 不直接写数据库或执行隐藏 shell；必须走 Operation Registry 的权限、dry-run、确认和审计
- 在使用者明确接受前，正式 Resume 保持不变
- 输出语言跟随候选人简历语言，HTML 必须为 TipTap 兼容格式
