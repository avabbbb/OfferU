---
status: accepted
---

# 结构化 Skill Registry 是唯一技能事实源

OfferU 以版本化的结构化 Skill Registry 定义 Skill 身份、路由信息、适用目标、允许的 Operation 和确认边界，并由它生成主 Agent 的技能目录、GUI/TUI 斜杠入口以及 Codex、Claude Code、Copilot 等外部 Coding Agent 的薄 Skill 或 agent 文件。外部 Markdown 只承载对应宿主所需的引导与实时能力发现方式，不独立声明业务流程或旁路操作。选择这一方式是为了避免内部 Skill、`.agents`、`.claude`、`.codex` 与 `.copilot` 多份定义漂移，同时保留不同宿主格式的兼容性。
