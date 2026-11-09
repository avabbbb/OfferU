---
name: statemachine-agent-ask
description: 改 Agent 向用户提问（input request、回答、消费、过期，lib/agentAsk.ts）前读。状态机、CAS 守卫、已知问题、怎么验证。
---

# Agent Ask

状态：pending -> answered -> consumed（写 consumed_at）；pending -> expired（backend/app/services/agent_run_state.py:825,949-956,983-990,1015）。

| 事件 | 谁触发 | 转移 |
|---|---|---|
| 提问 | Agent | 无 -> pending |
| 回答 | 用户 | pending -> answered（CAS：where status=pending） |
| 消费 | Agent 下一步 | answered -> consumed |
| 过期 | 后台 / 运行结束 | pending -> expired |

守卫：回答走 CAS；同样的回答重放是幂等的，内容不同是冲突（agent_run_state.py:913-935）。

## 不变式

- 一个问题最多被回答一次、消费一次。
- expired 和 consumed 是终态。

## 已知问题

1. agent-ask#1 前端类型允许 cancelled（frontend/src/lib/agentAsk.ts:18），后端没有写入方，看起来不可达；要么删掉，要么在运行取消时真的写。

## 验证

还没有专门的模型测试；相关覆盖在 backend/tests/test_agent_run_event_sequence.py。修 #1 时补一条：运行 cancelled 后未答的问题落到哪个状态。
