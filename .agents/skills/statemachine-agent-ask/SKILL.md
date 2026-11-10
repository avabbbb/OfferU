---
name: statemachine-agent-ask
description: 改 Agent 向用户提问（input request、回答、消费、过期，lib/agentAsk.ts）前读。状态机、CAS 守卫、已知问题、怎么验证。
---

# Agent Ask

agent_input_requests：status pending -> answered，再写一次 consumed_at（consumed）；pending -> expired（也是 status 值）。定义 backend/app/services/agent_run_state.py:726-847,884-1025；视图 _input_request_view:624。

| 事件 | 谁触发 | 转移 | 代码 |
|---|---|---|---|
| 提问 | Agent | 无 -> pending | create_agent_input_request 726-847；每个 Run 最多一个 pending，同参数重放幂等、不同参数拒绝 793-821；终态 Run 直接拒绝 789-792 |
| 回答 | 用户（POST /api/agent/runtime/runs/{run_id}/input-requests/{request_id}/answer） | pending -> answered（CAS：where status=pending） | answer_agent_input_request 884-972，CAS 945-961；路由 routes/main_agent.py:420-450 |
| 回答重放 | 客户端重试 | answered 不变：同内容幂等，内容不同 conflict | 913-934 |
| 消费 | Agent 下一步（回答后立刻续跑） | answered -> consumed（写 consumed_at） | consume_agent_input_request 975-993 |
| 过期 | 本轮失败 / 取消（还没走到 completed 时） | pending -> expired | expire_pending_agent_input_requests 996-1025；调用 embedded_agent_host.py:923（run_cancelled）、156（run_failed） |

守卫：回答走 CAS（945-961），并先按 selection_mode / min / max / free_text 校验答案（validate_agent_input_answer 678-724）；消费也走 CAS（985-990），所以同一个回答只触发一次续跑（embedded_agent_host.py:792-796）。

## 不变式

- 一个问题最多被回答一次、消费一次。
- consumed 不是 status 值，是 consumed_at 非空；expired 是 status 值。expired 和 consumed 是终态。
- 一个 Run 同时只有一个 pending 提问；终态 Run 不能再提问（789-792）。
- 回答不是授权：回答只会续跑，不碰受保护的 Operation（embedded_agent_host.py:736-743）。
- 提问后本轮就结束：Run status=completed、final_result.terminal_state=waiting_user、requires_input=true（embedded_agent_host.py:592-622）；所以回答触发的续跑用 continuation=True，允许从 completed 续。

## 已知问题

1. agent-ask#1 前端类型允许 cancelled（frontend/src/lib/agentAsk.ts:18），后端没有写入方：运行取消时待答问题落成 expired，reason=run_cancelled（embedded_agent_host.py:923；快照在 899-944）。要么删掉前端的 cancelled，要么取消时真的写 cancelled。
2. agent-ask#2 已经 completed 的 Run 上遗留的 pending Ask 没有过期路径：abort 对终态直接返回（embedded_agent_host.py:907-908），失败路径也不会再走到 _fail_run；没人回答就一直挂着，只能靠用户回答消费。

## 验证

还没有专门的模型测试（answer / consume / expire 都没有覆盖）。相邻覆盖只有 backend/tests/test_agent_run_event_sequence.py（事件序号，不涉及 ask）：

```
cd backend
.venv/Scripts/python.exe -m pytest tests/test_agent_run_event_sequence.py -q
```

修 #1 时补一条：运行 cancelled 后未答的问题落到哪个状态（现在是 expired）。
