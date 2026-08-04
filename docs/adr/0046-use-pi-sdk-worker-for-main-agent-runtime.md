---
status: accepted
---

# 使用 Pi SDK Worker 承载主 Agent 运行时

OfferU 使用由 Python 业务后端管理的本地 Node.js Worker，并在其中嵌入 `@earendil-works/pi-coding-agent` SDK，复用 AgentSession、模型适配、上下文压缩、Skill 装载、类型化工具和流式生命周期事件。每个 OfferU Agent Run 恰好绑定一个不跨 Run 复用的 Pi Session；Agent Run、待确认动作、Operation 审计和领域事实仍以 Python 后端为唯一权威，Pi Session 只是可丢弃、可重建的执行上下文。Worker 必须关闭 Pi 内置工具，只接收当前 Run 的 Operation 能力投影，并使用 OfferU 注入的临时模型凭据。选择这一边界是为了停止维护自研 Agent loop，同时避免 Pi Worker 成为第二业务后端或绕过 OfferU 的确认、幂等、数据授权和事实门。

## Consequences

- OfferU 需要固定并打包兼容的 Node.js 与 Pi SDK 版本，独立探测 Worker 能力和协议版本。
- Python 通过严格的本地进程协议管理 Worker；Worker 断开、Session 丢失或版本不兼容必须显式失败或进入恢复状态。
- Pi 的 Session 文件、全局凭据目录、内置 Bash/文件工具、跨 Run 分支和隐藏长期记忆都不是 OfferU 的产品状态或能力边界。
