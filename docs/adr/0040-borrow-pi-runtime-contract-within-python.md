---
status: superseded by ADR-0046
---

# 在 Python 内借鉴 Pi 的运行时契约

OfferU 在唯一 Python 业务后端内建设小型主 Agent 运行时，借鉴 Pi 对 AgentSession、类型化工具、生命周期事件、取消、恢复和上下文边界的划分，但不依赖 Pi、不建设 TypeScript sidecar，也不以追齐 Pi 的完整 coding-agent 功能为目标。固定求职流程和正式业务状态继续由确定性服务与状态机负责，主 Agent 运行时只协调对话、Skill、Operation、托管执行会话和人工确认。选择这一边界是为了获得可测试、可替换的 Agent loop，同时避免第二业务运行时和通用 Agent 框架复制 OfferU 的状态、权限与事实语义。
