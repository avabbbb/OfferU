---
status: accepted
---

# GUI、CLI、TUI 与斜杠 Skill 共用一个 Operation Registry

OfferU 建设统一控制台，但不建设第二套业务内核。GUI、稳定的 `offeru` 机器 CLI、`offeru tui` 操作员界面以及主 Agent 对话框/TUI 中的斜杠 Skill 命令，都必须作为同一 Python Operation Registry 的薄适配器，共享参数 schema、权限、dry-run、确认提案、云端数据授权、审计、幂等和错误语义。

斜杠命令从版本化 Skill Registry 自动生成：`/offeru` 打开技能菜单，`/skill-id` 或声明的 alias 直接进入具体 Skill，两种入口解析到同一 Skill ID。系统不维护独立手写命令表，不执行任意 shell，也不创建隐藏业务操作。TUI 只读取领域事实并通过 Operation Registry 发起操作，不拥有独立数据库或写路径。本地 Codex、Claude 等 Coding Agent 使用机器 CLI 契约工作，不能通过 TUI 或 Skill 绕过 OfferU 主 Agent 的事实门和使用者确认。
