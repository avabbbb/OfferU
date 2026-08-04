---
status: accepted
---

# Harness Agent 降为主 Agent Guardian

现有 Harness 中的阶段判断、异常检测、主动提醒和记忆候选提取保留为统一主 Agent 运行时的确定性前后置 Guardian，但 Harness 不再维护独立意图路由、工具注册表、工具循环、对话入口或业务写路径。GUI 和其他入口只连接统一主 Agent 运行时，Guardian 产生的提醒和候选观察通过同一会话事件与事实门呈现。选择这一方式是为了复用已有确定性保护能力，同时消除 Harness 与 LLM Agent 两套会话、记忆和工具语义的分裂。
