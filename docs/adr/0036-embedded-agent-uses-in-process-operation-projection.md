---
status: accepted
---

# 内置 Agent Core 使用进程内 Operation 投影

OfferU 主 Agent 的内置 Core 直接使用由统一 Operation Registry 生成的进程内工具投影；CLI 与 MCP 是供外部 Coding Agent 和其他进程使用的传输适配器，而不是内置 Core 调用自身业务能力的必经路径。三种入口必须共享同一 Operation schema、权限、dry-run、确认、数据授权、审计、幂等和错误语义，但不强求共享序列化或进程边界。选择这一方式是为了避免内置 Core 通过自身 CLI/MCP 产生额外故障点和重复治理，同时保持外部 Agent 的协议兼容性。
