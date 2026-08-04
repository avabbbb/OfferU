---
status: accepted
---

# 主 Agent 工具协议按模型能力显式分型

每个模型适配器必须在 Agent Run 开始前声明并通过探测确认使用原生 tool calling 或受约束的 structured-actions 协议，两种协议都转换为同一套经过 Operation schema 校验的内部 ToolCall 和事件。一个 Run 内协议保持固定；解析失败或能力不满足时显式失败，不在原生工具、JSON 文本和普通回答之间静默降级。选择能力分型而不是原生工具限定，是为了继续支持能力不同的本地与 OpenAI-compatible Provider，同时让工具执行保持类型化和可审计。
