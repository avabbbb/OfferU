---
status: accepted
---

# 托管 Coding Agent 使用原生协议适配器

Codex 与 Claude Code 的正式托管分别使用其官方 SDK、App Server 或 Agent SDK 等原生会话协议，再由执行器适配器归一为 OfferU 的托管执行会话、事件、审批、取消和恢复契约；通用 CLI subprocess 仅用于能力探测、一次性兼容执行或明确不支持托管协议的执行器。OfferU 不用一组永久固定 argv 模拟所有 Provider 的会话能力，也不要求所有 Provider 都暴露为 MCP Server。选择原生适配器是为了保留各执行器的恢复、流式事件和权限交互能力，同时把 Provider 差异隔离在无业务逻辑的边界内。
