---
status: accepted
---

# OfferU 托管可替换的本地深度执行会话

OfferU 主 Agent 负责发起、恢复、流式呈现、取消和审批本地深度执行器的会话，并通过可替换适配器使用 Codex、Claude Code 等执行能力；主要产品路径不要求使用者离开 OfferU 手动启动外部 Coding Agent。托管执行会话只能通过统一 Operation Registry 执行已授权操作，其结果仍须经过事实门和使用者确认；手动 CLI 是统一控制台的兼容入口，不拥有独立会话或业务控制权。选择这一边界是为了保留外部 Coding Agent 的重任务能力，同时让 OfferU 持有一致的任务状态、权限、审计和产品体验。
