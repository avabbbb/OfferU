---
status: accepted
---

# 主 Agent 执行持久化为求职任务内的 Agent Run

主 Agent 运行时的每次执行作为一个求职任务下的 Agent Run 持久化，保存输入、Skill、标准化事件、Operation 调用、待确认动作、输出和恢复位置；对话继续作为任务内交互记录，已确认领域对象继续作为事实源。OfferU 不建设跨任务的全局 AgentSession，也不按 GUI 页面拆分会话。选择任务内 Agent Run 是为了支持暂停、恢复和审计，同时避免 Pi 式长期 Session 成为求职任务、对话和领域数据之外的第四个状态源。
